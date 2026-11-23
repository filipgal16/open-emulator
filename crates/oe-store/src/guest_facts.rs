//! What the store needs to know about the running guest: its API level, whether Play is there,
//! and whether its identity has been rewritten.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::client::OpenEmuClient;
use oe_engine::download::MessageHandler;
use oe_engine::no_log;

use crate::types::now_ms;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GuestFacts {
    /// API level, or `None` when the guest is not answering.
    pub sdk: Option<u32>,
    /// Whether `com.android.vending` is actually present in this profile's image.
    pub play_available: bool,
    pub fingerprint: Option<String>,
    /// True when the build fingerprint has been rewritten to impersonate a real device.
    pub identity_spoofed: bool,
    /// Which AVD answered, so per-profile state is not attributed to the wrong guest.
    pub avd_name: Option<String>,
}

/// A fingerprint that looks like a real retail device means it has been rewritten. Play is
/// certified against the image's own fingerprint, so a guest wearing a Pixel's identity gets "not
/// Play Protect certified" at sign-in; knowing up front lets the UI say so.
pub fn looks_spoofed(fingerprint: Option<&str>) -> bool {
    let Some(fingerprint) = fingerprint else { return false };
    let lower = fingerprint.to_lowercase();
    !["generic", "sdk", "emulator", "goldfish", "ranchu"].iter().any(|stock| lower.contains(stock))
}

const TTL_MS: i64 = 60_000;

/// All four facts come back from one shell round trip, each labelled rather than positional:
/// `getprop` prints an empty line for an unset property, and a positional parse would then read
/// the *next* value as this one.
///
/// Sent as it is, not quoted: there is one shell between here and the guest, and it is the one
/// that has to run this. The Electron app quoted it once more for WSL's extra shell, which made the
/// native guest's `sh` look for a command named after the whole script.
const SCRIPT: &str = concat!(
    "echo \"OE_SDK=$(getprop ro.build.version.sdk)\"; ",
    "echo \"OE_FP=$(getprop ro.build.fingerprint)\"; ",
    "echo \"OE_AVD=$(getprop ro.boot.qemu.avd_name)\"; ",
    "pm path com.android.vending >/dev/null 2>&1 && echo OE_PLAY=1 || echo OE_PLAY=0"
);

