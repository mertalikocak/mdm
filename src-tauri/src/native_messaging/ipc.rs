use crate::db::Database;
use crate::engine::task::AppSettings;
use crate::engine::DownloadManager;
use crate::native_messaging::{ExtensionRequest, ExtensionResponse, PROTOCOL_VERSION};
use crate::video::VideoManager;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const IPC_PIPE_NAME: &str = r"\\.\pipe\mdm_ipc";
pub const IPC_TCP_ADDR: &str = "127.0.0.1:47990";

#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

/// Starts the IPC listener inside the running MDM desktop application.
/// Listens on both Localhost TCP (127.0.0.1:47990) and Windows Named Pipe.
pub fn start_ipc_server(
    app_handle: AppHandle,
    engine: Arc<DownloadManager>,
    video_engine: Arc<VideoManager>,
    db: Arc<Database>,
) {
    // 1. TCP Listener on 127.0.0.1:47990 (Immune to Windows Named Pipe DACL & sandbox permissions)
    {
        let app_h = app_handle.clone();
        let engine_clone = Arc::clone(&engine);
        let video_clone = Arc::clone(&video_engine);
        let db_clone = Arc::clone(&db);

        tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::bind(IPC_TCP_ADDR).await {
                Ok(listener) => {
                    loop {
                        match listener.accept().await {
                            Ok((socket, _)) => {
                                let eng = Arc::clone(&engine_clone);
                                let vid = Arc::clone(&video_clone);
                                let d = Arc::clone(&db_clone);
                                let app = app_h.clone();
                                tauri::async_runtime::spawn(async move {
                                    handle_tcp_ipc_client(socket, eng, vid, d, app).await;
                                });
                            }
                            Err(e) => {
                                eprintln!("[MDM TCP IPC Server] Accept error: {}", e);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[MDM TCP IPC Server] Could not bind to {}: {}", IPC_TCP_ADDR, e);
                }
            }
        });
    }

    // 2. Windows Named Pipe Listener
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn(async move {
            let mut is_first = true;
            loop {
                let server = match ServerOptions::new()
                    .first_pipe_instance(is_first)
                    .create(IPC_PIPE_NAME)
                {
                    Ok(s) => {
                        is_first = false;
                        s
                    }
                    Err(e) => {
                        eprintln!("[MDM IPC Server] Failed to create named pipe: {}", e);
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                };

                // Wait for an incoming client connection
                if let Err(e) = server.connect().await {
                    eprintln!("[MDM IPC Server] Client connect error: {}", e);
                    continue;
                }

                let engine_clone = Arc::clone(&engine);
                let video_clone = Arc::clone(&video_engine);
                let db_clone = Arc::clone(&db);
                let app_h = app_handle.clone();

                tauri::async_runtime::spawn(async move {
                    handle_ipc_client(server, engine_clone, video_clone, db_clone, app_h).await;
                });
            }
        });
    }

    #[cfg(not(windows))]
    {
        let _ = (app_handle, engine, video_engine, db);
    }
}

#[cfg(windows)]
async fn handle_ipc_client(
    mut stream: tokio::net::windows::named_pipe::NamedPipeServer,
    engine: Arc<DownloadManager>,
    video_engine: Arc<VideoManager>,
    db: Arc<Database>,
    app_handle: AppHandle,
) {
    // Read 4-byte little-endian length prefix
    let mut len_buf = [0u8; 4];
    if stream.read_exact(&mut len_buf).await.is_err() {
        return;
    }
    let msg_len = u32::from_le_bytes(len_buf) as usize;
    if msg_len == 0 || msg_len > crate::native_messaging::MAX_MESSAGE_SIZE {
        return;
    }

    let mut body = vec![0u8; msg_len];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }

    let req_res: Result<ExtensionRequest, _> = serde_json::from_slice(&body);
    let resp = match req_res {
        Ok(req) => process_ipc_request(req, engine, video_engine, db, &app_handle).await,
        Err(e) => ExtensionResponse::Error {
            code: "PARSE_ERROR".to_string(),
            message: format!("Geçersiz IPC mesajı: {}", e),
        },
    };

    let resp_bytes = match serde_json::to_vec(&resp) {
        Ok(b) => b,
        Err(e) => {
            let err_json = serde_json::json!({
                "type": "error",
                "code": "SERIALIZE_ERROR",
                "message": e.to_string()
            });
            serde_json::to_vec(&err_json).unwrap_or_default()
        }
    };

    let resp_len = (resp_bytes.len() as u32).to_le_bytes();
    let _ = stream.write_all(&resp_len).await;
    let _ = stream.write_all(&resp_bytes).await;
    let _ = stream.flush().await;
}

