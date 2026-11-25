//! The emulator's gRPC control service, spoken directly over HTTP/2.
//!
//! The app draws Android itself. The emulator runs without a window of its own (`-qt-hide-window`)
//! and serves its screen and its input over the gRPC service in `emulator_controller.proto`, which
//! ships in the SDK's `emulator/lib`: `streamScreenshot` delivers a frame each time the display
//! changes, and `sendMouse`, `sendKey` and `injectWheel` carry input back. It is the same protocol
//! Android Studio's embedded emulator uses.
//!
//! Only the handful of messages the app needs are encoded here, by hand. Their protobuf wire form
//! is a few varints and byte strings, which costs less than a code generator, its build step and a
//! gRPC framework. HTTP/2 itself is `h2`, already in the build for the downloads.

use bytes::{Buf, BufMut, Bytes, BytesMut};
use h2::client::SendRequest;
use http::Request;

use crate::{err, Result};

const SERVICE: &str = "/android.emulation.control.EmulatorController/";

/// `ImageFormat.ImgFormat.RGBA8888`.
const RGBA8888: u64 = 1;

/// `KeyboardEvent.KeyEventType`: a key going down, coming up, or both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Down = 0,
    Up = 1,
    Press = 2,
}

/// One frame of the guest's display, as tightly packed RGBA8888 rows.
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Bytes,
    /// The emulator's own frame counter: a gap means frames were dropped on the way.
    pub seq: u32,
}

/// `sendMouse`'s buttons: the primary one is a finger on the screen.
pub const BUTTON_PRIMARY: i32 = 1;

/// A connection to one emulator's gRPC port. Cheap to clone; clones share the connection.
#[derive(Clone)]
pub struct EmulatorGrpc {
    send: SendRequest<Bytes>,
    port: u16,
    token: Option<String>,
}

impl EmulatorGrpc {
    /// Connects to `127.0.0.1:port`. `token`, when given, goes out as the bearer token that
    /// `-grpc-use-token` asks for.
    pub async fn connect(port: u16, token: Option<String>) -> Result<EmulatorGrpc> {
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|error| err!("could not reach the emulator's gRPC port {port}: {error}"))?;
        let _ = tcp.set_nodelay(true);
        // Frames are megabytes; HTTP/2's default 64 KB window would pace them by round trips.
        let (send, connection) = h2::client::Builder::new()
            .initial_window_size(8 << 20)
            .initial_connection_window_size(16 << 20)
            .handshake::<_, Bytes>(tcp)
            .await
            .map_err(|error| err!("the emulator's gRPC port did not answer as HTTP/2: {error}"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(EmulatorGrpc { send, port, token })
    }

    fn request(&self, method: &str) -> Result<Request<()>> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{}{SERVICE}{method}", self.port))
            .header("content-type", "application/grpc")
            .header("te", "trailers");
        if let Some(token) = &self.token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder.body(()).map_err(|error| err!("{error}"))
    }

    /// Starts a call, sends its one request message, and returns the reply's body.
    async fn start(&self, method: &str, message: Bytes) -> Result<h2::RecvStream> {
        let mut send = self.send.clone().ready().await.map_err(|error| err!("the emulator's gRPC connection closed: {error}"))?;
        let (response, mut body) = send.send_request(self.request(method)?, false).map_err(|error| err!("{method}: {error}"))?;
        body.send_data(grpc_frame(&message), true).map_err(|error| err!("{method}: {error}"))?;
        let response = response.await.map_err(|error| err!("{method}: {error}"))?;
        let (parts, recv) = response.into_parts();
        if parts.status != http::StatusCode::OK {
            return Err(err!("{method}: the emulator answered HTTP {}", parts.status));
        }
        // A reply that is only trailers carries its error in the headers.
        check_status(method, &parts.headers)?;
        Ok(recv)
    }