pub fn parse_facts(stdout: &[String]) -> GuestFacts {
    let field = |key: &str| -> Option<String> {
        stdout
            .iter()
            .map(|line| line.trim())
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let fingerprint = field("OE_FP");
    GuestFacts {
        sdk: field("OE_SDK").and_then(|sdk| leading_int(&sdk)).filter(|&sdk| sdk > 0),
        play_available: field("OE_PLAY").as_deref() == Some("1"),
        identity_spoofed: looks_spoofed(fingerprint.as_deref()),
        fingerprint,
        avd_name: field("OE_AVD"),
    }
}

/// `Number.parseInt(text, 10)`: the leading digits.
fn leading_int(text: &str) -> Option<u32> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Batched and cached: under a software CPU each fact costs seconds, and the store asks on every
/// tab switch.
pub struct GuestFactsProbe {
    client: OpenEmuClient,
    on_log: Option<MessageHandler>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    facts: Mutex<(GuestFacts, i64)>,
    probing: tokio::sync::Mutex<()>,
    probes: AtomicU64,
}

impl GuestFactsProbe {
    pub fn new(client: OpenEmuClient) -> GuestFactsProbe {
        GuestFactsProbe {
            client,
            on_log: None,
            now: Arc::new(now_ms),
            facts: Mutex::new((GuestFacts::default(), 0)),
            probing: tokio::sync::Mutex::new(()),
            probes: AtomicU64::new(0),
        }
    }

    pub fn with_log(mut self, on_log: MessageHandler) -> GuestFactsProbe {
        self.on_log = Some(on_log);
        self
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> GuestFactsProbe {
        self.now = Arc::new(now);
        self
    }

    /// The last known facts, without touching the guest.
    pub fn current(&self) -> GuestFacts {
        self.facts.lock().unwrap_or_else(|p| p.into_inner()).0.clone()
    }

    pub async fn probe(&self, force: bool) -> GuestFacts {
        let probed_at = self.facts.lock().unwrap_or_else(|p| p.into_inner()).1;
        if !force && probed_at > 0 && (self.now)() - probed_at < TTL_MS {
            return self.current();
        }
        let before = self.probes.load(Ordering::SeqCst);
        let _turn = self.probing.lock().await;
        if self.probes.load(Ordering::SeqCst) != before {
            return self.current(); // a probe finished while this one waited
        }
        let result = self.client.shell(SCRIPT, no_log(), Some(Duration::from_secs(30))).await;
        let facts = if result.success() {
            parse_facts(&result.stdout)
        } else {
            if let (Some(on_log), Some(reason)) = (&self.on_log, result.stderr.first()) {
                on_log(&format!("guest probe failed: {reason}"));
            }
            GuestFacts::default()
        };
        *self.facts.lock().unwrap_or_else(|p| p.into_inner()) = (facts.clone(), (self.now)());
        self.probes.fetch_add(1, Ordering::SeqCst);
        facts
    }
}

#[cfg(test)]
mod tests {
    use oe_engine::testing::{failed, ok, FakeEngine};

    use super::*;

    fn probe(engine: FakeEngine) -> (Arc<FakeEngine>, GuestFactsProbe) {
        let engine = Arc::new(engine);
        (engine.clone(), GuestFactsProbe::new(OpenEmuClient::new(engine)).with_clock(|| 1_000_000))
    }

    #[tokio::test]
    async fn all_four_facts_come_back_from_one_round_trip_sent_unquoted() {
        let (engine, probe) = probe(FakeEngine::new().answering(|_| {
            ok(&["OE_SDK=30", "OE_FP=google/sdk_gphone_x86_64/generic:11/RSR1/1:userdebug/dev-keys", "OE_AVD=OpenEmulator_API30_fast", "OE_PLAY=1"])
        }));
        let facts = probe.probe(false).await;
        assert_eq!(facts.sdk, Some(30));
        assert!(facts.play_available);
        assert!(!facts.identity_spoofed);
        assert_eq!(facts.avd_name.as_deref(), Some("OpenEmulator_API30_fast"));
        let shells = engine.shells.lock().unwrap();
        assert_eq!(shells.len(), 1);
        assert!(shells[0].starts_with("echo \"OE_SDK="), "the guest's shell runs the script itself: {}", shells[0]);
    }

    #[tokio::test]
    async fn an_unset_property_is_absent_not_the_next_line() {
        let (_, probe) = probe(FakeEngine::new().answering(|_| ok(&["OE_SDK=30", "OE_FP=", "OE_AVD=my_avd", "OE_PLAY=1"])));
        let facts = probe.probe(false).await;
        assert_eq!(facts.fingerprint, None);
        assert_eq!(facts.avd_name.as_deref(), Some("my_avd"));
    }

    #[tokio::test]
    async fn facts_are_cached_and_a_guest_that_does_not_answer_is_unknown() {
        let (engine, probe) = probe(FakeEngine::new().answering(|_| failed("error: no devices/emulators found")));
        assert_eq!(probe.probe(false).await, GuestFacts::default());
        probe.probe(false).await;
        assert_eq!(engine.shells.lock().unwrap().len(), 1, "cached for a minute");
        probe.probe(true).await;
        assert_eq!(engine.shells.lock().unwrap().len(), 2, "unless forced");
    }

    #[test]
    fn a_retail_looking_fingerprint_reads_as_rewritten() {
        assert!(looks_spoofed(Some("google/oriole/oriole:13/TQ1A/1:user/release-keys")));
        assert!(!looks_spoofed(Some("google/sdk_gphone64_x86_64/emu64xa:14/UE1A/1:userdebug/dev-keys")));
        assert!(!looks_spoofed(None));
    }
}
