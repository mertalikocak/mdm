use crate::engine::task::{AppSettings, DownloadStatus, DownloadTask, EngineStats};
use crate::state::AppState;
use std::path::Path;
use tauri::State;

#[tauri::command]
pub async fn get_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadTask>, String> {
    state.db.list_tasks().map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DownloadProbeInfo {
    pub url: String,
    pub filename: String,
    pub total_bytes: Option<u64>,
    pub formatted_size: String,
    pub supports_range: bool,
    pub suggested_path: String,
    pub category: String,
}

#[tauri::command]
pub async fn probe_download_info(
    state: State<'_, AppState>,
    url: String,
    cookies: Option<String>,
    referrer: Option<String>,
    user_agent: Option<String>,
) -> Result<DownloadProbeInfo, String> {
    let settings = get_settings_internal(&state.db);
    let probe = crate::engine::probe::probe_url_with_headers(
        state.engine.get_client(),
        &url,
        cookies.as_deref(),
        referrer.as_deref(),
        user_agent.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let clean_filename = crate::engine::probe::sanitize_filename(&probe.filename);
    let suggested_path =
        crate::engine::probe::get_collision_free_path(&settings.default_download_dir, &clean_filename);

    let formatted_size = match probe.total_bytes {
        Some(bytes) => format_bytes_helper(bytes),
        None => "Bilinmiyor (Akış)".to_string(),
    };

    let category = detect_file_category(&clean_filename);

    Ok(DownloadProbeInfo {
        url: probe.resolved_url,
        filename: clean_filename,
        total_bytes: probe.total_bytes,
        formatted_size,
        supports_range: probe.supports_range,
        suggested_path,
        category,
    })
}

#[tauri::command]
pub async fn add_download(
    state: State<'_, AppState>,
    url: String,
    destination_dir: Option<String>,
    segments: Option<usize>,
) -> Result<DownloadTask, String> {
    let settings = get_settings_internal(&state.db);
    let dest = destination_dir.unwrap_or(settings.default_download_dir);
    let seg_count = segments.unwrap_or(settings.default_segments);

    state.engine.add_task(&url, &dest, seg_count).await
}

#[tauri::command]
pub async fn add_download_with_options(
    state: State<'_, AppState>,
    url: String,
    filename: Option<String>,
    destination_dir: Option<String>,
    segments: Option<usize>,
    start_immediately: bool,
    cookies: Option<String>,
    referrer: Option<String>,
    user_agent: Option<String>,
) -> Result<DownloadTask, String> {
    let settings = get_settings_internal(&state.db);
    let dest = destination_dir.unwrap_or(settings.default_download_dir);
    let seg_count = segments.unwrap_or(settings.default_segments);

    state
        .engine
        .add_task_with_options(
            &url,
            filename,
            &dest,
            seg_count,
            start_immediately,
            cookies,
            referrer,
            user_agent,
        )
        .await
}

#[tauri::command]
pub async fn pause_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state.video_engine.is_task_active(&id).await {
        state.video_engine.pause_video_task(&id).await
    } else {
        state.engine.pause_task(&id).await
    }
}

#[tauri::command]
pub async fn resume_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Ok(tasks) = state.db.list_tasks() {
        if let Some(task) = tasks.into_iter().find(|t| t.id == id) {
            if let Some(ref etag) = task.etag {
                if etag.starts_with("video:") {
                    let parts: Vec<&str> = etag.splitn(3, ':').collect();
                    let is_audio = parts.get(1).map(|&s| s == "audio").unwrap_or(false);
                    let format_spec = parts.get(2).unwrap_or(&"best").to_string();
                    return state.video_engine.start_video_download(id, format_spec, is_audio).await;
                }
            }
        }
    }
    state.engine.resume_task(&id).await
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _ = state.video_engine.cancel_video_task(&id).await;
    state.engine.cancel_task(&id).await
}

#[tauri::command]
pub async fn retry_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    resume_download(state, id).await
}