    /// A call with one request and one reply, where the reply carries nothing the app needs.
    async fn unary(&self, method: &str, message: Bytes) -> Result<()> {
        let mut body = self.start(method, message).await?;
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|error| err!("{method}: {error}"))?;
            let _ = body.flow_control().release_capacity(chunk.len());
        }
        match body.trailers().await.map_err(|error| err!("{method}: {error}"))? {
            Some(trailers) => check_status(method, &trailers),
            None => Ok(()),
        }
    }

    /// A key by its W3C name: `GoHome`, `GoBack`, `AppSwitch`, `Power`, `AudioVolumeUp`,
    /// `Backspace`, `Enter`, `ArrowLeft`, or a single printable ASCII character.
    pub async fn send_key(&self, key: &str, action: KeyAction) -> Result<()> {
        self.unary("sendKey", keyboard_key(key, action)).await
    }

    /// Text typed as key presses. Printable ASCII, `\n` and `\t` only: the emulator drops the rest.
    pub async fn send_text(&self, text: &str) -> Result<()> {
        self.unary("sendKey", keyboard_text(text)).await
    }

    /// The pointer at `(x, y)` in display pixels, with `buttons` held: a touch while the primary
    /// button is down, a hover otherwise.
    pub async fn send_mouse(&self, x: i32, y: i32, buttons: i32) -> Result<()> {
        self.unary("sendMouse", mouse_event(x, y, buttons)).await
    }

    /// A mouse wheel turn: 120 units is one click. Positive `dy` scrolls up.
    pub async fn send_wheel(&self, dy: i32) -> Result<()> {
        self.unary("injectWheel", wheel_event(0, dy)).await
    }

    /// One frame of the display, now, whether or not anything has changed: the stream below only
    /// speaks when the screen does.
    pub async fn screenshot(&self) -> Result<Frame> {
        let mut body = self.start("getScreenshot", image_format(0, 0)).await?;
        let mut buffer = BytesMut::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|error| err!("getScreenshot: {error}"))?;
            let _ = body.flow_control().release_capacity(chunk.len());
            buffer.extend_from_slice(&chunk);
            if let Some(message) = take_message(&mut buffer)? {
                return parse_image(&message).ok_or_else(|| err!("getScreenshot: the emulator sent no picture"));
            }
        }
        Err(err!("getScreenshot: the emulator closed the call without a picture"))
    }

    /// Streams the display, scaled by the emulator to fit `width` x `height` (0 x 0 for its own
    /// size). `on_frame` sees every frame and returns false to stop.
    pub async fn stream_screenshots(&self, width: u32, height: u32, mut on_frame: impl FnMut(Frame) -> bool) -> Result<()> {
        let mut body = self.start("streamScreenshot", image_format(width, height)).await?;
        let mut buffer = BytesMut::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|error| err!("streamScreenshot: {error}"))?;
            let _ = body.flow_control().release_capacity(chunk.len());
            buffer.extend_from_slice(&chunk);
            while let Some(message) = take_message(&mut buffer)? {
                if let Some(frame) = parse_image(&message) {
                    if !on_frame(frame) {
                        return Ok(());
                    }
                }
            }
        }
        match body.trailers().await.map_err(|error| err!("streamScreenshot: {error}"))? {
            Some(trailers) => check_status("streamScreenshot", &trailers),
            None => Ok(()),
        }
    }
}

/// The token `-grpc-use-token` checks: the console's, from `%USERPROFILE%\.emulator_console_auth_token`.
pub fn console_token() -> Option<String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let token = std::fs::read_to_string(std::path::Path::new(&home).join(".emulator_console_auth_token")).ok()?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

