//! Client side of the probe: one TLS config shared by HTTP and WebSocket, request signing,
//! secret storage and a few device facts. Everything here must behave the same on Linux, macOS and Windows.

pub mod store;
pub mod tls;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signer as _, SigningKey};
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Serialize;
use serde_json::{Value, json};
use tokio_tungstenite::Connector;
use tokio_tungstenite::tungstenite::Message;

/// Errors surfaced to callers. `Rejected` carries the error code sent by the server.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// TLS configuration could not be built.
    #[error("tls: {0}")]
    Tls(String),
    /// The server could not be reached or the exchange broke.
    #[error("network")]
    Network(String),
    /// The server answered with an error code.
    #[error("{0}")]
    Rejected(String),
}

fn network(e: impl std::fmt::Display) -> Error {
    Error::Network(e.to_string())
}

/// Facts about the machine, gathered through per-OS code paths.
#[derive(Debug, Clone, Serialize)]
pub struct Device {
    /// Host name.
    pub hostname: String,
    /// OS name and version.
    pub os: String,
    /// IANA time zone, empty when it cannot be determined.
    pub timezone: String,
}

/// Collects [`Device`].
#[must_use]
pub fn device() -> Device {
    Device {
        hostname: gethostname::gethostname().to_string_lossy().into_owned(),
        os: os_info::get().to_string(),
        timezone: iana_time_zone::get_timezone().unwrap_or_default(),
    }
}

/// Client of the demo server.
#[derive(Debug)]
pub struct Client {
    http: reqwest::Client,
    tls: Arc<rustls::ClientConfig>,
    base: String,
    key: SigningKey,
}

impl Client {
    /// Creates a client for `base_url` (`http://` or `https://`); `extra_roots_pem` may be empty.
    ///
    /// # Errors
    /// TLS setup failed or no entropy for the signing key.
    pub fn new(base_url: &str, extra_roots_pem: &[u8]) -> Result<Self, Error> {
        let tls = tls::client_config(extra_roots_pem)?;
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls.clone())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| Error::Tls(e.to_string()))?;
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| Error::Tls(e.to_string()))?;
        Ok(Self {
            http,
            tls: Arc::new(tls),
            base: base_url.trim_end_matches('/').to_owned(),
            key: SigningKey::from_bytes(&seed),
        })
    }

    /// `GET /ping`.
    ///
    /// # Errors
    /// Network failure or a non-success answer.
    pub async fn ping(&self) -> Result<(), Error> {
        let res = self.http.get(format!("{}/ping", self.base)).send().await.map_err(network)?;
        if res.status().is_success() { Ok(()) } else { Err(Error::Rejected(res.status().to_string())) }
    }

    /// `POST /echo`: the server returns the JSON it was sent.
    ///
    /// # Errors
    /// Network failure or a body that is not JSON.
    pub async fn echo(&self, value: &Value) -> Result<Value, Error> {
        let res = self.http.post(format!("{}/echo", self.base)).json(value).send().await.map_err(network)?;
        res.json().await.map_err(network)
    }

    /// Signed `POST /login`; returns the JSON body on success, the server's error code otherwise.
    async fn login(&self, body: &Value) -> Result<Value, Error> {
        let body = body.to_string();
        let res = self
            .http
            .post(format!("{}/login", self.base))
            .header("content-type", "application/json")
            .header("x-probe-key", B64.encode(self.key.verifying_key().as_bytes()))
            .header("x-probe-signature", B64.encode(self.key.sign(body.as_bytes()).to_bytes()))
            .body(body)
            .send()
            .await
            .map_err(network)?;
        let ok = res.status().is_success();
        let json: Value = res.json().await.map_err(network)?;
        if ok { Ok(json) } else { Err(Error::Rejected(json["error"].as_str().unwrap_or("unknown").to_owned())) }
    }

    /// Asks the server to issue a one-time code for `email`.
    ///
    /// # Errors
    /// Network failure or rejection (`bad_email`, ...).
    pub async fn request_code(&self, email: &str) -> Result<(), Error> {
        self.login(&json!({ "email": email })).await.map(drop)
    }

    /// Exchanges `email` + `code` for a session token.
    ///
    /// # Errors
    /// Network failure or rejection (`bad_code`, ...).
    pub async fn confirm_code(&self, email: &str, code: &str) -> Result<String, Error> {
        let json = self.login(&json!({ "email": email, "code": code })).await?;
        json["token"].as_str().map(str::to_owned).ok_or_else(|| network("no token in answer"))
    }

    /// Opens `/ws`, sends `{"type":"ping","n":n}` and returns the `n` of the pong.
    ///
    /// # Errors
    /// Connection failure or an unexpected frame.
    pub async fn ws_ping(&self, n: u64) -> Result<u64, Error> {
        // http -> ws, https -> wss
        let url = format!("ws{}/ws", self.base.strip_prefix("http").unwrap_or(&self.base));
        let connector = Connector::Rustls(Arc::clone(&self.tls));
        let (mut socket, _) = tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(connector))
            .await
            .map_err(network)?;
        socket.send(Message::text(json!({ "type": "ping", "n": n }).to_string())).await.map_err(network)?;
        let answer = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(network)?
            .ok_or_else(|| network("socket closed"))?
            .map_err(network)?;
        let frame: Value = serde_json::from_str(answer.to_text().map_err(network)?).map_err(network)?;
        drop(socket.close(None).await);
        match (frame["type"].as_str(), frame["n"].as_u64()) {
            (Some("pong"), Some(n)) => Ok(n),
            _ => Err(network("unexpected frame")),
        }
    }
}
