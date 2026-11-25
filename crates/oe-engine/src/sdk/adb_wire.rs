//! adb's own wire protocol, spoken straight to the adb server on `127.0.0.1:5037`.
//!
//! Every `adb.exe shell …` costs a process start on Windows (tens of milliseconds before the
//! command has even reached the server) and every status poll, tap, and property read paid it.
//! The server already listens on a socket and speaks a small protocol; this speaks it directly.
//! `adb.exe` is still what starts the server, and what installs and pushes, which it streams with
//! logic of its own.
//!
//! The protocol: a request is its length as four hex digits, then the text. The reply is `OKAY`, or
//! `FAIL` followed by a hex-length message. `host:transport:<serial>` turns the connection into one
//! to that device, and the next request is a service on it: `shell,v2,raw:` frames output into
//! stdout, stderr, and exit-code packets; `exec:` is raw bytes until the connection closes.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use crate::LogStream;

pub const DEFAULT_SERVER_PORT: u16 = 5037;

/// Packet ids of the shell protocol (`shell,v2`).
const STDIN: u8 = 0;
const STDOUT: u8 = 1;
const STDERR: u8 = 2;
const EXIT: u8 = 3;
const CLOSE_STDIN: u8 = 4;

/// The most a single shell packet may claim to carry before the stream is treated as garbage.
const MAX_PACKET: usize = 16 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// Nothing is listening: the server is not running. `adb.exe` starts it.
    NoServer(String),
    /// The server or the device said no; the message is adb's own ("device offline", …).
    Refused(String),
    /// The connection broke, or the reply made no sense.
    Broken(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::NoServer(reason) => write!(f, "the adb server is not running ({reason})"),
            WireError::Refused(message) => write!(f, "adb: {message}"),
            WireError::Broken(reason) => write!(f, "the adb connection failed: {reason}"),
        }
    }
}

fn broken(error: std::io::Error) -> WireError {
    WireError::Broken(error.to_string())
}

