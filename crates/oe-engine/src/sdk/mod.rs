//! Google's SDK emulator as a native Windows process: `emulator.exe` and `adb.exe`.

pub mod adb;
pub mod adb_wire;
pub mod avd;
pub mod avd_config;
pub mod dependencies;
pub mod find_process;
pub mod licenses;
pub mod provision;
pub mod repository;
pub mod sdk_engine;
