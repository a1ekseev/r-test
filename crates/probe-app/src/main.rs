//! Tauri shell: window, tray, single instance. All logic lives in `probe-core`.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("feature `e2e` (embedded WebDriver server) must never be enabled in a release build");

mod commands;
mod setup;
#[cfg(test)]
mod tests;

use tauri::Emitter as _;

fn main() {
    let url = std::env::var("PROBE_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:4000".to_owned());
    let memory = std::env::var("PROBE_SECRET_STORE").is_ok_and(|v| v == "memory");
    let state = setup::AppState::new(&url, memory).expect("client setup");

    // Must be the first plugin: a second launch exits here and notifies the running instance.
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        println!("PROBE_SECOND_INSTANCE");
        drop(app.emit("second-instance", ()));
        // a second launch can also ask the running instance to leave, without any WebDriver
        if args.iter().any(|arg| arg == "--quit") {
            app.exit(0);
        } else if args.iter().any(|arg| arg == "--terminate") {
            setup::terminate(app);
        }
    }));
    let builder = setup::configure(builder, state).setup(|app| {
        // only the first instance gets here, and the webview does not exist yet: dumps left by a
        // run that did not reach its own exit
        setup::clean_crash_reports_if_asked("start");
        setup::create_window(app)?;
        setup::install_tray(app)?;
        Ok(())
    });
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder.build(tauri::generate_context!()).expect("build the application").run(|_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            setup::clean_crash_reports_if_asked("exit");
        }
    });
}
