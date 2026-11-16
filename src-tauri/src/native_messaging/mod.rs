use crate::db::Database;
use crate::engine::probe::{get_collision_free_path, sanitize_filename};
use crate::engine::task::{DownloadStatus, DownloadTask};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

pub const PROTOCOL_VERSION: &str = "1.0.0";
pub const MAX_MESSAGE_SIZE: usize = 1024 * 1024; // 1 MB limit per Chrome Native Messaging spec

/// Inbound messages from the Chromium browser extension
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionRequest {
    Ping,
    AddDownload {
        url: String,
        filename: Option<String>,
        destination_dir: Option<String>,
        referrer: Option<String>,
        cookies: Option<String>,
        user_agent: Option<String>,
    },
    ProbeVideo {
        url: String,
        #[serde(default)]
        referrer: Option<String>,
        #[serde(default)]
        cookies: Option<String>,
        #[serde(default)]
        user_agent: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },
    AddVideoDownload {
        url: String,
        title: String,
        format_spec: String,
        extension: String,
        is_audio_only: bool,
        destination_dir: Option<String>,
    },
    OpenMdmApp,
}

/// Outbound responses from the Native Messaging Host to the browser extension
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionResponse {
    Pong {
        version: String,
        mdm_app_running: bool,
    },
    DownloadAdded {
        task_id: String,
        filename: String,
        status: String,
    },
    DuplicateIgnored {
        task_id: String,
        filename: String,
        message: String,
    },
    VideoProbed {
        data: crate::video::VideoAnalysisResult,
    },
    VideoDownloadAdded {
        task_id: String,
        filename: String,
        status: String,
    },
    AppOpened {
        success: bool,
    },
    Error {
        code: String,
        message: String,
    },
}

/// Read a Native Messaging packet with 32-bit little-endian length prefix
pub fn read_native_packet<R: Read>(reader: &mut R) -> Result<serde_json::Value, String> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .map_err(|e| format!("Failed to read packet length: {}", e))?;

    let msg_len = u32::from_le_bytes(len_buf) as usize;
    if msg_len == 0 {
        return Err("Empty message received".to_string());
    }
    if msg_len > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message size {} exceeds max allowed size of {}",
            msg_len, MAX_MESSAGE_SIZE
        ));
    }

    let mut body = vec![0u8; msg_len];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("Failed to read message body: {}", e))?;

    serde_json::from_slice(&body).map_err(|e| format!("Invalid JSON payload: {}", e))
}

/// Write a Native Messaging packet with 32-bit little-endian length prefix
pub fn write_native_packet<W: Write>(writer: &mut W, value: &serde_json::Value) -> Result<(), String> {
    let json_bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let len = json_bytes.len() as u32;

    writer
        .write_all(&len.to_le_bytes())
        .map_err(|e| format!("Failed to write length prefix: {}", e))?;
    writer
        .write_all(&json_bytes)
        .map_err(|e| format!("Failed to write payload: {}", e))?;
    writer.flush().map_err(|e| format!("Failed to flush: {}", e))?;

    Ok(())
}

pub mod ipc;
pub mod registry;

