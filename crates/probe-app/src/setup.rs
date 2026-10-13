//! Application wiring shared by the real runtime and the mock runtime used in unit tests.

use std::sync::Arc;

use probe_core::store::{MemoryStore, OsKeyring, SecretStore};
use tauri::Manager as _;
use tauri::http::Response;

use crate::commands;

/// Everything the commands need.
pub(crate) struct AppState {
    pub(crate) client: probe_core::Client,
    pub(crate) store: Arc<dyn SecretStore>,
}

impl AppState {
    pub(crate) fn new(server_url: &str, memory_store: bool) -> Result<Self, probe_core::Error> {
        let store: Arc<dyn SecretStore> =
            if memory_store { Arc::new(MemoryStore::default()) } else { Arc::new(OsKeyring::new("probe-demo")) };
        Ok(Self { client: probe_core::Client::new(server_url, b"")?, store })
    }
}

/// True when the environment variable is set to `1`.
pub(crate) fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

pub(crate) fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>, state: AppState) -> tauri::Builder<R> {
    builder
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::request_code,
            commands::confirm_code,
            commands::frontend_ready,
            commands::report_problem,
        ])
        // `probe://localhost/<name>`: an image fetched from the demo server by the Rust side
        .register_asynchronous_uri_scheme_protocol("probe", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let name = request.uri().path().trim_start_matches('/');
                let response = match app.state::<AppState>().client.image(name).await {
                    Ok(bytes) => Response::builder()
                        .header("content-type", "image/png")
                        .header("cache-control", "public, max-age=86400")
                        .body(bytes),
                    Err(_) => Response::builder().status(502).body(Vec::new()),
                };
                if let Ok(response) = response {
                    responder.respond(response);
                }
            });
        })
}

/// Creates the main window from the config. Switches read from the environment, so that one
/// binary can be observed in every mode: `PROBE_INCOGNITO=1`, `PROBE_BROWSER_ARGS=<args>`
/// (WebView2 only; replaces the default arguments), `PROBE_DATA_DIR=<absolute path>` (webview data
/// directory, not on macOS), `PROBE_RESTORABLE=0` (macOS only).
pub(crate) fn create_window(app: &tauri::App) -> tauri::Result<()> {
    let mut config = app.config().app.windows.first().cloned().unwrap_or_default();
    config.incognito = flag("PROBE_INCOGNITO");
    if let Ok(args) = std::env::var("PROBE_BROWSER_ARGS") {
        config.additional_browser_args = Some(args);
    }
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    if let Ok(dir) = std::env::var("PROBE_DATA_DIR") {
        builder = builder.data_directory(dir.into());
    }
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    if std::env::var("PROBE_RESTORABLE").is_ok_and(|v| v == "0") {
        let ns_window: *mut objc2::runtime::AnyObject = window.ns_window()?.cast();
        // SAFETY: a live NSWindow, messaged on the main thread (setup runs there)
        unsafe {
            let () = objc2::msg_send![ns_window, setRestorable: false];
        }
    }
    drop(window);
    println!("PROBE_WINDOW incognito={}", config.incognito);
    Ok(())
}

/// Leaves the way Cmd+Q does on macOS, through `-[NSApplication terminate:]`.
#[cfg(target_os = "macos")]
pub(crate) fn terminate(app: &tauri::AppHandle) {
    drop(app.run_on_main_thread(|| {
        use objc2::runtime::AnyObject;
        // SAFETY: plain AppKit messages, sent on the main thread
        unsafe {
            let ns_app: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
            let () = objc2::msg_send![ns_app, terminate: std::ptr::null_mut::<AnyObject>()];
        }
    }));
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn terminate(app: &tauri::AppHandle) {
    app.exit(0);
}

/// macOS apps of this kind live in the Dock, so the tray is used on Windows and Linux only.
#[cfg(target_os = "macos")]
pub(crate) fn install_tray(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    let mut tray = tauri::tray::TrayIconBuilder::new().tooltip("Probe").menu(&menu).on_menu_event(|app, event| {
        if event.id.as_ref() == "quit" {
            app.exit(0);
        }
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    println!("PROBE_TRAY installed");
    Ok(())
}