/// The port the adb server listens on: `ANDROID_ADB_SERVER_PORT` if set, as `adb.exe` honours it.
pub fn server_port() -> u16 {
    std::env::var("ANDROID_ADB_SERVER_PORT").ok().and_then(|port| port.parse().ok()).unwrap_or(DEFAULT_SERVER_PORT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdbWire {
    port: u16,
}

impl AdbWire {
    pub fn new(port: u16) -> AdbWire {
        AdbWire { port }
    }

    async fn connect(&self) -> Result<TcpStream, WireError> {
        let stream = TcpStream::connect(("127.0.0.1", self.port)).await.map_err(|error| WireError::NoServer(error.to_string()))?;
        // Taps are a few bytes each; Nagle would hold them back waiting for more.
        let _ = stream.set_nodelay(true);
        Ok(stream)
    }

    /// The serials in the `device` state, as `adb devices` lists them.
    pub async fn devices(&self) -> Result<Vec<String>, WireError> {
        let mut stream = self.connect().await?;
        request(&mut stream, "host:devices").await?;
        let listing = read_hex_prefixed(&mut stream).await?;
        let lines: Vec<String> = listing.lines().map(str::to_owned).collect();
        Ok(super::adb::parse_devices(&lines))
    }

    /// A connection to one service on one device.
    async fn open(&self, serial: &str, service: &str) -> Result<TcpStream, WireError> {
        let mut stream = self.connect().await?;
        request(&mut stream, &format!("host:transport:{serial}")).await?;
        request(&mut stream, service).await?;
        Ok(stream)
    }

    /// Runs a command in the guest's `sh`, handing each chunk of output to `on_output` as it
    /// arrives. The exit code, or `None` if the guest closed the connection without one.
    pub async fn shell(&self, serial: &str, command: &str, mut on_output: impl FnMut(LogStream, &[u8])) -> Result<Option<i32>, WireError> {
        let mut stream = self.open(serial, &format!("shell,v2,raw:{command}")).await?;
        // Nothing is typed into it: closing stdin at once lets a command that reads it see the end
        // rather than wait forever, which is what `adb.exe` with no stdin did.
        write_packet(&mut stream, CLOSE_STDIN, &[]).await?;
        while let Some((id, data)) = read_packet(&mut stream).await? {
            match id {
                STDOUT => on_output(LogStream::Stdout, &data),
                STDERR => on_output(LogStream::Stderr, &data),
                EXIT => return Ok(Some(data.first().map_or(0, |&code| i32::from(code)))),
                _ => {}
            }
        }
        Ok(None)
    }

    /// `exec:`: the command's stdout as raw bytes, untouched by any line handling. What a
    /// screenshot needs: a `0x0a` inside PNG data is not a line break.
    pub async fn exec_out(&self, serial: &str, command: &str) -> Result<Vec<u8>, WireError> {
        let mut stream = self.open(serial, &format!("exec:{command}")).await?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.map_err(broken)?;
        Ok(bytes)
    }

    /// A shell that stays open, for commands written into it one after another: input events,
    /// mostly, which would otherwise each pay for a connection of their own.
    pub async fn open_shell(&self, serial: &str) -> Result<ShellSession, WireError> {
        let stream = self.open(serial, "shell,v2,raw:").await?;
        let (mut reader, writer) = stream.into_split();
        // Drained continuously: a guest whose output nobody reads blocks on a full pipe.
        let drain = tokio::spawn(async move { while let Ok(Some(_)) = read_packet(&mut reader).await {} });
        Ok(ShellSession { writer, drain })
    }
}

/// A guest shell left open. Each [`ShellSession::send`] is one line typed into it.
pub struct ShellSession {
    writer: OwnedWriteHalf,
    drain: JoinHandle<()>,
}

impl ShellSession {
    /// Writes one command line. It runs after whatever was sent before it has finished.
    pub async fn send(&mut self, command: &str) -> Result<(), WireError> {
        let mut line = command.as_bytes().to_vec();
        line.push(b'\n');
        write_packet(&mut self.writer, STDIN, &line).await
    }

    /// False once the guest has closed the shell: the guest stopped, or the server restarted.
    pub fn is_open(&self) -> bool {
        !self.drain.is_finished()
    }
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        self.drain.abort();
    }
}

async fn request(stream: &mut (impl AsyncRead + AsyncWrite + Unpin), service: &str) -> Result<(), WireError> {
    if service.len() > 0xffff {
        return Err(WireError::Broken("request too long".into()));
    }
    let mut message = format!("{:04x}", service.len()).into_bytes();
    message.extend_from_slice(service.as_bytes());
    stream.write_all(&message).await.map_err(broken)?;
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await.map_err(broken)?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => Err(WireError::Refused(read_hex_prefixed(stream).await.unwrap_or_else(|_| "request refused".into()))),
        other => Err(WireError::Broken(format!("unexpected reply {:?}", String::from_utf8_lossy(other)))),
    }
}

async fn read_hex_prefixed(stream: &mut (impl AsyncRead + Unpin)) -> Result<String, WireError> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.map_err(broken)?;
    let length = std::str::from_utf8(&length)
        .ok()
        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
        .ok_or_else(|| WireError::Broken("unreadable length".into()))?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.map_err(broken)?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn write_packet(stream: &mut (impl AsyncWrite + Unpin), id: u8, data: &[u8]) -> Result<(), WireError> {
    let length = u32::try_from(data.len()).map_err(|_| WireError::Broken("packet too large".into()))?;
    let mut packet = Vec::with_capacity(5 + data.len());
    packet.push(id);
    packet.extend_from_slice(&length.to_le_bytes());
    packet.extend_from_slice(data);
    stream.write_all(&packet).await.map_err(broken)
}

