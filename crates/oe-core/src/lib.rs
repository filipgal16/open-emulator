//! The app itself, without a window.
//!
//! Everything the Electron main process did, behind one API the UI drives: first-run setup, the
//! device and its state, settings, the account, the store, and updates. The UI holds a handle to
//! it and listens to the events it broadcasts; nothing here knows how it is drawn.

pub mod account;
pub mod core;
pub mod device;
pub mod display;
pub mod settings;
pub mod update;
pub mod setup;
pub mod setup_steps;

pub use oe_engine::{err, fail, Error, Result};
pub use oe_store::types::now_ms;
