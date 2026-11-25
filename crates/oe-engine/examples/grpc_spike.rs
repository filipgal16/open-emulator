//! Measures the gRPC display path against a running emulator started with
//! `-qt-hide-window -grpc <port> -grpc-use-token`: input round trips, then frames per second while
//! the pointer drags the screen up and down.
//!
//! `cargo run --release -p oe-engine --example grpc_spike -- <port> [seconds] [width] [height]`

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use oe_engine::grpc::{console_token, EmulatorGrpc, BUTTON_PRIMARY};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port: u16 = args.first().and_then(|a| a.parse().ok()).unwrap_or(8554);
    let seconds: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(12);
    let width: u32 = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    let height: u32 = args.get(3).and_then(|a| a.parse().ok()).unwrap_or(0);
    let (port, token) = oe_engine::grpc::discover("OpenEmulator_API30_openemu", None).unwrap_or((port, console_token()));
    println!("gRPC port {port}, token {}", if token.is_some() { "found" } else { "none" });
    let grpc = EmulatorGrpc::connect(port, token).await.expect("connect");

    let mut times = Vec::new();
    for _ in 0..50 {
        let started = Instant::now();
        grpc.send_mouse(1, 1, 0).await.expect("sendMouse");
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!("sendMouse round trip: median {:.2} ms, p90 {:.2} ms, max {:.2} ms", times[25], times[45], times[49]);

    let frames = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let size = Arc::new(std::sync::Mutex::new((0u32, 0u32)));
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let stream = {
        let (grpc, frames, bytes, size) = (grpc.clone(), frames.clone(), bytes.clone(), size.clone());
        tokio::spawn(async move {
            let first = Instant::now();
            let result = grpc
                .stream_screenshots(width, height, |frame| {
                    frames.fetch_add(1, Ordering::Relaxed);
                    bytes.fetch_add(frame.rgba.len() as u64, Ordering::Relaxed);
                    *size.lock().unwrap() = (frame.width, frame.height);
                    Instant::now() < deadline
                })
                .await;
            (result, first.elapsed())
        })
    };

    // Drag the screen, like a finger scrolling a list, until the time is up.
    let (w, h) = loop {
        let current = *size.lock().unwrap();
        if current.0 > 0 {
            break current;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let (x, top, bottom) = (w as i32 / 2, h as i32 * 3 / 10, h as i32 * 8 / 10);
    let mut up = true;
    while Instant::now() < deadline {
        let (from, to) = if up { (bottom, top) } else { (top, bottom) };
        for step in 0..=15 {
            let y = from + (to - from) * step / 15;
            let _ = grpc.send_mouse(x, y, BUTTON_PRIMARY).await;
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
        let _ = grpc.send_mouse(x, to, 0).await;
        tokio::time::sleep(Duration::from_millis(120)).await;
        up = !up;
    }
    let (result, elapsed) = stream.await.expect("stream task");
    let count = frames.load(Ordering::Relaxed);
    println!(
        "frames: {count} in {:.1} s = {:.1} fps, {:.1} MB/s, frame {}x{}, stream result: {:?}",
        elapsed.as_secs_f64(),
        count as f64 / elapsed.as_secs_f64(),
        bytes.load(Ordering::Relaxed) as f64 / 1e6 / elapsed.as_secs_f64(),
        w,
        h,
        result.err()
    );
}