async fn handle_tcp_ipc_client(
    mut stream: tokio::net::TcpStream,
    engine: Arc<DownloadManager>,
    video_engine: Arc<VideoManager>,
    db: Arc<Database>,
    app_handle: AppHandle,
) {
    let mut len_buf = [0u8; 4];
    if stream.read_exact(&mut len_buf).await.is_err() {
        return;
    }
    let msg_len = u32::from_le_bytes(len_buf) as usize;
    if msg_len == 0 || msg_len > crate::native_messaging::MAX_MESSAGE_SIZE {
        return;
    }

    let mut body = vec![0u8; msg_len];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }

    let req_res: Result<ExtensionRequest, _> = serde_json::from_slice(&body);
    let resp = match req_res {
        Ok(req) => process_ipc_request(req, engine, video_engine, db, &app_handle).await,
        Err(e) => ExtensionResponse::Error {
            code: "PARSE_ERROR".to_string(),
            message: format!("Geçersiz IPC mesajı: {}", e),
        },
    };

    let resp_bytes = match serde_json::to_vec(&resp) {
        Ok(b) => b,
        Err(e) => {
            let err_json = serde_json::json!({
                "type": "error",
                "code": "SERIALIZE_ERROR",
                "message": e.to_string()
            });
            serde_json::to_vec(&err_json).unwrap_or_default()
        }
    };

    let resp_len = (resp_bytes.len() as u32).to_le_bytes();
    let _ = stream.write_all(&resp_len).await;
    let _ = stream.write_all(&resp_bytes).await;
    let _ = stream.flush().await;
}

fn bring_dialog_window_to_front(app_handle: &AppHandle) {
    if let Some(main_win) = app_handle.get_webview_window("main") {
        let _ = main_win.set_title("Dosya İndirme Bilgisi");
        let _ = main_win.show();
        let _ = main_win.unminimize();
        let _ = main_win.set_size(tauri::LogicalSize::new(520.0, 340.0));
        let _ = main_win.center();
        let _ = main_win.set_always_on_top(true);
        let _ = main_win.set_focus();
    }
}

