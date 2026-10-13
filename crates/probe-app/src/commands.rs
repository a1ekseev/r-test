//! IPC commands: thin adapters over `probe-core`. Lines starting with `PROBE_` on stdout are
//! markers read by the launch check.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::setup::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    version: &'static str,
    arch: &'static str,
    os: String,
    hostname: String,
    timezone: String,
    /// Whether the demo server answered `/ping`.
    server: bool,
    /// Address of the demo server: the frontend loads one image straight from it.
    server_url: String,
    /// Whether the window was created in incognito mode.
    incognito: bool,
}

#[tauri::command]
pub(crate) async fn status(state: State<'_, AppState>) -> Result<Status, String> {
    let device = probe_core::device();
    Ok(Status {
        version: env!("CARGO_PKG_VERSION"),
        arch: std::env::consts::ARCH,
        os: device.os,
        hostname: device.hostname,
        timezone: device.timezone,
        server: state.client.ping().await.is_ok(),
        server_url: state.client.base_url().to_owned(),
        incognito: crate::setup::flag("PROBE_INCOGNITO"),
    })
}

#[tauri::command]
pub(crate) async fn request_code(state: State<'_, AppState>, email: String) -> Result<(), String> {
    state.client.request_code(&email).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub(crate) struct Session {
    /// The token was written to the secret store and read back unchanged.
    stored: bool,
    /// Counter echoed by the WebSocket pong.
    pong: u64,
    /// Text sent by the server for display.
    message: String,
    /// Name of the image to display.
    image: String,
}

#[tauri::command]
pub(crate) async fn confirm_code(state: State<'_, AppState>, email: String, code: String) -> Result<Session, String> {
    let probe_core::Login { token, message, image } =
        state.client.confirm_code(&email, &code).await.map_err(|e| e.to_string())?;
    let store = Arc::clone(&state.store);
    // keyring backends block (and some drive their own runtime): keep them off the async executor
    let stored = tauri::async_runtime::spawn_blocking(move || {
        store.set("session", token.as_bytes())?;
        Ok::<_, probe_core::store::StoreError>(store.get("session")?.as_deref() == Some(token.as_bytes()))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("store: {e}"))?;
    let pong = state.client.ws_ping(7).await.map_err(|e| e.to_string())?;
    Ok(Session { stored, pong, message, image })
}

/// Called once by the frontend after it has rendered and fonts have loaded.
#[tauri::command]
pub(crate) fn frontend_ready(problems: Vec<String>) {
    for problem in &problems {
        println!("PROBE_PROBLEM {problem}");
    }
    println!("PROBE_READY problems={}", problems.len());
}

/// CSP violations and uncaught errors seen by the frontend after it reported ready.
#[tauri::command]
pub(crate) fn report_problem(detail: String) {
    println!("PROBE_PROBLEM {detail}");
}