/// Where a running emulator says it can be reached: the discovery file every instance writes, in
/// `%LOCALAPPDATA%\Temp\avd\running\pid_<pid>.ini`, with `grpc.port` and `grpc.token` among its
/// keys. The authoritative source: the console token file can be replaced under a running emulator.
/// `avd_name` matches as a prefix, so `OpenEmulator_` finds whichever of the app's AVDs is running.
pub fn discover(avd_name: &str, emulator_home: Option<&std::path::Path>) -> Option<(u16, Option<String>)> {
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).or_else(|| Some(std::env::temp_dir().parent()?.to_path_buf()))?;
    // With ANDROID_EMULATOR_HOME set, the emulator writes it under that folder instead.
    let mut dirs = vec![local.join("Temp").join("avd").join("running"), std::env::temp_dir().join("avd").join("running")];
    if let Some(home) = emulator_home {
        dirs.insert(0, home.join("avd").join("running"));
        dirs.insert(1, home.join("running"));
    }
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            if let Some(found) = parse_discovery(&text, avd_name) {
                return Some(found);
            }
        }
    }
    None
}

fn parse_discovery(text: &str, avd_name: &str) -> Option<(u16, Option<String>)> {
    let value = |key: &str| text.lines().find_map(|line| line.trim().strip_prefix(key)?.strip_prefix('=').map(str::trim));
    if !value("avd.name")?.starts_with(avd_name) {
        return None;
    }
    let port = value("grpc.port")?.parse().ok()?;
    Some((port, value("grpc.token").filter(|token| !token.is_empty()).map(str::to_owned)))
}

/// A local TCP port nothing is listening on right now, for the emulator's gRPC service.
pub fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?.local_addr().ok().map(|address| address.port())
}

fn check_status(method: &str, headers: &http::HeaderMap) -> Result<()> {
    match headers.get("grpc-status").and_then(|value| value.to_str().ok()) {
        None | Some("0") => Ok(()),
        Some(code) => {
            let message = headers.get("grpc-message").and_then(|value| value.to_str().ok()).unwrap_or("");
            Err(err!("the emulator refused {method} (gRPC status {code}) {message}"))
        }
    }
}

/// gRPC's length-prefixed message framing: no compression flag, then a big-endian length.
fn grpc_frame(message: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(5 + message.len());
    out.put_u8(0);
    out.put_u32(message.len() as u32);
    out.extend_from_slice(message);
    out.freeze()
}

/// The next whole message in `buffer`, if it has arrived.
fn take_message(buffer: &mut BytesMut) -> Result<Option<Bytes>> {
    if buffer.len() < 5 {
        return Ok(None);
    }
    if buffer[0] != 0 {
        return Err(err!("the emulator sent a compressed gRPC message, which was never asked for"));
    }
    let len = u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]]) as usize;
    if buffer.len() < 5 + len {
        return Ok(None);
    }
    buffer.advance(5);
    Ok(Some(buffer.split_to(len).freeze()))
}

// Protobuf, as much of it as these messages use. Proto3 leaves zero values out.

fn put_varint(out: &mut BytesMut, mut value: u64) {
    while value >= 0x80 {
        out.put_u8((value as u8) | 0x80);
        value >>= 7;
    }
    out.put_u8(value as u8);
}

fn put_key(out: &mut BytesMut, field: u32, wire_type: u32) {
    put_varint(out, u64::from((field << 3) | wire_type));
}

fn put_uint(out: &mut BytesMut, field: u32, value: u64) {
    if value != 0 {
        put_key(out, field, 0);
        put_varint(out, value);
    }
}

fn put_int32(out: &mut BytesMut, field: u32, value: i32) {
    if value != 0 {
        put_key(out, field, 0);
        // Negative int32s are sign-extended to ten bytes, as the wire format says.
        put_varint(out, i64::from(value) as u64);
    }
}

fn put_string(out: &mut BytesMut, field: u32, value: &str) {
    if !value.is_empty() {
        put_key(out, field, 2);
        put_varint(out, value.len() as u64);
        out.extend_from_slice(value.as_bytes());
    }
}

fn image_format(width: u32, height: u32) -> Bytes {
    let mut out = BytesMut::new();
    put_uint(&mut out, 1, RGBA8888);
    put_uint(&mut out, 3, u64::from(width));
    put_uint(&mut out, 4, u64::from(height));
    out.freeze()
}

