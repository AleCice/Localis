//! API keys of cloud providers, kept only in the system keychain (Windows Credential
//! Manager, macOS Keychain, Secret Service on Linux) through the `keyring` crate.
//!
//! Keys never reach the database, logs, error messages, events or `detail`: errors from
//! the keychain are reported by their kind only. When the keychain cannot be used the
//! operation fails with `keyring_unavailable`; there is no plaintext fallback.

use std::sync::Arc;

use crate::error::{CoreError, Result};
use crate::providers::CloudProvider;

/// Service name of the keychain entries (account = provider id).
pub const KEYRING_SERVICE: &str = "app.localis.desktop";
/// Longest accepted API key.
pub const API_KEY_MAX: usize = 1024;

const KEY_INVALID: &str =
    "La chiave API non è valida: incollala senza spazi o caratteri speciali.";
const KEY_EMPTY: &str = "Inserisci la chiave API.";
const KEYRING_MESSAGE: &str = "Il portachiavi di sistema non è disponibile: Localis salva le chiavi API solo lì, quindi i provider cloud non si possono usare finché non è accessibile.";

/// `KeyringStatus` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyringStatus {
    pub available: bool,
    pub message: Option<String>,
    pub detail: Option<String>,
}

/// Where API keys are kept. The app uses [`SystemKeyring`]; tests use an in-memory store.
pub trait SecretStore: Send + Sync {
    /// Whether the store can be used now.
    fn status(&self) -> KeyringStatus;
    /// The stored key, `None` when there is none.
    fn get(&self, provider: CloudProvider) -> Result<Option<String>>;
    fn set(&self, provider: CloudProvider, key: &str) -> Result<()>;
    /// Removes the key (no-op when there is none).
    fn delete(&self, provider: CloudProvider) -> Result<()>;
}

/// Shared handle to the secret store.
pub type Keys = Arc<dyn SecretStore>;

/// The `keyring_unavailable` error. `detail` must never contain a secret.
pub fn keyring_unavailable(detail: impl Into<String>) -> CoreError {
    CoreError::KeyringUnavailable {
        message: KEYRING_MESSAGE.to_owned(),
        detail: detail.into(),
    }
}

/// Validates a key typed by the user: trimmed, printable ASCII without spaces (it is sent
/// in an HTTP header). The value never appears in the error.
pub fn validate_api_key(raw: &str) -> Result<String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err(CoreError::validation("key", KEY_EMPTY));
    }
    if key.len() > API_KEY_MAX || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(CoreError::validation("key", KEY_INVALID));
    }
    Ok(key.to_owned())
}

/// The platform keychain.
#[derive(Debug, Default)]
pub struct SystemKeyring;

impl SystemKeyring {
    pub fn new() -> Self {
        SystemKeyring
    }

    fn entry(provider: CloudProvider) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, provider.as_str()).map_err(map_keyring_error)
    }
}

/// Describes a keychain error without any secret (some variants carry the stored bytes).
fn map_keyring_error(err: keyring::Error) -> CoreError {
    let detail = match &err {
        keyring::Error::NoDefaultStore => format!(
            "no credential store: {}",
            match keyring::Entry::store_status() {
                Ok(()) => "unknown reason".to_owned(),
                Err(e) => short_error(e),
            }
        ),
        other => short_error(other),
    };
    keyring_unavailable(detail)
}

fn short_error(err: &keyring::Error) -> String {
    use keyring::Error as E;
    match err {
        E::BadEncoding(_) => "stored secret is not valid UTF-8".to_owned(),
        E::BadDataFormat(_, _) => "stored secret has a bad format".to_owned(),
        other => other.to_string().chars().take(300).collect(),
    }
}

impl SecretStore for SystemKeyring {
    fn status(&self) -> KeyringStatus {
        // Probe with a read: a missing entry still proves the store works.
        match Self::entry(CloudProvider::OpenAi).and_then(|e| match e.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(map_keyring_error(err)),
        }) {
            Ok(()) => KeyringStatus {
                available: true,
                message: None,
                detail: None,
            },
            Err(err) => KeyringStatus {
                available: false,
                message: Some(err.to_string()),
                detail: err.detail().map(str::to_owned),
            },
        }
    }

    fn get(&self, provider: CloudProvider) -> Result<Option<String>> {
        match Self::entry(provider)?.get_password() {
            Ok(key) => Ok(Some(key).filter(|k| !k.is_empty())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(map_keyring_error(err)),
        }
    }

    fn set(&self, provider: CloudProvider, key: &str) -> Result<()> {
        Self::entry(provider)?
            .set_password(key)
            .map_err(map_keyring_error)
    }

    fn delete(&self, provider: CloudProvider) -> Result<()> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(map_keyring_error(err)),
        }
    }
}

/// Replaces every occurrence of `secret` in `text` (for diagnostics built from responses).
pub(crate) fn redact(text: &str, secret: &str) -> String {
    if secret.len() < 4 {
        return text.to_owned();
    }
    text.replace(secret, "[chiave rimossa]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_validation_never_echoes_the_key() {
        assert_eq!(validate_api_key("  sk-abc_123  ").unwrap(), "sk-abc_123");
        for bad in ["", "   ", "sk abc", "sk-è", "a\u{0}b", "sk-\tx"] {
            let err = validate_api_key(bad).unwrap_err();
            assert!(matches!(err, CoreError::Validation { field: "key", .. }));
            if !bad.trim().is_empty() {
                assert!(!err.to_string().contains(bad.trim()));
            }
        }
        assert!(validate_api_key(&"x".repeat(API_KEY_MAX + 1)).is_err());
    }

    #[test]
    fn redaction() {
        assert_eq!(
            redact("bad key sk-SECRET-1 here", "sk-SECRET-1"),
            "bad key [chiave rimossa] here"
        );
    }
}