/// Dispatches an extension request against the persistent MDM database and tools
pub async fn handle_extension_request(
    db: Arc<Database>,
    _bin_dir: &Path,
    default_download_dir: &str,
    req: ExtensionRequest,
) -> ExtensionResponse {
    // Offline / direct mode: Persist directly to SQLite and launch app.
    match req {
        ExtensionRequest::Ping => {
            // Check if mdm.exe is running via tasklist on Windows
            let app_running = is_mdm_app_running();
            ExtensionResponse::Pong {
                version: PROTOCOL_VERSION.to_string(),
                mdm_app_running: app_running,
            }
        }
        ExtensionRequest::AddDownload {
            url,
            filename,
            destination_dir,
            referrer,
            cookies,
            user_agent,
        } => {
            // Validate URL
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

            // Check duplicate active task
            if let Ok(tasks) = db.list_tasks() {
                if let Some(existing) = tasks.iter().find(|t| {
                    t.url == url
                        && (t.status == DownloadStatus::Downloading
                            || t.status == DownloadStatus::Queued
                            || t.status == DownloadStatus::Probing)
                }) {
                    return ExtensionResponse::DuplicateIgnored {
                        task_id: existing.id.clone(),
                        filename: existing.filename.clone(),
                        message: "Bu bağlantı zaten aktif indirme kuyruğunda yer alıyor.".to_string(),
                    };
                }
            }

            let target_dir = match destination_dir {
                Some(ref d) => {
                    let p = Path::new(d);
                    if p.is_dir() {
                        d.clone()
                    } else {
                        default_download_dir.to_string()
                    }
                }
                None => default_download_dir.to_string(),
            };

            let display_filename = filename
                .as_deref()
                .map(sanitize_filename)
                .unwrap_or_else(|| {
                    url.split('?')
                        .next()
                        .and_then(|s| s.split('/').last())
                        .filter(|s| !s.is_empty())
                        .map(sanitize_filename)
                        .unwrap_or_else(|| "dosya".to_string())
                });

            let final_dest = get_collision_free_path(&target_dir, &display_filename);
            let task_id = uuid::Uuid::new_v4().to_string();
            let default_segments = db
                .get_setting("app_settings")
                .ok()
                .flatten()
                .and_then(|v| serde_json::from_str::<crate::engine::task::AppSettings>(&v).ok())
                .map(|s| s.default_segments)
                .unwrap_or(8);

            let task = DownloadTask {
                id: task_id.clone(),
                url,
                filename: display_filename.clone(),
                destination_path: final_dest,
                total_bytes: None,
                downloaded_bytes: 0,
                speed_bytes_per_sec: 0,
                eta_seconds: None,
                status: DownloadStatus::Queued,
                error_message: None,
                supports_range: false,
                segment_count: default_segments,
                segments: Vec::new(),
                etag: None,
                last_modified: None,
                created_at: Utc::now(),
                completed_at: None,
                cookies,
                referrer,
                user_agent,
            };

            if let Err(e) = db.insert_or_update_task(&task) {
                return ExtensionResponse::Error {
                    code: "DB_ERROR".to_string(),
                    message: format!("İndirme görevi veritabanına eklenemedi: {}", e),
                };
            }

            if !target_dir.contains("mdm_test_") {
                ensure_mdm_app_running();
            }

            ExtensionResponse::DownloadAdded {
                task_id,
                filename: display_filename,
                status: "queued".to_string(),
            }
        }
        ExtensionRequest::ProbeVideo {
            url,
            referrer,
            cookies,
            user_agent,
            title,
        } => {
            // Queue pending video confirmation so MDM launches into the compact video modal immediately
            let app_data_dir = match std::env::var("LOCALAPPDATA") {
                Ok(local) => std::path::PathBuf::from(local).join("mdm"),
                Err(_) => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
            };
            let _ = std::fs::create_dir_all(&app_data_dir);
            let pending_confirm_path = app_data_dir.join("pending_confirm.json");
            let pending_json = serde_json::json!({
                "url": url,
                "mode": "video",
                "referrer": referrer,
                "cookies": cookies,
                "user_agent": user_agent,
                "filename": title.clone(),
            });
            let _ = std::fs::write(&pending_confirm_path, pending_json.to_string());

            ensure_mdm_app_running();

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
            let target_dir = destination_dir.unwrap_or_else(|| default_download_dir.to_string());
            let clean_name = sanitize_filename(&title);
            let filename = format!("{}.{}", clean_name, extension);
            let final_dest = get_collision_free_path(&target_dir, &filename);
            let task_id = uuid::Uuid::new_v4().to_string();

            let task = DownloadTask {
                id: task_id.clone(),
                url,
                filename: filename.clone(),
                destination_path: final_dest,
                total_bytes: None,
                downloaded_bytes: 0,
                speed_bytes_per_sec: 0,
                eta_seconds: None,
                status: DownloadStatus::Queued,
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
                created_at: Utc::now(),
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

            ensure_mdm_app_running();

            ExtensionResponse::VideoDownloadAdded {
                task_id,
                filename,
                status: "queued".to_string(),
            }
        }
        ExtensionRequest::OpenMdmApp => {
            let success = launch_mdm_app();
            ExtensionResponse::AppOpened { success }
        }
    }
}

/// Helper to check if mdm.exe is currently active in Windows process list
fn is_mdm_app_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let output = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq mdm.exe", "/NH"])
            .output();

        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout).to_lowercase();
            return s.contains("mdm.exe");
        }
    }
    false
}

/// Launch or bring mdm.exe to foreground on Windows
pub fn launch_mdm_app() -> bool {
    if is_mdm_app_running() {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Search current exe directory or app directory
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(dir) = current_exe.parent() {
                let mdm_candidate = dir.join("mdm.exe");
                if mdm_candidate.is_file() {
                    let res = Command::new(mdm_candidate)
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();
                    return res.is_ok();
                }
            }
        }
        // Fallback: start via system PATH
        let res = Command::new("mdm.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        return res.is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// Starts the MDM application if not already running
fn ensure_mdm_app_running() {
    if !is_mdm_app_running() {
        launch_mdm_app();
    }
}
