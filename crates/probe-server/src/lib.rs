//! Local demo server: `/ping`, `/echo`, `/login` (email + one-time code), `/image/{name}`, WebSocket `/ws`.
//!
//! `/login` requests must be signed: header `x-probe-key` carries the base64 ed25519 public key,
//! `x-probe-signature` the base64 signature over the raw request body.
//!
//! With `PROBE_MARKER` set, every value the server hands out (code, token, message, image name)
//! carries that marker, so that a disk scan can tell where each of them ends up.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Pending one-time codes, keyed by email.
type Codes = Arc<Mutex<HashMap<String, String>>>;

#[derive(Deserialize)]
struct Login {
    email: String,
    code: Option<String>,
}

#[derive(Deserialize)]
struct CodeQuery {
    email: String,
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn header_bytes(headers: &HeaderMap, name: &str) -> Option<Vec<u8>> {
    B64.decode(headers.get(name)?.as_bytes()).ok()
}

/// True when the body carries a valid ed25519 signature for the key sent alongside it.
fn signed(headers: &HeaderMap, body: &[u8]) -> bool {
    let Some(key) = header_bytes(headers, "x-probe-key").and_then(|k| <[u8; 32]>::try_from(k).ok()) else {
        return false;
    };
    let Some(sig) = header_bytes(headers, "x-probe-signature").and_then(|s| <[u8; 64]>::try_from(s).ok()) else {
        return false;
    };
    // verify_strict also rejects small-order keys and non-canonical signatures
    VerifyingKey::from_bytes(&key).is_ok_and(|k| k.verify_strict(body, &Signature::from_bytes(&sig)).is_ok())
}

static MARKER: LazyLock<Option<String>> = LazyLock::new(|| std::env::var("PROBE_MARKER").ok());

/// `value` itself, or `<marker>-<kind>-<value>` when a marker is set.
fn marked(kind: &str, value: &str) -> String {
    MARKER.as_ref().map_or_else(|| value.to_owned(), |marker| format!("{marker}-{kind}-{value}"))
}

fn new_code() -> Result<String, getrandom::Error> {
    let mut raw = [0u8; 4];
    getrandom::fill(&mut raw)?;
    Ok(marked("code", &format!("{:06}", u32::from_le_bytes(raw) % 1_000_000)))
}

/// A 1x1 PNG followed by the requested name backwards: bytes a disk scan can recognise, distinct
/// from the name in the URL. Cacheable on purpose.
async fn image(Path(name): Path<String>) -> Response {
    const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let Ok(mut body) = B64.decode(PIXEL) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "bad_image");
    };
    body.extend(name.bytes().rev());
    ([(CONTENT_TYPE, "image/png"), (CACHE_CONTROL, "public, max-age=86400")], body).into_response()
}

async fn login(State(codes): State<Codes>, headers: HeaderMap, body: Bytes) -> Response {
    if !signed(&headers, &body) {
        return error(StatusCode::UNAUTHORIZED, "bad_signature");
    }
    let Ok(req) = serde_json::from_slice::<Login>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request");
    };
    if !req.email.contains('@') {
        return error(StatusCode::BAD_REQUEST, "bad_email");
    }
    let mut codes = codes.lock().unwrap_or_else(PoisonError::into_inner);
    match req.code {
        None => match new_code() {
            Ok(code) => {
                codes.insert(req.email, code);
                Json(json!({ "status": "code_sent" })).into_response()
            }
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "no_entropy"),
        },
        Some(code) if codes.get(&req.email) == Some(&code) => {
            codes.remove(&req.email);
            Json(json!({
                "status": "ok",
                "token": marked("token", &uuid::Uuid::new_v4().to_string()),
                "message": marked("message", "welcome"),
                "image": marked("image", "probe.png"),
            }))
            .into_response()
        }
        Some(_) => error(StatusCode::UNAUTHORIZED, "bad_code"),
    }
}

/// Test helper standing in for the mailbox: returns the code "sent" to an email.
async fn debug_code(State(codes): State<Codes>, Query(q): Query<CodeQuery>) -> Response {
    match codes.lock().unwrap_or_else(PoisonError::into_inner).get(&q.email) {
        Some(code) => Json(json!({ "code": code })).into_response(),
        None => error(StatusCode::NOT_FOUND, "no_code"),
    }
}

async fn ws_loop(mut socket: WebSocket) {
    while let Some(Ok(msg)) = socket.recv().await {
        let Message::Text(text) = msg else { continue };
        let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
        if frame["type"] == "ping" {
            let pong = json!({ "type": "pong", "n": frame["n"] }).to_string();
            if socket.send(Message::Text(pong.into())).await.is_err() {
                return;
            }
        }
    }
}

/// The full router; state is per instance.
pub fn router() -> Router {
    Router::new()
        .route("/ping", get(|| async { Json(json!({ "pong": true })) }))
        .route("/echo", post(|Json(v): Json<Value>| async move { Json(v) }))
        .route("/login", post(login))
        .route("/debug/code", get(debug_code))
        .route("/image/{name}", get(image))
        .route("/ws", get(|up: WebSocketUpgrade| async move { up.on_upgrade(ws_loop) }))
        .with_state(Codes::default())
}

/// A running server instance on loopback.
#[derive(Debug)]
pub struct Running {
    addr: SocketAddr,
    stop: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}

impl Running {
    /// Base URL, e.g. `http://127.0.0.1:<port>`.
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Stops the server and waits for it to finish.
    ///
    /// # Errors
    /// I/O error reported by the server task.
    pub async fn stop(self) -> std::io::Result<()> {
        let _ = self.stop.send(());
        self.task.await.map_err(std::io::Error::other)?
    }
}

/// Starts the server. With port 0 the OS picks the port; the socket is listening on return.
///
/// # Errors
/// The address could not be bound.
pub async fn start(listen: SocketAddr) -> std::io::Result<Running> {
    let listener = TcpListener::bind(listen).await?;
    let addr = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, router())
            .with_graceful_shutdown(async move {
                drop(stopped.await);
            })
            .await
    });
    Ok(Running { addr, stop, task })
}
