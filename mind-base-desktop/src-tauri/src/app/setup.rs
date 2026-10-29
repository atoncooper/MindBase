//! Startup wiring: open the database, seed logging/prompts, cache the ffmpeg
//! path, load the egress-proxy snapshot, build the tray and warm up local ASR.

use tauri::Manager;

/// Tauri `setup` hook — runs once before the first window command is served.
pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Open the SQLite database under the active data dir (pointer file may
    // redirect it) and share it as managed state. Fail fast: without the data
    // layer the app has no usable feature set.
    let db = crate::infra::db::init(app.handle())?;
    // Initialise the file logger under the active data dir so ASR and pipeline
    // failures can be inspected on disk, and seed the editable agent-prompt
    // defaults (<data>/prompts/**.md).
    if let Ok(dir) = db.data_dir.lock() {
        crate::infra::logging::init(&dir);
        crate::agent::prompts::seed_defaults(&dir);
    }
    // Cache the ffmpeg binary for vision-attachment downscaling (resolved with
    // the user's override from the stored config).
    if let Ok(conn) = db.conn.lock() {
        let override_path = crate::infra::config::load(&conn)
            .ok()
            .and_then(|cfg| cfg.ffmpeg_path_override);
        drop(conn);
        crate::media::ffmpeg::cache_ffmpeg_path(app.handle(), override_path.as_deref());
    }
    // Seed the process-wide egress-proxy snapshot from the stored config so
    // outbound requests route correctly from the first use.
    if let Ok(conn) = db.conn.lock() {
        crate::llm::api_keys::refresh_proxy_setting(&conn);
    }
    app.manage(db);
    // Parked signed update (checked → awaiting user confirmation).
    app.manage(crate::infra::updater::PendingUpdate::default());
    crate::infra::logging::info("main", "MindBase desktop started");

    // Local ASR mode: warm the server up at startup (installs deps and
    // downloads the model on first use). Runs off the startup path; ingestion
    // re-checks and retries when it actually runs.
    crate::media::whisper_server::startup_spawn(app.handle());

    // System tray: closing the window hides to tray (see app/mod.rs); the tray
    // is the way back and the only exit.
    crate::app::tray::build(app)?;
    Ok(())
}