fn mouse_event(x: i32, y: i32, buttons: i32) -> Bytes {
    let mut out = BytesMut::new();
    put_int32(&mut out, 1, x);
    put_int32(&mut out, 2, y);
    put_int32(&mut out, 3, buttons);
    out.freeze()
}

fn keyboard_key(key: &str, action: KeyAction) -> Bytes {
    let mut out = BytesMut::new();
    put_uint(&mut out, 2, action as u64);
    put_string(&mut out, 4, key);
    out.freeze()
}

fn keyboard_text(text: &str) -> Bytes {
    let mut out = BytesMut::new();
    put_string(&mut out, 5, text);
    out.freeze()
}

fn wheel_event(dx: i32, dy: i32) -> Bytes {
    let mut out = BytesMut::new();
    put_int32(&mut out, 1, dx);
    put_int32(&mut out, 2, dy);
    out.freeze()
}

enum Value {
    Varint(u64),
    Bytes(Bytes),
    Fixed,
}

/// Walks a message's fields. Stops quietly at anything malformed.
struct Fields {
    data: Bytes,
    pos: usize,
}

impl Fields {
    fn new(data: &Bytes) -> Fields {
        Fields { data: data.clone(), pos: 0 }
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.data.get(self.pos)?;
            self.pos += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }
}

impl Iterator for Fields {
    type Item = (u32, Value);

    fn next(&mut self) -> Option<(u32, Value)> {
        if self.pos >= self.data.len() {
            return None;
        }
        let key = self.varint()?;
        let field = (key >> 3) as u32;
        let value = match key & 7 {
            0 => Value::Varint(self.varint()?),
            1 => {
                self.pos = self.pos.checked_add(8).filter(|&end| end <= self.data.len())?;
                Value::Fixed
            }
            2 => {
                let len = usize::try_from(self.varint()?).ok()?;
                let end = self.pos.checked_add(len).filter(|&end| end <= self.data.len())?;
                let bytes = self.data.slice(self.pos..end);
                self.pos = end;
                Value::Bytes(bytes)
            }
            5 => {
                self.pos = self.pos.checked_add(4).filter(|&end| end <= self.data.len())?;
                Value::Fixed
            }
            _ => return None,
        };
        Some((field, value))
    }
}

