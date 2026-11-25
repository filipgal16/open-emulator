//! The searchable sources behind one search box.
//!
//! Play is deliberately absent: it has no catalogue to query from here; the real client does its
//! own searching inside the guest, so mixing it in would mean inventing listings we cannot
//! actually produce.

use std::sync::Arc;

use futures_util::future::join_all;

use crate::source::{AppSource, DownloadSpec};
use crate::types::{AppDetail, SourceId, StoreApp};

pub struct Catalog {
    sources: Vec<Arc<dyn AppSource>>,
}

impl Catalog {
    pub fn new(sources: Vec<Arc<dyn AppSource>>) -> Catalog {
        Catalog { sources }
    }

    pub fn sources(&self) -> Vec<SourceId> {
        self.sources.iter().map(|source| source.id()).collect()
    }

    fn source(&self, id: SourceId) -> Option<&Arc<dyn AppSource>> {
        self.sources.iter().find(|source| source.id() == id)
    }

    /// `source` `None` searches every catalogue source at once.
    pub async fn search(&self, query: &str, source: Option<SourceId>, guest_sdk: Option<u32>, limit: usize) -> Vec<StoreApp> {
        if let Some(id) = source {
            return match self.source(id) {
                Some(only) => safe_search(only.as_ref(), query, guest_sdk, limit).await,
                None => Vec::new(),
            };
        }
        // Local first, and not by relevance: those files are the user's own, there are rarely more
        // than a handful, and burying them under 60 catalogue hits would make a drop feel like it
        // had failed.
        let local = match self.source(SourceId::Local) {
            Some(local) => safe_search(local.as_ref(), query, guest_sdk, 12).await,
            None => Vec::new(),
        };
        let remaining = limit.saturating_sub(local.len());
        let others = self.sources.iter().filter(|candidate| candidate.id() != SourceId::Local);
        let rest = join_all(others.map(|candidate| safe_search(candidate.as_ref(), query, guest_sdk, remaining))).await;
        local.into_iter().chain(rest.into_iter().flatten()).take(limit).collect()
    }

    pub async fn detail(&self, source: SourceId, package_name: &str, guest_sdk: Option<u32>) -> Option<AppDetail> {
        self.source(source)?.detail(package_name, guest_sdk).await
    }

    pub async fn resolve(&self, source: SourceId, package_name: &str, version_code: Option<i64>, guest_sdk: Option<u32>) -> Option<DownloadSpec> {
        self.source(source)?.resolve(package_name, version_code, guest_sdk).await
    }
}

/// One broken source returns nothing rather than emptying the whole result set.
async fn safe_search(source: &dyn AppSource, query: &str, guest_sdk: Option<u32>, limit: usize) -> Vec<StoreApp> {
    if limit == 0 {
        return Vec::new();
    }
    source.search(query, guest_sdk, limit).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use oe_engine::engine::BoxFuture;

    use super::*;
    use crate::{err, Result};

    struct Fake {
        id: SourceId,
        count: usize,
        broken: bool,
        asked_sdk: Mutex<Vec<Option<u32>>>,
    }

    fn fake(id: SourceId, count: usize) -> Arc<Fake> {
        Arc::new(Fake { id, count, broken: false, asked_sdk: Mutex::new(Vec::new()) })
    }

    fn app(source: SourceId, n: usize) -> StoreApp {
        StoreApp {
            id: format!("{}:{n}", source.id()),
            source,
            package_name: format!("pkg.{n}"),
            name: format!("App {n}"),
            summary: String::new(),
            icon: None,
            version_name: String::new(),
            version_code: 0,
            size_bytes: 0,
            license: None,
            min_sdk: 0,
            abis: Vec::new(),
            categories: Vec::new(),
            last_updated: 0,
            anti_features: Vec::new(),
        }
    }

    impl AppSource for Fake {
        fn id(&self) -> SourceId {
            self.id
        }
        fn search<'a>(&'a self, _: &'a str, guest_sdk: Option<u32>, limit: usize) -> BoxFuture<'a, Result<Vec<StoreApp>>> {
            self.asked_sdk.lock().unwrap().push(guest_sdk);
            let result = if self.broken { Err(err!("down")) } else { Ok((0..self.count.min(limit)).map(|n| app(self.id, n)).collect()) };
            Box::pin(async move { result })
        }
        fn detail<'a>(&'a self, package: &'a str, _: Option<u32>) -> BoxFuture<'a, Option<AppDetail>> {
            let detail = AppDetail {
                app: StoreApp { package_name: package.to_owned(), ..app(self.id, 0) },
                description: String::new(),
                web_site: None,
                source_code: None,
                screenshots: Vec::new(),
                other_versions: Vec::new(),
            };
            Box::pin(async move { Some(detail) })
        }
        fn resolve<'a>(&'a self, _: &'a str, _: Option<i64>, _: Option<u32>) -> BoxFuture<'a, Option<DownloadSpec>> {
            Box::pin(async { None })
        }
    }

    #[tokio::test]
    async fn a_named_source_is_searched_on_its_own_and_an_unknown_one_yields_nothing() {
        let catalog = Catalog::new(vec![fake(SourceId::Fdroid, 3), fake(SourceId::Local, 2)]);
        assert!(catalog.search("", Some(SourceId::Fdroid), None, 10).await.iter().all(|a| a.source == SourceId::Fdroid));
        assert!(catalog.search("", Some(SourceId::Play), None, 10).await.is_empty());
    }

    #[tokio::test]
    async fn local_results_come_first_and_the_overall_limit_holds() {
        let catalog = Catalog::new(vec![fake(SourceId::Fdroid, 50), fake(SourceId::Local, 2)]);
        let results = catalog.search("", None, Some(30), 10).await;
        assert_eq!(results.len(), 10);
        assert_eq!((results[0].source, results[1].source, results[2].source), (SourceId::Local, SourceId::Local, SourceId::Fdroid));
    }

    #[tokio::test]
    async fn one_broken_source_does_not_empty_the_whole_result_set() {
        let broken = Arc::new(Fake { id: SourceId::Fdroid, count: 5, broken: true, asked_sdk: Mutex::new(Vec::new()) });
        let catalog = Catalog::new(vec![broken, fake(SourceId::Local, 2)]);
        assert_eq!(catalog.search("", None, None, 10).await.len(), 2);
    }

    #[tokio::test]
    async fn the_guest_api_level_reaches_every_source_and_detail_routes_to_its_owner() {
        let fdroid = fake(SourceId::Fdroid, 1);
        let local = fake(SourceId::Local, 1);
        let catalog = Catalog::new(vec![fdroid.clone(), local.clone()]);
        catalog.search("x", None, Some(33), 10).await;
        assert_eq!(*fdroid.asked_sdk.lock().unwrap(), [Some(33)]);
        assert_eq!(*local.asked_sdk.lock().unwrap(), [Some(33)]);
        assert_eq!(catalog.detail(SourceId::Local, "a.b", None).await.unwrap().app.source, SourceId::Local);
        assert!(catalog.detail(SourceId::Play, "a.b", None).await.is_none());
    }
}
