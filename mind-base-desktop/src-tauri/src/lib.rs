mod agents;
mod api_keys;
mod asr;
mod bilibili;
mod chat;
mod chunker;
mod config;
mod db;
mod embeddings;
mod ffmpeg;
mod file_ingest;
mod harness;
mod ingest;
mod llm_chat;
mod logging;
mod media_cache;
mod notes;
mod ocr_server;
mod python_runtime;
mod quiz;
mod resume;
mod slides;
mod skills;
mod updater;
mod vectors;
mod wbi;
mod web_capture;
mod whisper_server;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Show / un-minimize / focus the main window (tray click & global hotkey).
fn reveal_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Required state for resolving bundled sidecar binaries (ffmpeg).
        .plugin(tauri_plugin_shell::init())
        // Native folder picker behind the data-directory relocation UI.
        .plugin(tauri_plugin_dialog::init())
        // System-wide Ctrl+K: reveal the window and open the command palette
        // even when the app is not focused. The frontend listens for the
        // `palette-open` event and toggles its panel accordingly.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["CommandOrControl+K"])
                .expect("failed to register global shortcut Ctrl+K")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        reveal_main(app);
                        let _ = app.emit("palette-open", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Open the SQLite database under the active data dir (pointer
            // file may redirect it) and share it as managed state. Fail
            // fast: without the data layer the app has no usable feature
            // set.
            let db = db::init(app.handle())?;
            // Initialise the file logger under the active data dir so ASR and
            // pipeline failures can be inspected on disk.
            if let Ok(dir) = db.data_dir.lock() {
                logging::init(&dir);
            }
            app.manage(db);
            logging::info("main", "MindBase desktop started");

            // Local ASR mode: warm the server up at startup (installs deps
            // and downloads the model on first use). Runs off the startup
            // path; ingestion re-checks and retries when it actually runs.
            whisper_server::startup_spawn(app.handle());

            // System tray: closing the window hides to tray (see
            // on_window_event); the tray is the way back and the only exit.
            let show = MenuItem::with_id(app, "tray-show", "显示 MindBase", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray-quit", "退出 MindBase", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("app icon missing").clone())
                .tooltip("MindBase")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => reveal_main(app),
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        reveal_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Closing the window hides it to the tray instead of exiting — the
        // app keeps running in the background (global hotkey + tray remain
        // live). Real exit only via the tray menu's 退出 MindBase.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            api_keys::list_api_keys,
            api_keys::save_provider_config,
            api_keys::clear_provider_key,
            api_keys::test_provider_config,
            config::get_config,
            config::set_config,
            db::get_data_dir,
            db::set_data_dir,
            db::reset_data_dir,
            ffmpeg::ffmpeg_status,
            updater::check_update,
            updater::download_update,
            updater::run_update_installer,
            vectors::get_vector_stats,
            vectors::upsert_doc_chunks,
            vectors::search_vectors,
            vectors::delete_doc_vectors,
            bilibili::bili_session_status,
            bilibili::bili_logout,
            bilibili::login::bili_qr_generate,
            bilibili::login::bili_qr_poll,
            bilibili::login::bili_session_verify,
            bilibili::favorites::bili_list_folders,
            bilibili::favorites::bili_list_folder_videos,
            bilibili::favorites::bili_video_pages,
            whisper_server::local_asr_model_status,
            whisper_server::local_asr_model_download,
            ocr_server::local_ocr_model_status,
            ocr_server::local_ocr_model_download,
            ingest::ingest_video,
            ingest::delete_document,
            ingest::list_documents,
            ingest::search_knowledge,
            file_ingest::scan_import_paths,
            file_ingest::ingest_files,
            web_capture::capture_urls,
            chat::chat_sessions_list,
            chat::chat_session_create,
            chat::chat_session_rename,
            chat::chat_session_delete,
            chat::chat_history,
            chat::chat_ask,
            chat::stop_chat,
            notes::notes_list,
            notes::note_create,
            notes::note_get,
            notes::note_update,
            notes::note_save,
            notes::note_rename,
            notes::note_delete,
            notes::note_toggle_pin,
            notes::revisions_list,
            notes::revision_get,
            notes::revision_restore,
            notes::anchor_add,
            notes::anchor_delete,
            quiz::quiz_source_chunks,
            quiz::quiz_generate,
            quiz::quiz_grade,
            quiz::quiz_set_create,
            quiz::quiz_set_list,
            quiz::quiz_set_get,
            quiz::quiz_set_save_answers,
            quiz::quiz_set_finish,
            quiz::quiz_set_delete,
            resume::exports_list,
            harness::harness_health,
            chat::chat_summarize,
            chat::chat_summary_get,
            skills::skills_list,
            skills::skills_set_enabled,
            skills::skills_open_dir,
            skills::skills_install_from_path,
            skills::skills_install_zip,
            skills::skills_store_search,
            skills::skills_store_install,
            skills::skills_uninstall,
            api_keys::set_default_provider,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    // Stop the local ASR server we spawned (no-op if the user ran one
    // manually or none was started).
    whisper_server::shutdown();
}
