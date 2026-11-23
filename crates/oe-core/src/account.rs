//! The device-wide account: who the user is, across every guest the app manages, and — only if they
//! chose to store one — their Google password, sealed with DPAPI.
//!
//! The password never leaves this module except as keystrokes typed into the guest's focused field,
//! and nothing here ever hands it to the UI.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::client::OpenEmuClient;
use oe_engine::download::MessageHandler;
use oe_engine::no_log;
use serde::{Deserialize, Serialize};

pub const GOOGLE_ACCOUNT_TYPE: &str = "com.google";
const GUEST_TTL_MS: i64 = 30_000;

// ── What the UI sees ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SignInState {
    /// The guest has not been asked yet.
    #[default]
    Unknown,
    /// The guest is not running, or not answering.
    GuestUnavailable,
    SignedOut,
    SignedIn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestAccount {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GuestAccountState {
    pub state: SignInState,
    /// Google accounts found in the guest. Empty unless signed in.
    pub accounts: Vec<GuestAccount>,
    pub checked_at: Option<i64>,
    /// Which AVD these belong to, so a profile switch does not show stale status.
    pub avd: Option<String>,
}

/// Holds no secret: it records only *that* a password is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub display_name: String,
    pub email: Option<String>,
    pub has_stored_password: bool,
    /// Whether assisted sign-in may type the stored credential. Off unless explicitly turned on.
    pub auto_fill: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountState {
    pub profile: AccountProfile,
    pub guest: GuestAccountState,
    /// False when DPAPI is unavailable — the vault then refuses to store anything.
    pub vault_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillField {
    Email,
    Password,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillResult {
    pub ok: bool,
    pub message: String,
}

fn fill(ok: bool, message: &str) -> FillResult {
    FillResult { ok, message: message.to_owned() }
}

// ── The profile, on disk ─────────────────────────────────────────────────────────────────────────

pub struct ProfileStore {
    file: PathBuf,
    profile: Mutex<AccountProfile>,
}

impl ProfileStore {
    pub fn new(file: impl Into<PathBuf>) -> ProfileStore {
        let file = file.into();
        let profile = Self::read(&file);
        ProfileStore { file, profile: Mutex::new(profile) }
    }

    fn read(file: &Path) -> AccountProfile {
        let Some(raw) = std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()) else {
            return AccountProfile::default();
        };
        let has_stored_password = raw.get("hasStoredPassword") == Some(&serde_json::Value::Bool(true));
        AccountProfile {
            display_name: raw.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_owned(),
            email: raw.get("email").and_then(|v| v.as_str()).map(str::trim).filter(|e| !e.is_empty()).map(str::to_owned),
            has_stored_password,
            auto_fill: raw.get("autoFill") == Some(&serde_json::Value::Bool(true)) && has_stored_password,
            created_at: raw.get("createdAt").and_then(|v| v.as_f64()).map_or(0, |at| at as i64),
        }
    }

    pub fn get(&self) -> AccountProfile {
        self.profile.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn patch(&self, change: impl FnOnce(&mut AccountProfile)) -> AccountProfile {
        let profile = {
            let mut profile = self.profile.lock().unwrap_or_else(|p| p.into_inner());
            change(&mut profile);
            profile.clone()
        };
        // A failed write keeps the change for this session only.
        if let Ok(text) = serde_json::to_string(&profile) {
            if let Some(dir) = self.file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = self.file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
        profile
    }

    pub fn set_email(&self, email: Option<&str>) -> AccountProfile {
        let trimmed = email.map(str::trim).unwrap_or("").to_owned();
        self.patch(|profile| {
            // A profile with no name yet takes the local part of the address, which is nearly
            // always what someone would have typed anyway.
            if profile.display_name.is_empty() {
                profile.display_name = trimmed.split('@').next().unwrap_or("").to_owned();
            }
            if profile.created_at == 0 {
                profile.created_at = crate::now_ms();
            }
            profile.email = (!trimmed.is_empty()).then_some(trimmed);
        })
    }

    pub fn set_display_name(&self, name: &str) -> AccountProfile {
        let name: String = name.trim().chars().take(64).collect();
        self.patch(|profile| profile.display_name = name)
    }

    /// Turning the stored password off turns autofill off too; leaving it on would offer to type a
    /// credential that is no longer there.
    pub fn set_has_stored_password(&self, stored: bool) -> AccountProfile {
        self.patch(|profile| {
            profile.has_stored_password = stored;
            profile.auto_fill = stored && profile.auto_fill;
        })
    }

    pub fn set_auto_fill(&self, enabled: bool) -> AccountProfile {
        self.patch(|profile| profile.auto_fill = enabled && profile.has_stored_password)
    }

    pub fn clear(&self) -> AccountProfile {
        self.patch(|profile| *profile = AccountProfile::default())
    }
}

// ── The password ─────────────────────────────────────────────────────────────────────────────────

/// One secret, sealed with DPAPI for this Windows user.
///
/// What matters is what it refuses to do: with no working DPAPI it stores *nothing* rather than
/// falling back to a file the next process to read the disk could lift.
pub struct SecretVault {
    file: PathBuf,
}

impl SecretVault {
    pub fn new(file: impl Into<PathBuf>) -> SecretVault {
        SecretVault { file: file.into() }
    }

    pub fn available(&self) -> bool {
        cfg!(windows)
    }

    pub fn has(&self) -> bool {
        self.file.is_file()
    }

    /// Stores the secret, or with `None` removes it. False means nothing was written.
    pub fn set(&self, secret: Option<&str>) -> bool {
        let Some(secret) = secret.filter(|secret| !secret.is_empty()) else {
            return match std::fs::remove_file(&self.file) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => false,
                _ => true,
            };
        };
        let Some(sealed) = seal(secret.as_bytes()) else { return false };
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("tmp");
        std::fs::write(&tmp, sealed).is_ok() && std::fs::rename(&tmp, &self.file).is_ok()
    }

    /// The secret, for the caller to use and drop at once. `None` when nothing is stored, or when
    /// Windows can no longer open it — a different user, or a restored profile.
    pub fn get(&self) -> Option<String> {
        let sealed = std::fs::read(&self.file).ok()?;
        String::from_utf8(open(&sealed)?).ok()
    }
}

#[cfg(windows)]
fn seal(data: &[u8]) -> Option<Vec<u8>> {
    oe_win::dpapi::protect(data)
}

#[cfg(windows)]
fn open(data: &[u8]) -> Option<Vec<u8>> {
    oe_win::dpapi::unprotect(data)
}

#[cfg(not(windows))]
fn seal(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn open(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let clean: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let body = clean.strip_suffix(b"==").or_else(|| clean.strip_suffix(b"=")).unwrap_or(&clean);
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut bits = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            bits |= value(c)? << (18 - 6 * i);
        }
        let bytes = [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8];
        out.extend_from_slice(&bytes[..chunk.len().saturating_sub(1)]);
    }
    Some(out)
}

/// The key Electron kept in `Local State`: base64 of `DPAPI` followed by the DPAPI-sealed key.
fn electron_key(local_state: &Path) -> Option<Vec<u8>> {
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(local_state).ok()?).ok()?;
    let encoded = raw.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let sealed = base64_decode(encoded)?;
    open(sealed.strip_prefix(b"DPAPI")?)
}

/// Reads a secret Electron's `safeStorage` wrote: `v10`, a 12-byte nonce, then AES-256-GCM.
fn decrypt_electron_secret(bytes: &[u8], key: &[u8]) -> Option<String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let rest = bytes.strip_prefix(b"v10")?;
    if rest.len() < 12 + 16 {
        return None;
    }
    let (nonce, sealed) = rest.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    String::from_utf8(cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()?).ok()
}