/// An `Image` message as a frame. Pixels are passed on without a copy.
fn parse_image(message: &Bytes) -> Option<Frame> {
    let (mut width, mut height, mut seq, mut pixels) = (0u64, 0u64, 0u64, None);
    for (field, value) in Fields::new(message) {
        match (field, value) {
            (1, Value::Bytes(format)) => {
                for (field, value) in Fields::new(&format) {
                    match (field, value) {
                        (3, Value::Varint(w)) => width = w,
                        (4, Value::Varint(h)) => height = h,
                        _ => {}
                    }
                }
            }
            // The deprecated copies, for an emulator that only fills those.
            (2, Value::Varint(w)) if width == 0 => width = w,
            (3, Value::Varint(h)) if height == 0 => height = h,
            (4, Value::Bytes(bytes)) => pixels = Some(bytes),
            (5, Value::Varint(s)) => seq = s,
            _ => {}
        }
    }
    let (width, height) = (u32::try_from(width).ok()?, u32::try_from(height).ok()?);
    let pixels = pixels?;
    let count = width as usize * height as usize;
    if count == 0 {
        return None;
    }
    let rgba = if pixels.len() == count * 4 {
        pixels
    } else if pixels.len() == count * 3 {
        // RGB888, should an emulator answer with its own default: widened rather than refused.
        let mut out = BytesMut::with_capacity(count * 4);
        for rgb in pixels.chunks_exact(3) {
            out.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 0xff]);
        }
        out.freeze()
    } else {
        return None;
    };
    Some(Frame { width, height, rgba, seq: seq as u32 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_encode_as_the_proto_says() {
        // MouseEvent { x: 300, y: 1, buttons: 1 }: field 1 varint 300 is 08 ac 02.
        assert_eq!(&mouse_event(300, 1, BUTTON_PRIMARY)[..], &[0x08, 0xac, 0x02, 0x10, 0x01, 0x18, 0x01]);
        // Zero values are left out entirely.
        assert_eq!(&mouse_event(0, 0, 0)[..], &[] as &[u8]);
        // KeyboardEvent { eventType: keypress, key: "GoHome" }.
        let key = keyboard_key("GoHome", KeyAction::Press);
        assert_eq!(&key[..4], &[0x10, 0x02, 0x22, 0x06]);
        assert_eq!(&key[4..], b"GoHome");
        // A negative wheel delta is a ten-byte varint.
        assert_eq!(wheel_event(0, -120).len(), 1 + 10);
        // ImageFormat { format: RGBA8888, width: 360, height: 640 }.
        assert_eq!(&image_format(360, 640)[..], &[0x08, 0x01, 0x18, 0xe8, 0x02, 0x20, 0x80, 0x05]);
    }

    #[test]
    fn a_frame_survives_grpc_framing_split_across_chunks() {
        let mut format = BytesMut::new();
        put_uint(&mut format, 1, RGBA8888);
        put_uint(&mut format, 3, 2);
        put_uint(&mut format, 4, 1);
        let mut image = BytesMut::new();
        put_key(&mut image, 1, 2);
        put_varint(&mut image, format.len() as u64);
        image.extend_from_slice(&format);
        put_key(&mut image, 4, 2);
        put_varint(&mut image, 8);
        image.extend_from_slice(&[1, 2, 3, 255, 4, 5, 6, 255]);
        put_uint(&mut image, 5, 42);
        let framed = grpc_frame(&image);

        let mut buffer = BytesMut::new();
        buffer.extend_from_slice(&framed[..7]);
        assert!(take_message(&mut buffer).unwrap().is_none(), "half a message is not a message");
        buffer.extend_from_slice(&framed[7..]);
        let message = take_message(&mut buffer).unwrap().expect("whole now");
        assert!(buffer.is_empty());
        let frame = parse_image(&message).expect("a frame");
        assert_eq!((frame.width, frame.height, frame.seq), (2, 1, 42));
        assert_eq!(&frame.rgba[..], &[1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn the_discovery_file_names_the_port_and_token_for_its_own_avd_only() {
        let text = "port.serial=5554\nport.adb=5555\navd.name=OpenEmulator_API30_openemu\ngrpc.port=8554\ngrpc.token=abc123\n";
        assert_eq!(parse_discovery(text, "OpenEmulator_API30_openemu"), Some((8554, Some("abc123".into()))));
        assert_eq!(parse_discovery(text, "Pixel_7"), None, "another emulator's file");
        assert_eq!(parse_discovery("avd.name=A\ngrpc.port=9000\n", "A"), Some((9000, None)), "no token: none sent");
    }

    #[test]
    fn rgb888_is_widened_and_a_short_image_is_refused() {
        let mut image = BytesMut::new();
        put_uint(&mut image, 2, 1);
        put_uint(&mut image, 3, 1);
        put_key(&mut image, 4, 2);
        put_varint(&mut image, 3);
        image.extend_from_slice(&[9, 8, 7]);
        let frame = parse_image(&image.freeze()).expect("one RGB pixel");
        assert_eq!(&frame.rgba[..], &[9, 8, 7, 255]);

        let mut short = BytesMut::new();
        put_uint(&mut short, 2, 4);
        put_uint(&mut short, 3, 4);
        put_key(&mut short, 4, 2);
        put_varint(&mut short, 3);
        short.extend_from_slice(&[0, 0, 0]);
        assert!(parse_image(&short.freeze()).is_none());
    }
}
