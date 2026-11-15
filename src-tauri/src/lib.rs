pub mod commands;
pub mod db;
pub mod engine;
pub mod native_messaging;
pub mod state;
pub mod updater;
pub mod video;

#[cfg(not(test))]
use crate::commands::*;
#[cfg(not(test))]
use crate::db::Database;
#[cfg(not(test))]
use crate::engine::DownloadManager;
#[cfg(not(test))]
use crate::state::AppState;
#[cfg(not(test))]
use std::sync::Arc;
#[cfg(not(test))]
use tauri::{Emitter, Manager};

#[cfg(not(test))]
pub fn run() {
    let mut builder = tauri::Builder::default();

    builder = builder.setup(|app| {
        let app_handle = app.handle().clone();

        // Database directory in local app data (%LOCALAPPDATA%\mdm)
        let app_data_dir = match std::env::var("LOCALAPPDATA") {
            Ok(local) => std::path::PathBuf::from(local).join("mdm"),
            Err(_) => app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap().join("data")),
        };

        std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");
        let db_path = app_data_dir.join("mdm_v1.db");

        let bin_dir = app_data_dir.join("bin");
        let _ = std::fs::create_dir_all(&bin_dir);

        let database = Arc::new(Database::new(db_path).expect("Failed to initialize SQLite database"));
        let _ = database.reconcile_on_startup();

        let mut engine = DownloadManager::new(Arc::clone(&database), 3);
        let app_h = app_handle.clone();
        engine.set_progress_emitter(Arc::new(move |event, payload| {
            let _ = app_h.emit(event, payload);
        }));
        let engine_arc = Arc::new(engine);

        let mut video_engine = crate::video::VideoManager::new(Arc::clone(&database), bin_dir);
        let app_h_video = app_handle.clone();
        video_engine.set_progress_emitter(Arc::new(move |event, payload| {
            let _ = app_h_video.emit(event, payload);
        }));
        let video_engine_arc = Arc::new(video_engine);

        // Start Windows Named Pipe IPC server for Chromium extension communication
        crate::native_messaging::ipc::start_ipc_server(
            app_handle.clone(),
            Arc::clone(&engine_arc),
            Arc::clone(&video_engine_arc),
            Arc::clone(&database),
        );

        // Automatically ensure Native Messaging Host is registered for current installation
        if !crate::native_messaging::registry::verify_native_host_registration() {
            let _ = crate::native_messaging::registry::register_native_host(None);
        }

        // Resume/process any queued downloads from database
        let engine_startup = Arc::clone(&engine_arc);
        tauri::async_runtime::spawn(async move {
            engine_startup.process_queue().await;
        });

        // Background GitHub release update check on startup
        let update_app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            if let Ok(info) = crate::updater::check_app_update().await {
                if info.update_available {
                    let _ = update_app_handle.emit("app-update-available", &info);
                }
            }
        });

        // Setup System Tray icon (IDM style background operation)
        if let Some(icon) = app.default_window_icon() {
            let show_i = tauri::menu::MenuItem::with_id(app, "show", "Mak Download Manager'ı Aç", true, None::<&str>)?;
            let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(app, &[&show_i, &quit_i])?;

            let _ = tauri::tray::TrayIconBuilder::new()
                .icon(icon.clone())
                .tooltip("Mak Download Manager (MDM)")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "show" {
                        let _ = app.emit("open-dashboard", ());
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.set_title("Mak Download Manager (MDM)");
                            let _ = main_win.set_always_on_top(false);
                            let _ = main_win.set_size(tauri::LogicalSize::new(1150.0, 740.0));
                            let _ = main_win.center();
                            let _ = main_win.show();
                            let _ = main_win.unminimize();
                            let _ = main_win.set_focus();
                        }
                    } else if event.id().as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let _ = app.emit("open-dashboard", ());
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.set_title("Mak Download Manager (MDM)");
                            let _ = main_win.set_always_on_top(false);
                            let _ = main_win.set_size(tauri::LogicalSize::new(1150.0, 740.0));
                            let _ = main_win.center();
                            let _ = main_win.show();
                            let _ = main_win.unminimize();
                            let _ = main_win.set_focus();
                        }
                    }
                })
                .build(app);
        }

        app.manage(AppState {
            db: database,
            engine: engine_arc,
            video_engine: video_engine_arc,
        });

        Ok(())
    });

    builder = builder.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("window-close-requested", ());
                let _ = window.set_always_on_top(false);
                let _ = window.hide();
            }
        }
    });

    builder
        .invoke_handler(tauri::generate_handler![
            get_downloads,
            add_download,
            add_download_with_options,
            probe_download_info,
            pause_download,
            resume_download,
            cancel_download,
            retry_download,
            remove_download,
            get_engine_stats,
            get_settings,
            update_settings,
            set_speed_limit,
            pick_folder,
            open_file_location,
            open_file,
            probe_video_info,
            add_video_download,
            get_tool_status,
            install_or_update_ytdlp,
            check_pending_confirm,
            close_compact_dialog,
            check_app_update,
            install_app_update
        ])
        .run(tauri::generate_context!())
        .expect("Error while running Mak Download Manager application");
}
