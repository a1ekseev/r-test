//! Secret storage contract. The OS keyring test is ignored by default because it needs a real,
//! unlocked native keyring; run it with `cargo test -p probe-core --test store -- --ignored`.

use probe_core::store::{MemoryStore, OsKeyring, SecretStore};

fn roundtrip(store: &dyn SecretStore) {
    let key = format!("probe-test-{}", std::process::id());
    let secret = b"s3cret\0with-nul\xff";

    store.delete(&key).unwrap();
    assert_eq!(store.get(&key).unwrap(), None);

    store.set(&key, secret).unwrap();
    assert_eq!(store.get(&key).unwrap().as_deref(), Some(secret.as_slice()));

    store.set(&key, b"replaced").unwrap();
    assert_eq!(store.get(&key).unwrap().as_deref(), Some(b"replaced".as_slice()));

    store.delete(&key).unwrap();
    assert_eq!(store.get(&key).unwrap(), None);
    store.delete(&key).unwrap();
}

#[test]
fn memory_store() {
    roundtrip(&MemoryStore::default());
}

#[test]
#[ignore = "needs the native OS keyring"]
fn os_keyring() {
    roundtrip(&OsKeyring::new("probe-demo"));
}
