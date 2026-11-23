//! Where apps come from and how they reach the guest.
//!
//! F-Droid's catalogue, searched locally; app files on this PC, plain or bundled; the Play client,
//! driven inside the guest; and the installer that downloads, verifies, unpacks and installs.

pub mod app_library;
pub mod bundle;
pub mod catalog;
pub mod fdroid;
pub mod fdroid_index;
pub mod fetch;
pub mod guest_facts;
pub mod image_cache;
pub mod installer;
pub mod local;
pub mod play;
pub mod source;
pub mod store;
pub mod types;

pub use oe_engine::{err, fail, Error, Result};