/// What became of a password the Electron app had stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migration {
    /// There was nothing to move.
    None,
    Moved,
    /// It could not be read. Nothing is stored in its place, and the user is asked again — never a
    /// readable copy.
    Lost,
}

/// Moves the Electron app's stored password into this app's vault, once, then deletes the old
/// file either way: read, it has been re-sealed; unreadable, it never will be.
pub fn migrate_electron_secret(user_data: &Path, vault: &SecretVault) -> Migration {
    let old = user_data.join("account-secret.bin");
    if !old.is_file() {
        return Migration::None;
    }
    let moved = (|| {
        let key = electron_key(&user_data.join("Local State"))?;
        let secret = decrypt_electron_secret(&std::fs::read(&old).ok()?, &key)?;
        vault.set(Some(&secret)).then_some(())
    })();
    let _ = std::fs::remove_file(&old);
    if moved.is_some() { Migration::Moved } else { Migration::Lost }
}

// ── The guest's accounts ─────────────────────────────────────────────────────────────────────────

/// The accounts in `dumpsys account` output, as `Account {name=…, type=…}` entries, each once.
pub fn parse_accounts(text: &str) -> Vec<GuestAccount> {
    let mut accounts: Vec<GuestAccount> = Vec::new();
    for line in text.split('\n') {
        let mut rest = line;
        while let Some(at) = rest.find("Account") {
            rest = &rest[at + "Account".len()..];
            let Some(body) = rest.trim_start().strip_prefix('{') else { continue };
            let Some(body) = body.trim_start().strip_prefix("name=") else { continue };
            let Some(comma) = body.match_indices(',').map(|(i, _)| i).find(|&i| body[i + 1..].trim_start().starts_with("type=")) else {
                continue;
            };
            let name = body[..comma].trim_end();
            let after = body[comma + 1..].trim_start();
            let after = &after["type=".len()..];
            let Some(close) = after.find('}') else { continue };
            let kind = after[..close].trim_end();
            rest = &after[close + 1..];
            if name.is_empty() || kind.is_empty() || accounts.iter().any(|a| a.name == name && a.kind == kind) {
                continue;
            }
            accounts.push(GuestAccount { name: name.to_owned(), kind: kind.to_owned() });
        }
    }
    accounts
}

