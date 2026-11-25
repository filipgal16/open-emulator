//! Saves one frame of a running emulator's gRPC screen as raw RGBA, for a look at what it shows.
//! `cargo run -p oe-engine --example grpc_shot -- <out.rgba> [emulator home]` prints `width height`.

use oe_engine::grpc::{discover, EmulatorGrpc};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = args.first().expect("output file");
    let home = args.get(1).map(std::path::PathBuf::from);
    let (port, token) = discover("OpenEmulator_", home.as_deref()).expect("no running emulator found");
    let grpc = EmulatorGrpc::connect(port, token).await.expect("connect");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(20), grpc.screenshot())
        .await
        .expect("no answer in 20 s")
        .expect("screenshot");
    std::fs::write(out, &frame.rgba).expect("write");
    println!("{} {}", frame.width, frame.height);
}
