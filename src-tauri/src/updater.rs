use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const LATEST_JSON_URL: &str =
    "https://github.com/mertalikocak/mdm/releases/latest/download/latest.json";
const GITHUB_API_LATEST_URL: &str =
    "https://api.github.com/repos/mertalikocak/mdm/releases/latest";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: String,
    pub download_url: Option<String>,
    pub sha256: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LatestManifest {
    version: String,
    #[serde(default)]
    notes: String,
    setup_url: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

fn parse_semver_tuple(raw: &str) -> (u64, u64, u64) {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let main_part = trimmed.split(['-', '+']).next().unwrap_or("");
    let mut parts = main_part.split('.').map(|s| s.trim().parse::<u64>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    (major, minor, patch)
}

pub fn is_newer_version(current: &str, remote: &str) -> bool {
    parse_semver_tuple(remote) > parse_semver_tuple(current)
}

pub async fn check_app_update() -> Result<AppUpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("MakDownloadManager/{}", CURRENT_VERSION))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Güncelleme istemcisi oluşturulamadı: {}", e))?;

    // 1. Primary: Check GitHub Releases latest.json manifest
    if let Ok(resp) = client.get(LATEST_JSON_URL).send().await {
        if resp.status().is_success() {
            if let Ok(body) = resp.text().await {
                if let Ok(manifest) = serde_json::from_str::<LatestManifest>(&body) {
                    let latest_clean = manifest.version.trim().trim_start_matches(['v', 'V']).to_string();
                    let update_available = is_newer_version(CURRENT_VERSION, &latest_clean);
                    return Ok(AppUpdateInfo {
                        current_version: CURRENT_VERSION.to_string(),
                        latest_version: latest_clean,
                        update_available,
                        release_notes: manifest.notes,
                        download_url: Some(manifest.setup_url),
                        sha256: manifest.sha256.filter(|s| !s.trim().is_empty()),
                        published_at: manifest.published_at,
                    });
                }
            }
        }
    }

    // 2. Fallback: GitHub Releases API
    let resp = client
        .get(GITHUB_API_LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub güncelleme sunucusuna bağlanılamadı: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(AppUpdateInfo {
            current_version: CURRENT_VERSION.to_string(),
            latest_version: CURRENT_VERSION.to_string(),
            update_available: false,
            release_notes: "Uygulamanız güncel (henüz yayınlanmış yeni sürüm bulunmuyor).".to_string(),
            download_url: None,
            sha256: None,
            published_at: None,
        });
    }

    if !resp.status().is_success() {
        return Err(format!(
            "Güncelleme sunucusu hata döndürdü (HTTP {}).",
            resp.status().as_u16()
        ));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Yayın bilgisi okunamadı: {}", e))?;
    let release = serde_json::from_str::<GithubRelease>(&body)
        .map_err(|e| format!("Yayın bilgisi çözümlenemedi: {}", e))?;

    let latest_clean = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let update_available = is_newer_version(CURRENT_VERSION, &latest_clean);

    let asset = release
        .assets
        .iter()
        .find(|a| {
            let low = a.name.to_lowercase();
            low.ends_with("-setup.exe") || low.ends_with(".exe")
        });

    Ok(AppUpdateInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_clean,
        update_available,
        release_notes: release.body.unwrap_or_default(),
        download_url: asset.map(|a| a.browser_download_url.clone()),
        sha256: None,
        published_at: release.published_at,
    })
}

pub async fn download_and_install_update(
    app_handle: tauri::AppHandle,
    download_url: String,
    expected_sha256: Option<String>,
) -> Result<(), String> {
    let trimmed_url = download_url.trim();
    if !trimmed_url.starts_with("https://") && !trimmed_url.starts_with("http://") {
        return Err("Geçersiz güncelleme bağlantısı.".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent(format!("MakDownloadManager/{}", CURRENT_VERSION))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("İndirme istemcisi başlatılamadı: {}", e))?;

    let resp = client
        .get(trimmed_url)
        .send()
        .await
        .map_err(|e| format!("Güncelleme paketi indirilemedi: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Güncelleme paketi alınamadı (HTTP {}).",
            resp.status().as_u16()
        ));
    }

    let total_bytes = resp.content_length();
    let temp_dir = std::env::temp_dir();
    let temp_setup_path: PathBuf = temp_dir.join("mdm_update_setup.exe");

    let mut file = tokio::fs::File::create(&temp_setup_path)
        .await
        .map_err(|e| format!("Geçici kurulum dosyası oluşturulamadı: {}", e))?;

    let mut hasher = Sha256::new();
    let mut downloaded_bytes: u64 = 0;
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);

    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Güncelleme akışı kesildi: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Kurulum dosyası diske yazılamadı: {}", e))?;
        hasher.update(&chunk);
        downloaded_bytes += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            let percent = total_bytes
                .filter(|&t| t > 0)
                .map(|t| ((downloaded_bytes as f64 / t as f64) * 100.0).min(100.0))
                .unwrap_or(0.0);
            let _ = app_handle.emit(
                "app-update-progress",
                serde_json::json!({
                    "downloaded_bytes": downloaded_bytes,
                    "total_bytes": total_bytes,
                    "percent": percent,
                }),
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Kurulum dosyası tamponu boşaltılamadı: {}", e))?;
    drop(file);

    let _ = app_handle.emit(
        "app-update-progress",
        serde_json::json!({
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": total_bytes.or(Some(downloaded_bytes)),
            "percent": 100.0,
        }),
    );

    // Optional SHA-256 verification
    if let Some(expected) = expected_sha256.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let actual_hex: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        if !actual_hex.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&temp_setup_path);
            return Err("Güncelleme paketi SHA-256 güvenlik doğrulamasından geçemedi.".to_string());
        }
    }

    // Launch silent NSIS installer after MDM closes and restarts MDM cleanly
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let current_exe = std::env::current_exe()
            .unwrap_or_else(|_| PathBuf::from("mdm.exe"));
        let setup_str = temp_setup_path.to_string_lossy().to_string();
        let exe_str = current_exe.to_string_lossy().to_string();

        let bat_path = temp_dir.join("mdm_apply_update.cmd");
        let bat_content = format!(
            "@echo off\r\n\
             chcp 65001 >nul 2>nul\r\n\
             ping 127.0.0.1 -n 3 >nul\r\n\
             taskkill /F /IM mdm.exe >nul 2>nul\r\n\
             \"{}\" /S\r\n\
             start \"\" \"{}\"\r\n\
             del /Q \"{}\"\r\n\
             del /Q \"%~f0\"\r\n",
            setup_str, exe_str, setup_str
        );
        std::fs::write(&bat_path, bat_content)
            .map_err(|e| format!("Güncelleme betiği hazırlanamadı: {}", e))?;

        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/C", &bat_path.to_string_lossy()]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn()
            .map_err(|e| format!("Kurulum süreci başlatılamadı: {}", e))?;
    }

    app_handle.exit(0);
    Ok(())
}
