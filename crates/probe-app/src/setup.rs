//! Application wiring shared by the real runtime and the mock runtime used in unit tests.

use std::sync::Arc;

use probe_core::store::{MemoryStore, OsKeyring, SecretStore};

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

pub(crate) fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>, state: AppState) -> tauri::Builder<R> {
    builder.manage(state).invoke_handler(tauri::generate_handler![
        commands::status,
        commands::request_code,
        commands::confirm_code,
        commands::frontend_ready,
        commands::report_problem,
    ])
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
