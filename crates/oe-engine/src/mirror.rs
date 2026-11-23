//! Mirrors the guest by asking the engine for frames.
//!
//! The fallback for when the emulator's own window cannot be embedded, and the source of stills
//! for screenshots and the Store's Play frame. Polling for PNGs is bounded by however long a
//! capture takes, which is why the window, not this, is how the guest is normally shown.

use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::engine::AndroidEngine;
use crate::{LogHandler, LogStream};

pub const DEFAULT_INTERVAL: Duration = Duration::from_millis(250);

/// A running mirror. Dropping it stops the captures.
pub struct EngineMirror {
    task: JoinHandle<()>,
}

impl EngineMirror {
    /// Captures a frame every `interval` and hands each PNG to `on_frame`.
    ///
    /// A capture slower than the interval is not queued behind: the next tick is skipped, because
    /// a backlog of requests would all return stale frames and the display would drift further
    /// behind the guest the longer it ran.
    pub fn start(
        engine: Arc<dyn AndroidEngine>,
        interval: Duration,
        on_frame: impl Fn(Vec<u8>) + Send + Sync + 'static,
        on_log: LogHandler,
    ) -> EngineMirror {
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(interval);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut failures = 0u32;
            loop {
                ticks.tick().await;
                match engine.screencap().await {
                    // A zero-length capture is normal while the guest is still coming up: there is
                    // nothing to show yet, which is not an error worth reporting.
                    Ok(png) if png.is_empty() => {}
                    Ok(png) => {
                        failures = 0;
                        on_frame(png);
                    }
                    Err(error) => {
                        failures += 1;
                        // Reported once, not every tick: a guest that has gone away would
                        // otherwise fill the log with the same line four times a second.
                        if failures == 1 {
                            on_log(LogStream::Stderr, &format!("screen capture failed: {}", error.0));
                        }
                    }
                }
            }
        });
        EngineMirror { task }
    }

    pub fn is_active(&self) -> bool {
        !self.task.is_finished()
    }

    pub fn stop(&self) {
        self.task.abort();
    }
}

impl Drop for EngineMirror {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::testing::FakeEngine;
    use crate::engine::BoxFuture;
    use crate::{err, CommandResult, Result};

    /// An engine whose captures come from a script, each taking `delay`.
    struct Frames {
        inner: FakeEngine,
        script: Mutex<Vec<Result<Vec<u8>>>>,
        delay: Duration,
        calls: AtomicUsize,
    }