pub async fn process_ipc_request(
    req: ExtensionRequest,
    _engine: Arc<DownloadManager>,
    video_engine: Arc<VideoManager>,
    db: Arc<Database>,
    app_handle: &AppHandle,
) -> ExtensionResponse {
    match req {
        ExtensionRequest::Ping => ExtensionResponse::Pong {
            version: PROTOCOL_VERSION.to_string(),
            mdm_app_running: true,
        },
        ExtensionRequest::AddDownload {
            url,
            filename,
            destination_dir,
            referrer,
            cookies,
            user_agent,
        } => {
            // 1. Validate URL scheme
            let parsed = match url::Url::parse(&url) {
                Ok(u) => u,
                Err(_) => {
                    return ExtensionResponse::Error {
                        code: "INVALID_URL".to_string(),
                        message: "Geçersiz web adresi.".to_string(),
                    };
                }
            };

            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return ExtensionResponse::Error {
                    code: "UNSUPPORTED_SCHEME".to_string(),
                    message: "Yalnızca HTTP ve HTTPS indirmeleri desteklenir.".to_string(),
                };
            }

            // 2. Duplicate check in active queue
            if let Ok(tasks) = db.list_tasks() {
                if let Some(existing) = tasks.iter().find(|t| {
                    t.url == url
                        && (t.status == crate::engine::task::DownloadStatus::Downloading
                            || t.status == crate::engine::task::DownloadStatus::Queued
                            || t.status == crate::engine::task::DownloadStatus::Probing)
                }) {
                    return ExtensionResponse::DuplicateIgnored {
                        task_id: existing.id.clone(),
                        filename: existing.filename.clone(),
                        message: "Bu bağlantı zaten aktif indirme kuyruğunda yer alıyor.".to_string(),
                    };
                }
            }

            // 3. Resolve and validate destination directory
            let settings = if let Ok(Some(s)) = db.get_setting("app_settings") {
                serde_json::from_str::<AppSettings>(&s).unwrap_or_default()
            } else {
                AppSettings::default()
            };

            let target_dir = match destination_dir {
                Some(ref d) => {
                    let p = std::path::Path::new(d);
                    if p.is_dir() {
                        d.clone()
                    } else {
                        settings.default_download_dir
                    }
                }
                None => settings.default_download_dir,
            };
            let segments = settings.default_segments;

            let payload = serde_json::json!({
                "url": url,
                "filename": filename.clone(),
                "destination_dir": target_dir,
                "segments": segments,
                "referrer": referrer,
                "cookies": cookies,
                "user_agent": user_agent,
            });

            bring_dialog_window_to_front(app_handle);
            let _ = app_handle.emit("open-download-confirm", &payload);

            let display_filename = filename.unwrap_or_else(|| {
                url.split('/').last().unwrap_or("dosya").to_string()
            });

            ExtensionResponse::DownloadAdded {
                task_id: String::new(),
                filename: display_filename,
                status: "dialog_opened".to_string(),
            }
        }
        ExtensionRequest::ProbeVideo {
            url,
            referrer,
            cookies,
            user_agent,
            title,
        } => {
            // Open compact video modal immediately; AddDownloadModal performs async video analysis
            bring_dialog_window_to_front(app_handle);

            let payload = serde_json::json!({
                "url": url,
                "mode": "video",
                "referrer": referrer,
                "cookies": cookies,
                "user_agent": user_agent,
                "filename": title.clone(),
            });
            let _ = app_handle.emit("open-download-confirm", &payload);

            ExtensionResponse::DownloadAdded {
                task_id: String::new(),
                filename: title.unwrap_or_else(|| "Video".to_string()),
                status: "dialog_opened".to_string(),
            }
        }
        ExtensionRequest::AddVideoDownload {
            url,
            title,
            format_spec,
            extension,
            is_audio_only,
            destination_dir,
        } => {
            let settings = if let Ok(Some(s)) = db.get_setting("app_settings") {
                serde_json::from_str::<AppSettings>(&s).unwrap_or_default()
            } else {
                AppSettings::default()
            };
            let target_dir = destination_dir.unwrap_or(settings.default_download_dir);
            let clean_name = crate::engine::probe::sanitize_filename(&title);
            let filename = format!("{}.{}", clean_name, extension);
            let final_dest =
                crate::engine::probe::get_collision_free_path(&target_dir, &filename);
            let task_id = uuid::Uuid::new_v4().to_string();

            let task = crate::engine::task::DownloadTask {
                id: task_id.clone(),
                url,
                filename: filename.clone(),
                destination_path: final_dest,
                total_bytes: None,
                downloaded_bytes: 0,
                speed_bytes_per_sec: 0,
                eta_seconds: None,
                status: crate::engine::task::DownloadStatus::Queued,
                error_message: None,
                supports_range: false,
                segment_count: 1,
                segments: Vec::new(),
                etag: Some(format!(
                    "video:{}:{}",
                    if is_audio_only { "audio" } else { "video" },
                    format_spec
                )),
                last_modified: None,
                created_at: chrono::Utc::now(),
                completed_at: None,
                cookies: None,
                referrer: None,
                user_agent: None,
            };

            if let Err(e) = db.insert_or_update_task(&task) {
                return ExtensionResponse::Error {
                    code: "DB_ERROR".to_string(),
                    message: format!("Video görevi eklenemedi: {}", e),
                };
            }

            let _ = app_handle.emit("download-status-changed", &task_id);

            // Trigger video engine to start
            let ve = Arc::clone(&video_engine);
            let tid = task_id.clone();
            tauri::async_runtime::spawn(async move {
                let _ = ve.start_video_download(tid, format_spec, is_audio_only).await;
            });

            ExtensionResponse::VideoDownloadAdded {
                task_id,
                filename,
                status: "queued".to_string(),
            }
        }
        ExtensionRequest::OpenMdmApp => {
            let app_data_dir = match std::env::var("LOCALAPPDATA") {
                Ok(local) => std::path::PathBuf::from(local).join("mdm"),
                Err(_) => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
            };
            let pending_confirm_path = app_data_dir.join("pending_confirm.json");
            if pending_confirm_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&pending_confirm_path) {
                    let _ = std::fs::remove_file(&pending_confirm_path);
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                        bring_dialog_window_to_front(app_handle);
                        let _ = app_handle.emit("open-download-confirm", &parsed);
                        return ExtensionResponse::AppOpened { success: true };
                    }
                }
            }

            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = app_handle.emit("open-dashboard", ());
                let _ = window.set_title("Mak Download Manager (MDM)");
                let _ = window.set_always_on_top(false);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_size(tauri::LogicalSize::new(1150.0, 740.0));
                let _ = window.center();
                let _ = window.set_focus();
                ExtensionResponse::AppOpened { success: true }
            } else {
                ExtensionResponse::AppOpened { success: false }
            }
        }
    }
}

