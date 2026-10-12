//! Commands on the Tauri mock runtime: no window, no display, no server.

use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

fn invoke(cmd: &str, body: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
    // port 1 is closed: commands that reach for the server get a refused connection
    let state = crate::setup::AppState::new("http://127.0.0.1:1", true).unwrap();
    let app = crate::setup::configure(mock_builder(), state).build(mock_context(noop_assets())).unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default()).build().unwrap();
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        // the local webview origin differs per OS
        url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
        body: InvokeBody::Json(body),
        headers: tauri::http::HeaderMap::default(),
        invoke_key: INVOKE_KEY.to_owned(),
    };
    get_ipc_response(&webview, request).map(|body| match body {
        InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
        InvokeResponseBody::Raw(_) => serde_json::Value::Null,
    })
}

#[test]
fn status_reports_version_and_unreachable_server() {
    let status = invoke("status", serde_json::json!({})).unwrap();
    assert_eq!(status["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(status["arch"], std::env::consts::ARCH);
    assert_eq!(status["server"], false);
}

#[test]
fn request_code_requires_an_email_argument() {
    let err = invoke("request_code", serde_json::json!({})).unwrap_err();
    assert!(err.to_string().contains("email"), "{err}");
}

#[test]
fn unreachable_server_becomes_an_error_code_not_a_panic() {
    let err = invoke("request_code", serde_json::json!({ "email": "user@example.com" })).unwrap_err();
    assert_eq!(err, "network");
}

#[test]
fn unknown_command_is_rejected() {
    let err = invoke("no_such_command", serde_json::json!({})).unwrap_err();
    assert!(err.to_string().contains("not found"), "{err}");
}
