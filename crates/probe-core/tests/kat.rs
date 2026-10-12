//! Known-answer tests for the crypto crates. Expected values were produced by an independent
//! NaCl implementation (PyNaCl) for the message "probe" and the fixed keys below.

use blake2::digest::consts::U32;
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};

const MSG: &[u8] = b"probe";
const SK_A: [u8; 32] = [0x11; 32];
const SK_B: [u8; 32] = [0x22; 32];
const PK_A: &str = "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13";
const PK_B: &str = "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20";

fn key32(hex: &str) -> [u8; 32] {
    hex::decode(hex).unwrap().try_into().unwrap()
}

fn nonce() -> [u8; 24] {
    std::array::from_fn(|i| u8::try_from(i).unwrap())
}

#[test]
fn ed25519_sign_and_strict_verify() {
    let key = SigningKey::from_bytes(&[0x07; 32]);
    let public = key.verifying_key();
    assert_eq!(hex::encode(public.as_bytes()), "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c");
    let sig = key.sign(MSG);
    assert_eq!(
        hex::encode(sig.to_bytes()),
        "8473d262f07a38c8becdb716e9bf8cb065c62145fdcbdc48782a8e7ca6670066\
         cd77c22e8236e1727fee97532e58c0cd2c9696a096cace85087a4f035ab6520e"
    );
    public.verify_strict(MSG, &sig).unwrap();
    assert!(public.verify_strict(b"probf", &sig).is_err());

    // Small-order public key (the identity point) with R = identity, S = 0: strict verification must refuse it.
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let mut forged = [0u8; 64];
    forged[0] = 1;
    let weak = VerifyingKey::from_bytes(&identity).unwrap();
    assert!(weak.verify_strict(MSG, &Signature::from_bytes(&forged)).is_err());
}

#[test]
fn x25519_public_keys_and_shared_secret() {
    use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};
    assert_eq!(hex::encode(x25519(SK_A, X25519_BASEPOINT_BYTES)), PK_A);
    assert_eq!(hex::encode(x25519(SK_B, X25519_BASEPOINT_BYTES)), PK_B);
    let shared = "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056";
    assert_eq!(hex::encode(x25519(SK_A, key32(PK_B))), shared);
    assert_eq!(hex::encode(x25519(SK_B, key32(PK_A))), shared);
}

#[test]
fn box_seal_and_open() {
    use crypto_box::aead::Aead as _;
    use crypto_box::{PublicKey, SalsaBox, SecretKey};
    let sender = SalsaBox::new(&PublicKey::from(key32(PK_B)), &SecretKey::from(SK_A));
    let sealed = sender.encrypt(&nonce().into(), MSG).unwrap();
    assert_eq!(hex::encode(&sealed), "66a30170ac54cf3c2ed6d58f8d37a8522bfe76f43b");

    let receiver = SalsaBox::new(&PublicKey::from(key32(PK_A)), &SecretKey::from(SK_B));
    assert_eq!(receiver.decrypt(&nonce().into(), sealed.as_slice()).unwrap(), MSG);
    let mut tampered = sealed;
    tampered[0] ^= 1;
    assert!(receiver.decrypt(&nonce().into(), tampered.as_slice()).is_err());
}

#[test]
fn secretbox_seal_and_open() {
    use crypto_secretbox::aead::Aead as _;
    use crypto_secretbox::{KeyInit as _, XSalsa20Poly1305};
    let cipher = XSalsa20Poly1305::new(&[0x33; 32].into());
    let sealed = cipher.encrypt(&nonce().into(), MSG).unwrap();
    assert_eq!(hex::encode(&sealed), "c3ab50121e6961e7b7c4dd5242094acdf29d705b36");
    assert_eq!(cipher.decrypt(&nonce().into(), sealed.as_slice()).unwrap(), MSG);
    let mut tampered = sealed;
    tampered[20] ^= 1;
    assert!(cipher.decrypt(&nonce().into(), tampered.as_slice()).is_err());
}

#[test]
fn blake2b_256_unkeyed() {
    use blake2::Blake2b;
    use blake2::digest::Digest as _;
    assert_eq!(
        hex::encode(Blake2b::<U32>::digest(MSG)),
        "9cfaee8782abe3fe63ee0493d18fe9164419d3d875ae1487785716d0ced56974"
    );
}

#[test]
fn blake2b_256_keyed() {
    use blake2::Blake2bMac;
    use blake2::digest::{KeyInit as _, Mac as _};
    let mut mac = Blake2bMac::<U32>::new_from_slice(&[0x44; 32]).unwrap();
    mac.update(MSG);
    assert_eq!(
        hex::encode(mac.finalize().into_bytes()),
        "9a19dec8f67cde4af30224b74bf88071e36f471bea9948f669410c4540197b8d"
    );
}

#[test]
fn sha256() {
    use sha2::{Digest as _, Sha256};
    assert_eq!(hex::encode(Sha256::digest(MSG)), "ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095");
}