/// One shell packet, or `None` at a clean end of stream.
async fn read_packet(stream: &mut (impl AsyncRead + Unpin)) -> Result<Option<(u8, Vec<u8>)>, WireError> {
    let mut header = [0u8; 5];
    match stream.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(broken(error)),
    }
    let length = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if length > MAX_PACKET {
        return Err(WireError::Broken(format!("a shell packet claimed {length} bytes")));
    }
    let mut data = vec![0u8; length];
    stream.read_exact(&mut data).await.map_err(broken)?;
    Ok(Some((header[0], data)))
}

/// How long to wait for a wire call before treating it as hung.
pub(crate) async fn within<T>(timeout: Duration, call: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::time::timeout(timeout, call).await.ok()
}

#[cfg(test)]
pub(crate) mod fake {
    //! A stand-in adb server: enough of the protocol to answer the requests this module makes.

    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    /// What the fake device does with a service request.
    #[derive(Clone)]
    pub enum Reply {
        /// `shell,v2`: these packets, then the connection closes.
        Shell(Vec<(u8, Vec<u8>)>),
        /// `exec:`: these bytes, then the connection closes.
        Raw(Vec<u8>),
        Fail(String),
    }

    pub struct FakeServer {
        pub port: u16,
        /// Every request the server received, in order, transports included.
        pub requests: Arc<Mutex<Vec<String>>>,
        /// What was typed into shells: the stdin packets' bytes.
        pub stdin: Arc<Mutex<Vec<u8>>>,
    }

    async fn read_request(stream: &mut TcpStream) -> Option<String> {
        let mut length = [0u8; 4];
        stream.read_exact(&mut length).await.ok()?;
        let length = usize::from_str_radix(std::str::from_utf8(&length).ok()?, 16).ok()?;
        let mut body = vec![0u8; length];
        stream.read_exact(&mut body).await.ok()?;
        String::from_utf8(body).ok()
    }

    async fn fail(stream: &mut TcpStream, message: &str) {
        let _ = stream.write_all(format!("FAIL{:04x}{message}", message.len()).as_bytes()).await;
    }

