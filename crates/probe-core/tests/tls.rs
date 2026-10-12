//! One `ClientConfig` (aws-lc-rs + OS verifier + extra roots) for HTTPS and WSS, against a local
//! TLS server whose certificates are generated here: nothing secret is stored in the repository.

use std::sync::Arc;

use futures_util::{SinkExt as _, StreamExt as _};
use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use time::{Duration, OffsetDateTime};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio_tungstenite::Connector;
use tokio_tungstenite::tungstenite::Message;

/// Short validity: the macOS verifier rejects long-lived server certificates.
fn params(names: &[&str], common_name: &str) -> CertificateParams {
    let mut p = CertificateParams::new(names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>()).unwrap();
    p.distinguished_name.push(DnType::CommonName, common_name);
    p.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    p.not_after = OffsetDateTime::now_utc() + Duration::days(30);
    p
}

/// A fresh CA: its PEM and the issuer used to sign leaf certificates.
fn new_ca(name: &str) -> (String, Issuer<'static, KeyPair>) {
    let key = KeyPair::generate().unwrap();
    let mut p = params(&[], name);
    p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    let pem = p.self_signed(&key).unwrap().pem();
    (pem, Issuer::new(p, key))
}

/// Starts HTTPS (canned answer) and WSS (echo) listeners with a leaf signed by `ca`; returns their ports.
async fn serve(ca: &Issuer<'static, KeyPair>) -> (u16, u16) {
    let key = KeyPair::generate().unwrap();
    let mut p = params(&["localhost", "127.0.0.1"], "localhost");
    p.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
    p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let cert = p.signed_by(&key, ca).unwrap();
    let chain = vec![CertificateDer::from(cert.der().to_vec())];
    let key = PrivateKeyDer::try_from(key.serialize_der()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ports = (http.local_addr().unwrap().port(), ws.local_addr().unwrap().port());
    let http_acceptor = acceptor.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = http.accept().await {
            let acceptor = http_acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else { return };
                let mut buf = [0u8; 4096];
                drop(tls.read(&mut buf).await);
                drop(tls.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello").await);
                drop(tls.shutdown().await);
            });
        }
    });
    tokio::spawn(async move {
        while let Ok((stream, _)) = ws.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(stream).await else { return };
                let Ok(mut socket) = tokio_tungstenite::accept_async(tls).await else { return };
                while let Some(Ok(msg)) = socket.next().await {
                    if msg.is_text() && socket.send(msg).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    ports
}

/// HTTPS then WSS through the very same config. `Ok` only if both succeed.
async fn connect(roots_pem: &str, host: &str, (http_port, ws_port): (u16, u16)) -> Result<(), String> {
    let config = probe_core::tls::client_config(roots_pem.as_bytes()).map_err(|e| e.to_string())?;
    let shared = Arc::new(config.clone());

    let http = reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let res = http.get(format!("https://{host}:{http_port}/")).send().await.map_err(|e| format!("https: {e:?}"))?;
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "hello");

    let url = format!("wss://{host}:{ws_port}/ws");
    let (mut socket, _) =
        tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(Connector::Rustls(shared)))
            .await
            .map_err(|e| format!("wss: {e:?}"))?;
    socket.send(Message::text("ping")).await.unwrap();
    assert_eq!(socket.next().await.unwrap().unwrap().to_text().unwrap(), "ping");
    Ok(())
}

/// Like [`connect`] but skips HTTPS, to see the WSS verdict on its own.
async fn connect_wss_only(roots_pem: &str, ws_port: u16) -> Result<(), String> {
    let config = probe_core::tls::client_config(roots_pem.as_bytes()).map_err(|e| e.to_string())?;
    let url = format!("wss://localhost:{ws_port}/ws");
    tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(Connector::Rustls(Arc::new(config))))
        .await
        .map(drop)
        .map_err(|e| format!("wss: {e:?}"))
}

#[tokio::test]
async fn custom_ca_is_trusted_and_others_are_not() {
    let (ca_pem, ca) = new_ca("Probe Test CA");
    let (foreign_pem, _foreign) = new_ca("Foreign Test CA");
    let ports = serve(&ca).await;

    connect(&ca_pem, "localhost", ports).await.expect("custom CA, DNS name");
    connect(&ca_pem, "127.0.0.1", ports).await.expect("custom CA, IP address");

    for (label, roots) in [("no extra roots", ""), ("foreign CA", foreign_pem.as_str())] {
        let https = connect(roots, "localhost", ports).await.expect_err(label);
        assert!(https.starts_with("https:"), "{label}: {https}");
        let wss = connect_wss_only(roots, ports.1).await.expect_err(label);
        println!("{label}:\n  {https}\n  {wss}");
    }
    assert!(rustls::crypto::CryptoProvider::get_default().is_none(), "no process-wide provider must be installed");
}