    impl AndroidEngine for Frames {
        fn start(&self, l: LogHandler, c: bool) -> BoxFuture<'_, CommandResult> {
            self.inner.start(l, c)
        }
        fn stop(&self, l: LogHandler) -> BoxFuture<'_, CommandResult> {
            self.inner.stop(l)
        }
        fn status(&self, l: LogHandler) -> BoxFuture<'_, CommandResult> {
            self.inner.status(l)
        }
        fn provision(&self, l: LogHandler) -> BoxFuture<'_, CommandResult> {
            self.inner.provision(l)
        }
        fn doctor(&self, l: LogHandler) -> BoxFuture<'_, CommandResult> {
            self.inner.doctor(l)
        }
        fn shell<'a>(&'a self, c: &'a str, l: LogHandler, t: Duration) -> BoxFuture<'a, CommandResult> {
            self.inner.shell(c, l, t)
        }
        fn quote_guest_arg(&self, v: &str) -> String {
            self.inner.quote_guest_arg(v)
        }
        fn type_secret<'a>(&'a self, v: &'a str, l: LogHandler, t: Duration) -> BoxFuture<'a, CommandResult> {
            self.inner.type_secret(v, l, t)
        }
        fn install_apk<'a>(&'a self, p: &'a str, l: LogHandler, t: Duration) -> BoxFuture<'a, CommandResult> {
            self.inner.install_apk(p, l, t)
        }
        fn install_apks<'a>(&'a self, p: &'a [String], l: LogHandler, t: Duration) -> BoxFuture<'a, CommandResult> {
            self.inner.install_apks(p, l, t)
        }
        fn push_file<'a>(&'a self, h: &'a str, g: &'a str, l: LogHandler, t: Duration) -> BoxFuture<'a, CommandResult> {
            self.inner.push_file(h, g, l, t)
        }
        fn send_input<'a>(&'a self, c: &'a str) -> BoxFuture<'a, bool> {
            self.inner.send_input(c)
        }
        fn display_pid(&self) -> BoxFuture<'_, Option<u32>> {
            self.inner.display_pid()
        }
        fn screencap(&self) -> BoxFuture<'_, Result<Vec<u8>>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let next = {
                let mut script = self.script.lock().unwrap();
                if script.len() > 1 { script.remove(0) } else { script[0].clone() }
            };
            let delay = self.delay;
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                next
            })
        }
        fn set_profile(&self, p: Option<String>) {
            self.inner.set_profile(p);
        }
    }

    fn frames(script: Vec<Result<Vec<u8>>>, delay: Duration) -> Arc<Frames> {
        Arc::new(Frames { inner: FakeEngine::default(), script: Mutex::new(script), delay, calls: AtomicUsize::new(0) })
    }

    fn collector() -> (Arc<Mutex<Vec<Vec<u8>>>>, impl Fn(Vec<u8>) + Send + Sync + 'static) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        (got, move |png| sink.lock().unwrap().push(png))
    }

    fn log_lines() -> (Arc<Mutex<Vec<String>>>, LogHandler) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        (lines, Arc::new(move |_, line: &str| sink.lock().unwrap().push(line.to_owned())))
    }

    #[tokio::test(start_paused = true)]
    async fn frames_are_delivered_on_an_interval() {
        let engine = frames(vec![Ok(vec![1, 2, 3])], Duration::ZERO);
        let (got, on_frame) = collector();
        let mirror = EngineMirror::start(engine, Duration::from_millis(250), on_frame, crate::no_log());
        tokio::time::sleep(Duration::from_millis(760)).await;
        assert_eq!(got.lock().unwrap().len(), 4, "one at once, then one per interval");
        mirror.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_capture_is_skipped_not_queued_into_a_backlog() {
        let engine = frames(vec![Ok(vec![1])], Duration::from_millis(600));
        let (_, on_frame) = collector();
        let _mirror = EngineMirror::start(engine.clone(), Duration::from_millis(250), on_frame, crate::no_log());
        tokio::time::sleep(Duration::from_millis(1300)).await;
        // Captures at 0 and 600, and one started at 1200: never more than one in flight.
        assert!(engine.calls.load(Ordering::SeqCst) <= 3, "{} captures", engine.calls.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_capture_is_not_treated_as_a_frame() {
        let engine = frames(vec![Ok(Vec::new()), Ok(vec![7])], Duration::ZERO);
        let (got, on_frame) = collector();
        let _mirror = EngineMirror::start(engine, Duration::from_millis(250), on_frame, crate::no_log());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(*got.lock().unwrap(), vec![vec![7]]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_capture_is_reported_once_not_four_times_a_second() {
        let engine = frames(vec![Err(err!("device offline"))], Duration::ZERO);
        let (lines, on_log) = log_lines();
        let (_, on_frame) = collector();
        let _mirror = EngineMirror::start(engine, Duration::from_millis(250), on_frame, on_log);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(*lines.lock().unwrap(), vec!["screen capture failed: device offline".to_owned()]);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_halts_capturing() {
        let engine = frames(vec![Ok(vec![1])], Duration::ZERO);
        let (got, on_frame) = collector();
        let mirror = EngineMirror::start(engine, Duration::from_millis(250), on_frame, crate::no_log());
        tokio::time::sleep(Duration::from_millis(10)).await;
        mirror.stop();
        tokio::time::sleep(Duration::from_millis(10)).await;
        let seen = got.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(got.lock().unwrap().len(), seen);
        assert!(!mirror.is_active());
    }
}
