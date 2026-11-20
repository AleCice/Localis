//! TEST FIXTURE ONLY: in-memory secret stores standing in for the system keychain.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Mutex;

use localis_core::{keyring_unavailable, CloudProvider, KeyringStatus, Result, SecretStore};

/// Keeps keys in memory (never on disk).
#[derive(Debug, Default)]
pub struct MemoryKeys {
    keys: Mutex<HashMap<CloudProvider, String>>,
}

impl MemoryKeys {
    pub fn with(pairs: &[(CloudProvider, &str)]) -> Self {
        let keys = MemoryKeys::default();
        for (p, k) in pairs {
            keys.set(*p, k).unwrap();
        }
        keys
    }
}

impl SecretStore for MemoryKeys {
    fn status(&self) -> KeyringStatus {
        KeyringStatus {
            available: true,
            message: None,
            detail: None,
        }
    }

    fn get(&self, provider: CloudProvider) -> Result<Option<String>> {
        Ok(self.keys.lock().unwrap().get(&provider).cloned())
    }

    fn set(&self, provider: CloudProvider, key: &str) -> Result<()> {
        self.keys.lock().unwrap().insert(provider, key.to_owned());
        Ok(())
    }

    fn delete(&self, provider: CloudProvider) -> Result<()> {
        self.keys.lock().unwrap().remove(&provider);
        Ok(())
    }
}

/// A keychain that cannot be used (no Secret Service, locked…).
#[derive(Debug, Default)]
pub struct UnavailableKeys;

impl SecretStore for UnavailableKeys {
    fn status(&self) -> KeyringStatus {
        KeyringStatus {
            available: false,
            message: Some("non disponibile".into()),
            detail: Some("synthetic".into()),
        }
    }

    fn get(&self, _: CloudProvider) -> Result<Option<String>> {
        Err(keyring_unavailable("synthetic: no secret service"))
    }

    fn set(&self, _: CloudProvider, _: &str) -> Result<()> {
        Err(keyring_unavailable("synthetic: no secret service"))
    }

    fn delete(&self, _: CloudProvider) -> Result<()> {
        Err(keyring_unavailable("synthetic: no secret service"))
    }
}