pub struct GuestAccountMonitor {
    client: OpenEmuClient,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    state: Mutex<GuestAccountState>,
    checking: tokio::sync::Mutex<()>,
    checks: AtomicU64,
}

impl GuestAccountMonitor {
    pub fn new(client: OpenEmuClient) -> GuestAccountMonitor {
        GuestAccountMonitor {
            client,
            now: Arc::new(crate::now_ms),
            state: Mutex::default(),
            checking: tokio::sync::Mutex::new(()),
            checks: AtomicU64::new(0),
        }
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> GuestAccountMonitor {
        self.now = Arc::new(now);
        self
    }

    pub fn current(&self) -> GuestAccountState {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub async fn refresh(&self, avd: Option<String>, force: bool) -> GuestAccountState {
        let checked_at = self.current().checked_at;
        if !force && checked_at.is_some_and(|at| (self.now)() - at < GUEST_TTL_MS) {
            return self.current();
        }
        let before = self.checks.load(Ordering::SeqCst);
        let _turn = self.checking.lock().await;
        if self.checks.load(Ordering::SeqCst) != before {
            return self.current();
        }
        // Unquoted: the guest's own shell is the one that runs it. The Electron app quoted it for
        // WSL's extra shell, which natively made it a command called "dumpsys account".
        let result = self.client.shell("dumpsys account", no_log(), Some(Duration::from_secs(30))).await;
        let state = if result.success() {
            let accounts: Vec<GuestAccount> =
                parse_accounts(&result.stdout.join("\n")).into_iter().filter(|a| a.kind == GOOGLE_ACCOUNT_TYPE).collect();
            let state = if accounts.is_empty() { SignInState::SignedOut } else { SignInState::SignedIn };
            GuestAccountState { state, accounts, checked_at: Some((self.now)()), avd }
        } else {
            GuestAccountState { state: SignInState::GuestUnavailable, accounts: Vec::new(), checked_at: Some((self.now)()), avd }
        };
        *self.state.lock().unwrap_or_else(|p| p.into_inner()) = state.clone();
        self.checks.fetch_add(1, Ordering::SeqCst);
        state
    }
}

// ── The service ──────────────────────────────────────────────────────────────────────────────────

pub struct Account {
    client: OpenEmuClient,
    profile: ProfileStore,
    vault: SecretVault,
    monitor: GuestAccountMonitor,
    on_log: MessageHandler,
}

impl Account {
    /// Opens the account in `user_data`, moving over a password the Electron app stored.
    pub fn new(client: OpenEmuClient, user_data: &Path, on_log: MessageHandler) -> Account {
        let log: MessageHandler = Arc::new(move |message: &str| on_log(&format!("[account] {message}")));
        let profile = ProfileStore::new(user_data.join("account.json"));
        let vault = SecretVault::new(user_data.join("account-secret.dpapi"));
        match migrate_electron_secret(user_data, &vault) {
            Migration::None => {}
            Migration::Moved => log("stored password moved to this version's keychain"),
            Migration::Lost => log("the previous version's stored password could not be read; it will be asked for again"),
        }
        // The profile's flag follows what is really stored, so the UI never offers a password the
        // vault cannot produce.
        if profile.get().has_stored_password != vault.has() {
            profile.set_has_stored_password(vault.has());
        }
        Account { monitor: GuestAccountMonitor::new(client.clone()), client, profile, vault, on_log: log }
    }

    pub fn state(&self) -> AccountState {
        AccountState { profile: self.profile.get(), guest: self.monitor.current(), vault_available: self.vault.available() }
    }

    pub async fn refresh(&self, avd: Option<String>, force: bool) -> AccountState {
        self.monitor.refresh(avd, force).await;
        self.state()
    }

    pub fn set_email(&self, email: Option<&str>) -> AccountState {
        self.profile.set_email(email);
        self.state()
    }

    pub fn set_display_name(&self, name: &str) -> AccountState {
        self.profile.set_display_name(name);
        self.state()
    }

    /// Stores or clears the password. One-way: nothing ever reads it back out to the UI.
    pub fn set_password(&self, password: Option<&str>) -> AccountState {
        match password {
            None => {
                self.vault.set(None);
                self.profile.set_has_stored_password(false);
                (self.on_log)("stored password cleared");
            }
            Some("") => {}
            Some(password) => {
                let stored = self.vault.set(Some(password));
                self.profile.set_has_stored_password(stored);
                (self.on_log)(if stored { "password stored in the Windows keychain" } else { "refused to store password: no keychain available" });
            }
        }
        self.state()
    }

    pub fn set_auto_fill(&self, enabled: bool) -> AccountState {
        self.profile.set_auto_fill(enabled);
        self.state()
    }

    pub fn sign_out(&self) -> AccountState {
        self.vault.set(None);
        self.profile.clear();
        (self.on_log)("local account cleared");
        self.state()
    }

    /// Opens the guest's own "add a Google account" flow. Nothing is automated past this point.
    pub async fn begin_sign_in(&self) -> FillResult {
        if self.client.start_add_google_account(no_log()).await {
            fill(true, "Sign-in opened in the guest — complete it on the screen.")
        } else {
            fill(false, "Could not open the guest sign-in screen. Is Android running?")
        }
    }

    /// Types the stored value for `field` into the guest's focused input.
    pub async fn fill(&self, field: FillField) -> FillResult {
        let profile = self.profile.get();
        match field {
            FillField::Email => {
                let Some(email) = profile.email else { return fill(false, "No address saved for this account.") };
                if self.client.text(&email).await {
                    fill(true, "Address typed into the focused field.")
                } else {
                    fill(false, "The guest did not accept the text. Tap the field first.")
                }
            }
            FillField::Password => {
                if !profile.has_stored_password {
                    return fill(false, "No password saved for this account.");
                }
                if !profile.auto_fill {
                    return fill(false, "Autofill is turned off for this account.");
                }
                let Some(secret) = self.vault.get() else {
                    return fill(false, "The saved password could not be read from the Windows keychain.");
                };
                if self.client.text_secret(&secret, no_log()).await {
                    fill(true, "Password typed into the focused field.")
                } else {
                    (self.on_log)("password autofill was refused by the guest");
                    fill(false, "The guest did not accept the text. Tap the password field first.")
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use oe_engine::testing::{failed, ok, FakeEngine};

    use super::*;

    fn quiet() -> MessageHandler {
        Arc::new(|_: &str| {})
    }

    #[test]
    fn accounts_are_read_from_dumpsys_once_each() {
        let text = "Accounts: 2\n  Account {name=me@gmail.com, type=com.google}\n  Account {name=me@gmail.com, type=com.google}\n  Account {name=x, type=com.other}\n";
        let accounts = parse_accounts(text);
        assert_eq!(accounts.len(), 2);
        assert_eq!((accounts[0].name.as_str(), accounts[0].kind.as_str()), ("me@gmail.com", "com.google"));
    }

    #[test]
    fn the_profile_names_itself_from_the_address_and_autofill_needs_a_stored_password() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path().join("account.json"));
        let profile = store.set_email(Some("  ada@example.com "));
        assert_eq!((profile.display_name.as_str(), profile.email.as_deref()), ("ada", Some("ada@example.com")));
        assert!(!store.set_auto_fill(true).auto_fill, "nothing to fill with");
        store.set_has_stored_password(true);
        assert!(store.set_auto_fill(true).auto_fill);
        assert!(!store.set_has_stored_password(false).auto_fill, "forgetting the password stops autofill");
        assert_eq!(ProfileStore::new(dir.path().join("account.json")).get().email.as_deref(), Some("ada@example.com"));
    }

    #[cfg(windows)]
    #[test]
    fn the_vault_round_trips_and_clearing_it_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = SecretVault::new(dir.path().join("account-secret.dpapi"));
        assert!(vault.set(Some("hunter2")));
        assert!(!std::fs::read(dir.path().join("account-secret.dpapi")).unwrap().windows(7).any(|w| w == b"hunter2"));
        assert_eq!(vault.get().as_deref(), Some("hunter2"));
        assert!(vault.set(None));
        assert!(!vault.has());
    }

    /// Writes what Electron's `safeStorage` would have: a `Local State` key and a `v10` secret.
    #[cfg(windows)]
    fn electron_files(dir: &Path, password: &str) {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        let key = [7u8; 32];
        let mut sealed_key = b"DPAPI".to_vec();
        sealed_key.extend(oe_win::dpapi::protect(&key).unwrap());
        let encoded = base64_encode(&sealed_key);
        std::fs::write(dir.join("Local State"), format!(r#"{{"os_crypt":{{"encrypted_key":"{encoded}"}}}}"#)).unwrap();
        let nonce = [3u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let mut secret = b"v10".to_vec();
        secret.extend_from_slice(&nonce);
        secret.extend(cipher.encrypt(Nonce::from_slice(&nonce), password.as_bytes()).unwrap());
        std::fs::write(dir.join("account-secret.bin"), secret).unwrap();
    }

    #[cfg(windows)]
    fn base64_encode(data: &[u8]) -> String {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let bits = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(TABLE[((bits >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[cfg(windows)]
    #[test]
    fn a_password_the_electron_app_stored_moves_to_dpapi_and_the_old_file_goes() {
        let dir = tempfile::tempdir().unwrap();
        electron_files(dir.path(), "P@ss w0rd!");
        std::fs::write(dir.path().join("account.json"), r#"{"displayName":"Ada","email":"ada@example.com","hasStoredPassword":true,"autoFill":true,"createdAt":5}"#).unwrap();
        let account = Account::new(OpenEmuClient::new(Arc::new(FakeEngine::new())), dir.path(), quiet());
        assert!(!dir.path().join("account-secret.bin").exists());
        assert_eq!(SecretVault::new(dir.path().join("account-secret.dpapi")).get().as_deref(), Some("P@ss w0rd!"));
        let state = account.state();
        assert!(state.profile.has_stored_password && state.profile.auto_fill, "the user keeps what they had");
    }

    #[cfg(windows)]
    #[test]
    fn an_unreadable_old_password_is_dropped_and_asked_for_again_never_kept_in_the_clear() {
        let dir = tempfile::tempdir().unwrap();
        electron_files(dir.path(), "secret");
        std::fs::write(dir.path().join("Local State"), r#"{"os_crypt":{"encrypted_key":"bm90IGEga2V5"}}"#).unwrap();
        std::fs::write(dir.path().join("account.json"), r#"{"hasStoredPassword":true,"autoFill":true}"#).unwrap();
        let account = Account::new(OpenEmuClient::new(Arc::new(FakeEngine::new())), dir.path(), quiet());
        assert!(!dir.path().join("account-secret.bin").exists());
        assert!(!dir.path().join("account-secret.dpapi").exists());
        assert!(!account.state().profile.has_stored_password, "the UI asks for it again");
    }

    #[tokio::test]
    async fn the_guest_is_asked_unquoted_and_only_google_accounts_count() {
        let engine = Arc::new(FakeEngine::new().answering(|_| ok(&["Account {name=a@gmail.com, type=com.google}", "Account {name=b, type=com.whatsapp}"])));
        let monitor = GuestAccountMonitor::new(OpenEmuClient::new(engine.clone())).with_clock(|| 100_000);
        let state = monitor.refresh(Some("avd".into()), false).await;
        assert_eq!(state.state, SignInState::SignedIn);
        assert_eq!(state.accounts.len(), 1);
        assert_eq!(*engine.shells.lock().unwrap(), ["dumpsys account"]);
        monitor.refresh(None, false).await;
        assert_eq!(engine.shells.lock().unwrap().len(), 1, "cached for thirty seconds");
    }

    #[tokio::test]
    async fn a_guest_that_does_not_answer_is_unavailable_not_signed_out() {
        let engine = Arc::new(FakeEngine::new().answering(|_| failed("no devices")));
        let monitor = GuestAccountMonitor::new(OpenEmuClient::new(engine));
        assert_eq!(monitor.refresh(None, true).await.state, SignInState::GuestUnavailable);
    }

    #[tokio::test]
    async fn the_password_is_typed_only_when_stored_and_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(FakeEngine::new());
        let account = Account::new(OpenEmuClient::new(engine.clone()), dir.path(), quiet());
        assert!(!account.fill(FillField::Password).await.ok);
        if cfg!(windows) {
            account.set_password(Some("hunter2"));
            assert_eq!(account.fill(FillField::Password).await.message, "Autofill is turned off for this account.");
            account.set_auto_fill(true);
            assert!(account.fill(FillField::Password).await.ok);
            assert_eq!(*engine.inputs.lock().unwrap(), ["secret:7"], "typed as a secret, never as a shell command");
        }
    }
}