    /// Serves `devices` for `host:devices`, and answers device services with `reply(service)`.
    pub async fn serve(devices: &'static str, reply: impl Fn(&str) -> Reply + Send + Sync + 'static) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stdin = Arc::new(Mutex::new(Vec::new()));
        let reply = Arc::new(reply);
        let (seen, typed) = (requests.clone(), stdin.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let (seen, typed, reply) = (seen.clone(), typed.clone(), reply.clone());
                tokio::spawn(async move {
                    let Some(first) = read_request(&mut stream).await else { return };
                    seen.lock().unwrap().push(first.clone());
                    if first == "host:devices" {
                        let _ = stream.write_all(format!("OKAY{:04x}{devices}", devices.len()).as_bytes()).await;
                        return;
                    }
                    let Some(serial) = first.strip_prefix("host:transport:") else { return fail(&mut stream, "unknown host service").await };
                    if !devices.contains(&format!("{serial}\tdevice")) {
                        return fail(&mut stream, &format!("device '{serial}' not found")).await;
                    }
                    let _ = stream.write_all(b"OKAY").await;
                    let Some(service) = read_request(&mut stream).await else { return };
                    seen.lock().unwrap().push(service.clone());
                    match reply(&service) {
                        Reply::Fail(message) => fail(&mut stream, &message).await,
                        Reply::Raw(bytes) => {
                            let _ = stream.write_all(b"OKAY").await;
                            let _ = stream.write_all(&bytes).await;
                        }
                        Reply::Shell(packets) => {
                            let _ = stream.write_all(b"OKAY").await;
                            let (mut reader, mut writer) = stream.into_split();
                            let typed = typed.clone();
                            let reading = tokio::spawn(async move {
                                while let Ok(Some((id, data))) = read_packet(&mut reader).await {
                                    if id == STDIN {
                                        typed.lock().unwrap().extend_from_slice(&data);
                                    }
                                }
                            });
                            for (id, data) in packets {
                                let _ = write_packet(&mut writer, id, &data).await;
                            }
                            if service == "shell,v2,raw:" {
                                // An interactive shell stays open until the client goes.
                                let _ = reading.await;
                            }
                        }
                    }
                });
            }
        });
        FakeServer { port, requests, stdin }
    }

    pub fn stdout(text: &str) -> (u8, Vec<u8>) {
        (STDOUT, text.as_bytes().to_vec())
    }

    pub fn stderr(text: &str) -> (u8, Vec<u8>) {
        (STDERR, text.as_bytes().to_vec())
    }

    pub fn exit(code: u8) -> (u8, Vec<u8>) {
        (EXIT, vec![code])
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    const ONE_DEVICE: &str = "emulator-5554\tdevice\nemulator-5556\toffline\n";

    #[tokio::test]
    async fn devices_lists_only_serials_that_are_ready() {
        let server = serve(ONE_DEVICE, |_| Reply::Fail("unused".into())).await;
        assert_eq!(AdbWire::new(server.port).devices().await.unwrap(), vec!["emulator-5554"]);
    }

    #[tokio::test]
    async fn a_shell_command_keeps_stdout_and_stderr_apart_and_reports_its_exit_code() {
        let server = serve(ONE_DEVICE, |service| {
            assert_eq!(service, "shell,v2,raw:getprop ro.build.version.sdk");
            Reply::Shell(vec![stdout("3"), stdout("0\n"), stderr("warning\n"), exit(7)])
        })
        .await;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = AdbWire::new(server.port)
            .shell("emulator-5554", "getprop ro.build.version.sdk", |stream, data| match stream {
                LogStream::Stdout => out.extend_from_slice(data),
                LogStream::Stderr => err.extend_from_slice(data),
            })
            .await
            .unwrap();
        assert_eq!((code, out.as_slice(), err.as_slice()), (Some(7), b"30\n".as_slice(), b"warning\n".as_slice()));
        assert_eq!(server.requests.lock().unwrap()[0], "host:transport:emulator-5554");
    }

    #[tokio::test]
    async fn exec_output_comes_back_byte_for_byte() {
        let png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0xff];
        let expected = png.clone();
        let server = serve(ONE_DEVICE, move |_| Reply::Raw(png.clone())).await;
        let bytes = AdbWire::new(server.port).exec_out("emulator-5554", "screencap -p").await.unwrap();
        assert_eq!(bytes, expected);
        assert_eq!(server.requests.lock().unwrap()[1], "exec:screencap -p");
    }

    #[tokio::test]
    async fn adbs_own_refusal_is_reported_in_its_words() {
        let server = serve(ONE_DEVICE, |_| Reply::Fail("closed".into())).await;
        let wire = AdbWire::new(server.port);
        assert_eq!(wire.shell("emulator-9999", "true", |_, _| {}).await, Err(WireError::Refused("device 'emulator-9999' not found".into())));
        assert_eq!(wire.shell("emulator-5554", "true", |_, _| {}).await, Err(WireError::Refused("closed".into())));
    }

    #[tokio::test]
    async fn no_server_is_told_apart_from_a_refusal() {
        // Bound and dropped: a port with nothing listening on it.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(matches!(AdbWire::new(port).devices().await, Err(WireError::NoServer(_))));
    }

    #[tokio::test]
    async fn an_open_shell_receives_each_command_as_a_line() {
        let server = serve(ONE_DEVICE, |_| Reply::Shell(Vec::new())).await;
        let mut session = AdbWire::new(server.port).open_shell("emulator-5554").await.unwrap();
        session.send("input tap 10 20").await.unwrap();
        session.send("input keyevent 4").await.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while server.stdin.lock().unwrap().len() < 33 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(String::from_utf8(server.stdin.lock().unwrap().clone()).unwrap(), "input tap 10 20\ninput keyevent 4\n");
        assert!(session.is_open());
    }
}
