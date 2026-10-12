//! One rustls `ClientConfig` for both HTTP and WebSocket: aws-lc-rs provider, the OS certificate
//! verifier, plus optional extra roots. No process-wide default provider is installed.

use std::sync::Arc;

use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject as _;
use rustls_platform_verifier::Verifier;

use crate::Error;

fn tls(e: impl std::fmt::Display) -> Error {
    Error::Tls(e.to_string())
}

/// Builds the shared config. `extra_roots_pem` is a PEM bundle of additional trusted CAs (may be empty).
///
/// # Errors
/// The PEM is malformed or the platform verifier could not be created.
pub fn client_config(extra_roots_pem: &[u8]) -> Result<rustls::ClientConfig, Error> {
    let roots = CertificateDer::pem_slice_iter(extra_roots_pem).collect::<Result<Vec<_>, _>>().map_err(tls)?;
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let verifier = Verifier::new_with_extra_roots(roots, Arc::clone(&provider)).map_err(tls)?;
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(tls)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}