async fn send_tcp_ipc_to_app(req: &ExtensionRequest) -> Result<ExtensionResponse, String> {
    let mut stream = tokio::time::timeout(Duration::from_millis(600), tokio::net::TcpStream::connect(IPC_TCP_ADDR))
        .await
        .map_err(|_| "TCP connect timeout".to_string())?
        .map_err(|e| format!("TCP connect error: {}", e))?;

    let req_bytes = serde_json::to_vec(req).map_err(|e| e.to_string())?;
    let req_len = (req_bytes.len() as u32).to_le_bytes();

    tokio::time::timeout(Duration::from_secs(60), async {
        stream.write_all(&req_len).await.map_err(|e| e.to_string())?;
        stream.write_all(&req_bytes).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())?;

        let mut resp_len_buf = [0u8; 4];
        stream.read_exact(&mut resp_len_buf).await.map_err(|e| e.to_string())?;
        let resp_len = u32::from_le_bytes(resp_len_buf) as usize;
        if resp_len == 0 || resp_len > crate::native_messaging::MAX_MESSAGE_SIZE {
            return Err("Invalid response length from IPC".to_string());
        }

        let mut resp_body = vec![0u8; resp_len];
        stream.read_exact(&mut resp_body).await.map_err(|e| e.to_string())?;

        serde_json::from_slice::<ExtensionResponse>(&resp_body)
            .map_err(|e| format!("Invalid IPC response JSON: {}", e))
    })
    .await
    .map_err(|_| "IPC request timed out".to_string())?
}

/// Client-side IPC call from `mdm_host.exe` to running MDM desktop application.
/// Returns Ok(response) if the application is running and processed the request.
/// Returns Err(_) if the application is not running or unreachable.
pub async fn send_ipc_to_app(req: &ExtensionRequest) -> Result<ExtensionResponse, String> {
    // 1. Primary: Fast Localhost TCP socket (immune to Windows Named Pipe DACL & sandbox tokens)
    if let Ok(resp) = send_tcp_ipc_to_app(req).await {
        return Ok(resp);
    }

    // 2. Secondary: Windows Named Pipe fallback
    #[cfg(windows)]
    {
        let mut client_opt = None;
        let mut last_err = String::new();
        for _ in 0..10 {
            match ClientOptions::new().open(IPC_PIPE_NAME) {
                Ok(c) => {
                    client_opt = Some(c);
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
        let mut client = client_opt.ok_or_else(|| format!("Named pipe not available: {}", last_err))?;

        let req_bytes = serde_json::to_vec(req).map_err(|e| e.to_string())?;
        let req_len = (req_bytes.len() as u32).to_le_bytes();

        tokio::time::timeout(Duration::from_secs(60), async {
            client
                .write_all(&req_len)
                .await
                .map_err(|e| e.to_string())?;
            client
                .write_all(&req_bytes)
                .await
                .map_err(|e| e.to_string())?;
            client.flush().await.map_err(|e| e.to_string())?;

            let mut resp_len_buf = [0u8; 4];
            client
                .read_exact(&mut resp_len_buf)
                .await
                .map_err(|e| e.to_string())?;
            let resp_len = u32::from_le_bytes(resp_len_buf) as usize;
            if resp_len == 0 || resp_len > crate::native_messaging::MAX_MESSAGE_SIZE {
                return Err("Invalid response length from IPC".to_string());
            }

            let mut resp_body = vec![0u8; resp_len];
            client
                .read_exact(&mut resp_body)
                .await
                .map_err(|e| e.to_string())?;

            serde_json::from_slice::<ExtensionResponse>(&resp_body)
                .map_err(|e| format!("Invalid IPC response JSON: {}", e))
        })
        .await
        .map_err(|_| "IPC request timed out".to_string())?
    }

    #[cfg(not(windows))]
    {
        let _ = req;
        Err("Named pipe IPC only supported on Windows".to_string())
    }
}



