//! Tauri shell: builder assembly, startup wiring, tray and IPC registration.
//!
//! Domain logic lives in the sibling packages (`agent`, `knowledge`, `media`,
//! `llm`, `workspace`, `infra`); this package only owns the desktop
//! lifecycle and the window/tray plumbing.

mod commands;
mod setup;
mod tray;

use tauri::Emitter;

/// Run the desktop application (called by the crate root).
pub(crate) fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Required state for resolving bundled sidecar binaries (ffmpeg).
        .plugin(tauri_plugin_shell::init())
        // Native folder picker behind the data-directory relocation UI.
        .plugin(tauri_plugin_dialog::init())
        // Signed seamless updates (latest.json + minisign); the commands in
        // infra/updater.rs drive the plugin through the app's own proxy routing.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // System-wide Ctrl+K: reveal the window and open the command palette
        // even when the app is not focused. The frontend listens for the
        // `palette-open` event and toggles its panel accordingly.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["CommandOrControl+K"])
                .expect("failed to register global shortcut Ctrl+K")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        tray::reveal_main(app);
                        let _ = app.emit("palette-open", ());
                    }
                })
                .build(),
        )
        .setup(setup::setup)
        // Closing the window hides it to the tray instead of exiting — the
        // app keeps running in the background (global hotkey + tray remain
        // live). Real exit only via the tray menu's 退出 MindBase.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    // Stop the local ASR server we spawned (no-op if the user ran one
    // manually or none was started).
    crate::media::whisper_server::shutdown();
}
