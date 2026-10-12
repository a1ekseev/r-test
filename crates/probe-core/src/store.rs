//! Secret storage: the OS keyring (Keychain / Credential Manager / Secret Service) or process memory.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// Storage failure, with the backend's own message.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct StoreError(String);

fn err(e: keyring::Error) -> StoreError {
    StoreError(e.to_string())
}

/// Blocking secret storage; call it off the async runtime.
pub trait SecretStore: std::fmt::Debug + Send + Sync {
    /// Saves a secret, replacing any previous value.
    ///
    /// # Errors
    /// The backend is unavailable or refused the write.
    fn set(&self, key: &str, secret: &[u8]) -> Result<(), StoreError>;
    /// Reads a secret; `None` when there is no entry.
    ///
    /// # Errors
    /// The backend is unavailable.
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError>;
    /// Deletes a secret; a missing entry is not an error.
    ///
    /// # Errors
    /// The backend is unavailable.
    fn delete(&self, key: &str) -> Result<(), StoreError>;
}

/// In-memory store for tests and machines without an OS keyring.
#[derive(Debug, Default)]
pub struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

impl SecretStore for MemoryStore {
    fn set(&self, key: &str, secret: &[u8]) -> Result<(), StoreError> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(key.to_owned(), secret.to_vec());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.0.lock().unwrap_or_else(PoisonError::into_inner).get(key).cloned())
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(key);
        Ok(())
    }
}

/// The native OS keyring under a service name.
#[derive(Debug, Clone)]
pub struct OsKeyring {
    service: String,
}

impl OsKeyring {
    /// Store bound to `service`.
    #[must_use]
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(&self.service, key).map_err(err)
    }
}

impl SecretStore for OsKeyring {
    fn set(&self, key: &str, secret: &[u8]) -> Result<(), StoreError> {
        self.entry(key)?.set_secret(secret).map_err(err)
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        match self.entry(key)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}
