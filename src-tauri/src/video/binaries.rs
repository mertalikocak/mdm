use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStatus {
    pub ytdlp_installed: bool,
    pub ytdlp_version: Option<String>,
    pub ytdlp_path: Option<String>,
    pub ffmpeg_installed: bool,
    pub ffmpeg_version: Option<String>,
    pub ffmpeg_path: Option<String>,
}

/// Helper to configure a Command without popping up a console window on Windows
pub fn create_hidden_command<P: AsRef<Path>>(program: P) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program.as_ref());
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW = 0x08000000
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// Search for yt-dlp binary in app's bin directory or system PATH
pub fn find_yt_dlp(bin_dir: &Path) -> Option<PathBuf> {
    // 1. Check local bin directory first
    let local_exe = bin_dir.join("yt-dlp.exe");
    if local_exe.is_file() {
        return Some(local_exe);
    }
    let local_no_ext = bin_dir.join("yt-dlp");
    if local_no_ext.is_file() {
        return Some(local_no_ext);
    }

    // 2. Search system PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join("yt-dlp.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
            let candidate_no_ext = dir.join("yt-dlp");
            if candidate_no_ext.is_file() {
                return Some(candidate_no_ext);
            }
        }
    }

    None
}

/// Search for ffmpeg binary in app's bin directory or system PATH
pub fn find_ffmpeg(bin_dir: &Path) -> Option<PathBuf> {
    // 1. Check local bin directory
    let local_exe = bin_dir.join("ffmpeg.exe");
    if local_exe.is_file() {
        return Some(local_exe);
    }
    let local_no_ext = bin_dir.join("ffmpeg");
    if local_no_ext.is_file() {
        return Some(local_no_ext);
    }

    // 2. Search system PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join("ffmpeg.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
            let candidate_no_ext = dir.join("ffmpeg");
            if candidate_no_ext.is_file() {
                return Some(candidate_no_ext);
            }
        }
    }

    None
}

/// Check current installation and version info of yt-dlp and ffmpeg
pub async fn get_tool_status(bin_dir: &Path) -> ToolStatus {
    let ytdlp_path = find_yt_dlp(bin_dir);
    let mut ytdlp_version = None;
    if let Some(ref p) = ytdlp_path {
        let mut cmd = create_hidden_command(p);
        cmd.arg("--version");
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Ok(output) = cmd.output().await {
            if output.status.success() {
                let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !v.is_empty() {
                    ytdlp_version = Some(v);
                }
            }
        }
    }

    let ffmpeg_path = find_ffmpeg(bin_dir);
    let mut ffmpeg_version = None;
    if let Some(ref p) = ffmpeg_path {
        let mut cmd = create_hidden_command(p);
        cmd.arg("-version");
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Ok(output) = cmd.output().await {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = text.lines().next() {
                    ffmpeg_version = Some(first_line.trim().to_string());
                }
            }
        }
    }

    ToolStatus {
        ytdlp_installed: ytdlp_path.is_some() && ytdlp_version.is_some(),
        ytdlp_version,
        ytdlp_path: ytdlp_path.map(|p| p.to_string_lossy().to_string()),
        ffmpeg_installed: ffmpeg_path.is_some() && ffmpeg_version.is_some(),
        ffmpeg_version,
        ffmpeg_path: ffmpeg_path.map(|p| p.to_string_lossy().to_string()),
    }
}

/// Downloads official yt-dlp.exe Windows binary from GitHub release
pub async fn install_or_update_ytdlp(bin_dir: &Path, client: &reqwest::Client) -> Result<String, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("Klasör oluşturulamadı: {}", e))?;

    let download_url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    let resp = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("yt-dlp indirme bağlantısına erişilemedi: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("yt-dlp indirilemedi, HTTP hatası: {}", resp.status()));
    }

    let temp_file = bin_dir.join("yt-dlp.exe.tmp");
    let final_file = bin_dir.join("yt-dlp.exe");

    let mut file = tokio::fs::File::create(&temp_file)
        .await
        .map_err(|e| format!("Geçici dosya oluşturulamadı: {}", e))?;

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Veri akışı hatası: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Diske yazılamadı: {}", e))?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Atomically swap
    if final_file.exists() {
        let _ = std::fs::remove_file(&final_file);
    }
    std::fs::rename(&temp_file, &final_file)
        .map_err(|e| format!("yt-dlp dosyası yerine yerleştirilemedi: {}", e))?;

    // Verify it runs and get version
    let mut cmd = create_hidden_command(&final_file);
    cmd.arg("--version");
    let output = cmd.output().await.map_err(|e| format!("yt-dlp çalıştırılamadı: {}", e))?;
    if output.status.success() {
        let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(v)
    } else {
        Err("İndirilen yt-dlp dosyası doğrulanamadı.".to_string())
    }
}

/// Downloads the yt-dlp recommended FFmpeg Windows build and extracts ffmpeg.exe / ffprobe.exe into bin_dir.
/// Required to merge YouTube's separate video (mp4) and audio (webm/m4a) streams into one file.
pub async fn install_ffmpeg(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("Klasör oluşturulamadı: {}", e))?;

    let download_url =
        "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
    let zip_path = bin_dir.join("ffmpeg.zip.tmp");

    // Reuse an already fully downloaded archive if present (e.g. previous interrupted extraction)
    if !zip_path.is_file() || std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0) < 10_000_000 {
        // FFmpeg archive is large (~200 MB); use a client without a total request timeout
        let dl_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = dl_client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("FFmpeg indirme bağlantısına erişilemedi: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("FFmpeg indirilemedi, HTTP hatası: {}", resp.status()));
        }

        let partial = bin_dir.join("ffmpeg.zip.download");
        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|e| format!("Geçici dosya oluşturulamadı: {}", e))?;
        let mut stream = resp.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| format!("FFmpeg veri akışı hatası: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Diske yazılamadı: {}", e))?;
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        let _ = std::fs::remove_file(&zip_path);
        std::fs::rename(&partial, &zip_path).map_err(|e| e.to_string())?;
    }

    // Extract only bin/ffmpeg.exe and bin/ffprobe.exe using Windows' built-in bsdtar (fixed args, no shell)
    let tar_exe = std::env::var("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32").join("tar.exe"))
        .unwrap_or_else(|_| PathBuf::from("tar.exe"));
    let mut cmd = create_hidden_command(&tar_exe);
    cmd.arg("-xf")
        .arg(&zip_path)
        .arg("-C")
        .arg(bin_dir)
        .arg("--strip-components")
        .arg("2")
        .arg("*/bin/ffmpeg.exe")
        .arg("*/bin/ffprobe.exe");
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("FFmpeg arşivi açılamadı: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "FFmpeg arşivi açılamadı: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let _ = std::fs::remove_file(&zip_path);

    let ffmpeg = bin_dir.join("ffmpeg.exe");
    if ffmpeg.is_file() {
        Ok(ffmpeg)
    } else {
        Err("FFmpeg kurulumu doğrulanamadı.".to_string())
    }
}
