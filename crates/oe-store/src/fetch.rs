//! The store's one way of reaching the network, so tests can stand a script in for it.

use std::sync::Arc;
use std::time::Duration;

use oe_engine::engine::BoxFuture;

use crate::{err, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchRequest {
    pub url: String,
    pub accept: Option<&'static str>,
    pub if_none_match: Option<String>,
    /// The body is refused past this many bytes, while it streams — not after it is all in memory.
    pub max_bytes: usize,
    pub timeout: Duration,
}

impl FetchRequest {
    pub fn new(url: impl Into<String>, max_bytes: usize, timeout: Duration) -> FetchRequest {
        FetchRequest { url: url.into(), accept: None, if_none_match: None, max_bytes, timeout }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

impl FetchResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

pub type Fetcher = Arc<dyn Fn(FetchRequest) -> BoxFuture<'static, Result<FetchResponse>> + Send + Sync>;

/// Fetches over HTTP(S) with `client`. Sends no cookies — there is no cookie store — and follows
/// redirects.
pub fn http_fetcher(client: reqwest::Client) -> Fetcher {
    Arc::new(move |request: FetchRequest| {
        let client = client.clone();
        Box::pin(async move {
            let mut builder = client.get(&request.url).timeout(request.timeout);
            if let Some(accept) = request.accept {
                builder = builder.header("accept", accept);
            }
            if let Some(tag) = &request.if_none_match {
                builder = builder.header("if-none-match", tag);
            }
            let mut response = builder.send().await.map_err(|error| err!("{error}"))?;
            let status = response.status().as_u16();
            let etag = response.headers().get("etag").and_then(|value| value.to_str().ok()).map(str::to_owned);
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| err!("{error}"))? {
                body.extend_from_slice(&chunk);
                if body.len() > request.max_bytes {
                    return Err(err!("too large (more than {} bytes)", request.max_bytes));
                }
            }
            Ok(FetchResponse { status, etag, body })
        })
    })
}