#[tauri::command]
pub async fn remove_download(
    state: State<'_, AppState>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    let task_opt = state
        .db
        .list_tasks()
        .ok()
        .and_then(|tasks| tasks.into_iter().find(|t| t.id == id));

    let is_completed = task_opt
        .as_ref()
        .map(|t| t.status == DownloadStatus::Completed)
        .unwrap_or(false);

    if !is_completed {
        let _ = state.video_engine.cancel_video_task(&id).await;
        let _ = state.engine.cancel_task(&id).await;
    }

    if let Some(task) = task_opt {
        if delete_file {
            let p = Path::new(&task.destination_path);
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
            crate::engine::manager::cleanup_task_temp_files(&task.destination_path);
        } else if !is_completed {
            crate::engine::manager::cleanup_task_temp_files(&task.destination_path);
        }
    }

    state.db.delete_task(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn probe_video_info(
    state: State<'_, AppState>,
    url: String,
    cookies: Option<String>,
    referrer: Option<String>,
    user_agent: Option<String>,
    fallback_title: Option<String>,
) -> Result<crate::video::VideoAnalysisResult, String> {
    crate::video::analyze_video_url_with_headers(
        state.video_engine.get_bin_dir(),
        &url,
        cookies.as_deref(),
        referrer.as_deref(),
        user_agent.as_deref(),
        fallback_title.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn add_video_download(
    state: State<'_, AppState>,
    url: String,
    title: String,
    format_spec: String,
    extension: String,
    is_audio_only: bool,
    destination_dir: Option<String>,
    total_bytes: Option<u64>,
    cookies: Option<String>,
    referrer: Option<String>,
    user_agent: Option<String>,
) -> Result<DownloadTask, String> {
    let settings = get_settings_internal(&state.db);
    let dest = destination_dir.unwrap_or(settings.default_download_dir);

    state
        .video_engine
        .add_video_task(
            &url,
            &title,
            &format_spec,
            &extension,
            is_audio_only,
            &dest,
            total_bytes,
            cookies,
            referrer,
            user_agent,
        )
        .await
}

#[tauri::command]
pub async fn get_tool_status(state: State<'_, AppState>) -> Result<crate::video::ToolStatus, String> {
    Ok(crate::video::get_tool_status(state.video_engine.get_bin_dir()).await)
}

#[tauri::command]
pub async fn install_or_update_ytdlp(state: State<'_, AppState>) -> Result<String, String> {
    state.video_engine.install_ytdlp().await
}

#[tauri::command]
pub async fn get_engine_stats(state: State<'_, AppState>) -> Result<EngineStats, String> {
    Ok(state.engine.get_stats().await)
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(get_settings_internal(&state.db))
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    state
        .engine
        .set_speed_limit(settings.global_speed_limit_bytes);
    let serialized = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting("app_settings", &serialized)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_speed_limit(
    state: State<'_, AppState>,
    limit_bytes_per_sec: Option<u64>,
) -> Result<(), String> {
    let normalized = limit_bytes_per_sec.filter(|&v| v > 0);
    state.engine.set_speed_limit(normalized);
    let mut settings = get_settings_internal(&state.db);
    settings.global_speed_limit_bytes = normalized;
    let serialized = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting("app_settings", &serialized)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pick_folder(window: tauri::Window) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd_owner: isize = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        tokio::task::spawn_blocking(move || pick_folder_win32(hwnd_owner))
            .await
            .map_err(|e| format!("Klasör seçici hatası: {}", e))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("Klasör seçici yalnızca Windows'ta desteklenmektedir.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn pick_folder_win32(hwnd_owner: isize) -> Result<Option<String>, String> {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct BrowseInfoW {
        hwndOwner: isize,
        pidlRoot: *const c_void,
        pszDisplayName: *mut u16,
        lpszTitle: *const u16,
        ulFlags: u32,
        lpfn: *const c_void,
        lParam: isize,
        iImage: i32,
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(pv: *mut c_void);
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHBrowseForFolderW(lpbi: *mut BrowseInfoW) -> *mut c_void;
        fn SHGetPathFromIDListW(pidl: *const c_void, pszPath: *mut u16) -> i32;
    }

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const BIF_RETURNONLYFSDIRS: u32 = 0x0001;
    const BIF_NEWDIALOGSTYLE: u32 = 0x0040;

    let title_wide: Vec<u16> = "İndirme Klasörünü Seçin\0".encode_utf16().collect();
    let mut display_buf = [0u16; 260];

    unsafe {
        let hr = CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED);
        let should_uninit = hr == 0 || hr == 1;

        let mut bi = BrowseInfoW {
            hwndOwner: hwnd_owner,
            pidlRoot: ptr::null(),
            pszDisplayName: display_buf.as_mut_ptr(),
            lpszTitle: title_wide.as_ptr(),
            ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
            lpfn: ptr::null(),
            lParam: 0,
            iImage: 0,
        };

        let pidl = SHBrowseForFolderW(&mut bi);
        let result = if pidl.is_null() {
            Ok(None)
        } else {
            let mut path_buf = [0u16; 1024];
            let ok = SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr());
            CoTaskMemFree(pidl);
            if ok != 0 {
                let len = path_buf.iter().position(|&c| c == 0).unwrap_or(path_buf.len());
                Ok(Some(String::from_utf16_lossy(&path_buf[..len])))
            } else {
                Ok(None)
            }
        };

        if should_uninit {
            CoUninitialize();
        }

        result
    }
}

#[tauri::command]
pub async fn open_file_location(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    let folder = if target.is_dir() {
        target
    } else if let Some(parent) = target.parent().filter(|p| p.is_dir()) {
        parent
    } else {
        return Err("Klasör bulunamadı.".to_string());
    };

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        if target.is_file() {
            // Highlight the downloaded file in Explorer
            let mut select_cmd = Command::new("explorer.exe");
            select_cmd.args(["/select,", &path]);
            if let Err(_) = select_cmd.spawn() {
                // Fallback to opening folder directly
                let _ = Command::new("explorer.exe").arg(folder).spawn();
            }
        } else {
            // Open parent folder directly
            Command::new("explorer.exe")
                .arg(folder)
                .spawn()
                .map_err(|e| format!("Klasör açılamadı: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("Dosya bulunamadı. İndirilen dosya silinmiş veya taşınmış olabilir.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // Launch file in its default registered application via Windows Explorer
        Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Dosya açılamadı: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn check_pending_confirm() -> Result<Option<serde_json::Value>, String> {
    let app_data_dir = match std::env::var("LOCALAPPDATA") {
        Ok(local) => std::path::PathBuf::from(local).join("mdm"),
        Err(_) => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
    };
    let pending_confirm_path = app_data_dir.join("pending_confirm.json");
    if pending_confirm_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&pending_confirm_path) {
            let _ = std::fs::remove_file(&pending_confirm_path);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                return Ok(Some(parsed));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn close_compact_dialog(window: tauri::Window) -> Result<(), String> {
    let _ = window.set_always_on_top(false);
    let _ = window.hide();
    Ok(())
}

#[tauri::command]
pub async fn check_app_update() -> Result<crate::updater::AppUpdateInfo, String> {
    crate::updater::check_app_update().await
}

#[tauri::command]
pub async fn install_app_update(
    app: tauri::AppHandle,
    download_url: String,
    sha256: Option<String>,
) -> Result<(), String> {
    crate::updater::download_and_install_update(app, download_url, sha256).await
}

fn get_settings_internal(db: &crate::db::Database) -> AppSettings {
    if let Ok(Some(val)) = db.get_setting("app_settings") {
        if let Ok(settings) = serde_json::from_str::<AppSettings>(&val) {
            return settings;
        }
    }
    AppSettings::default()
}

fn format_bytes_helper(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;

    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.2} MB", b / MB)
    } else if b >= KB {
        format!("{:.2} KB", b / KB)
    } else {
        format!("{} B", bytes)
    }
}

fn detect_file_category(filename: &str) -> String {
    let lower = filename.to_lowercase();
    let ext = lower.split('.').last().unwrap_or("");
    match ext {
        "mp4" | "mkv" | "avi" | "webm" | "mov" | "wmv" | "flv" | "m4v" | "ts" => "video".to_string(),
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "opus" | "wma" => "audio".to_string(),
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" => "compressed".to_string(),
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "epub" => "document".to_string(),
        "exe" | "msi" | "apk" | "deb" | "rpm" | "bat" | "cmd" => "program".to_string(),
        _ => "general".to_string(),
    }
}
