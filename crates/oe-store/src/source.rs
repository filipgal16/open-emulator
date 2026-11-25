//! One place apps come from.

use oe_engine::engine::BoxFuture;

use crate::types::{AppDetail, SourceId, StoreApp};
use crate::Result;

/// What the installer needs to actually put an app in the guest.
///
/// `sha256` is `None` only for a file the user handed us directly; there is nothing to compare a
/// local APK against. For anything fetched over the network it is mandatory; see the installer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadSpec {
    pub package_name: String,
    pub label: String,
    pub source: SourceId,
    pub location: Location,
    pub sha256: Option<String>,
    pub size_bytes: u64,
    pub version_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    /// Fetched over https.
    Url(String),
    /// Already on this PC.
    File(std::path::PathBuf),
}

/// Deliberately narrow: answer a query, describe one app, hand back something installable. Play
/// is not one of these: the real Play client runs inside the guest and does its own installing.
pub trait AppSource: Send + Sync {
    fn id(&self) -> SourceId;
    /// Ranked matches. An empty query means "browse".
    fn search<'a>(&'a self, query: &'a str, guest_sdk: Option<u32>, limit: usize) -> BoxFuture<'a, Result<Vec<StoreApp>>>;
    fn detail<'a>(&'a self, package_name: &'a str, guest_sdk: Option<u32>) -> BoxFuture<'a, Option<AppDetail>>;
    fn resolve<'a>(&'a self, package_name: &'a str, version_code: Option<i64>, guest_sdk: Option<u32>) -> BoxFuture<'a, Option<DownloadSpec>>;
}
