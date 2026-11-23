//! `cargo xtask <command>`: the project's own tasks, which used to be npm scripts, a Makefile, a
//! Python script and PowerShell.

mod bench;
mod dist;
mod icon;
mod rom;
mod wallpaper;

use std::process::ExitCode;

const USAGE: &str = "\
cargo xtask <command>

  dist              build the release app, the Windows installer, and latest.yml
  rom-build         build an open-emulator ROM from a downloaded stock image
  rom-check         check a built ROM against its recipe
  wallpaper <out>   render the default wallpaper to a PNG
  icon              regenerate the app icon (PNG and ICO)
  bench ...         timing runs against the emulator and other runtimes
  emu-compare ...   compare two emulator configurations
  start-game-avd    start a game AVD the way the native engine does";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        eprintln!("{USAGE}");
        return ExitCode::FAILURE;
    };
    let result = match command.as_str() {
        "dist" => dist::run(rest),
        "rom-build" => rom::build(rest),
        "rom-check" => rom::check(rest),
        "wallpaper" => wallpaper::run(rest),
        "icon" => icon::run(rest),
        "bench" => bench::bench(rest),
        "emu-compare" => bench::emu_compare(rest),
        "start-game-avd" => bench::start_game_avd(rest),
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        other => Err(format!("unknown command `{other}`\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}
