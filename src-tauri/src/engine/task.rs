use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Probing,
    Downloading,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentProgress {
    pub index: usize,
    pub start_byte: u64,
    pub end_byte: u64,
    pub downloaded_bytes: u64,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub destination_path: String,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub eta_seconds: Option<u64>,
    pub status: DownloadStatus,
    pub error_message: Option<String>,
    pub supports_range: bool,
    pub segment_count: usize,
    pub segments: Vec<SegmentProgress>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStats {
    pub total_download_speed: u64,
    pub active_downloads: usize,
    pub queued_downloads: usize,
    pub completed_downloads: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub default_download_dir: String,
    pub max_concurrent_downloads: usize,
    pub default_segments: usize,
    pub global_speed_limit_bytes: Option<u64>,
    pub theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        let default_dir = dirs_or_fallback();
        Self {
            default_download_dir: default_dir,
            max_concurrent_downloads: 3,
            default_segments: 8,
            global_speed_limit_bytes: None,
            theme: "dark".to_string(),
        }
    }
}

fn dirs_or_fallback() -> String {
    // Windows Downloads fallback
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let downloads = std::path::Path::new(&userprofile).join("Downloads");
        if downloads.exists() {
            return downloads.to_string_lossy().to_string();
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "C:\\Downloads".to_string())
}
