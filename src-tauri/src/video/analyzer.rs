use crate::video::binaries::{create_hidden_command, find_yt_dlp};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Stdio;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoQualityOption {
    pub id: String,                  // e.g. "1080p", "720p", "audio_only"
    pub label: String,               // e.g. "1080p Full HD"
    pub format_spec: String,         // yt-dlp format selector: e.g. "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
    pub extension: String,           // e.g. "mp4", "m4a"
    pub height: Option<u64>,
    pub is_audio_only: bool,
    pub filesize_approx: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoAnalysisResult {
    pub url: String,
    pub title: String,
    pub duration_seconds: Option<u64>,
    pub thumbnail_url: Option<String>,
    pub qualities: Vec<VideoQualityOption>,
}

pub async fn analyze_video_url(bin_dir: &Path, url: &str) -> Result<VideoAnalysisResult, String> {
    analyze_video_url_with_headers(bin_dir, url, None, None, None, None).await
}

pub async fn analyze_video_url_with_headers(
    bin_dir: &Path,
    url: &str,
    cookies: Option<&str>,
    referrer: Option<&str>,
    user_agent: Option<&str>,
    fallback_title: Option<&str>,
) -> Result<VideoAnalysisResult, String> {
    // 1. Sanitize / validate URL
    let parsed_url = url::Url::parse(url).map_err(|_| "Geçersiz web adresi.".to_string())?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("Yalnızca HTTP ve HTTPS video bağlantıları desteklenir.".to_string());
    }

    // 2. Locate yt-dlp
    let ytdlp_path = find_yt_dlp(bin_dir).ok_or_else(|| {
        "yt-dlp bulunamadı! Lütfen Ayarlar > Araçlar sekmesinden 'yt-dlp İndir' butonuna tıklayarak aracı yükleyin."
            .to_string()
    })?;

    // 3. Execute yt-dlp securely with direct arguments
    let mut cmd = create_hidden_command(&ytdlp_path);
    cmd.args([
        "--dump-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
    ]);
    if let Some(r) = referrer.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--referer", r]);
    }
    if let Some(ua) = user_agent.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--user-agent", ua]);
    }
    if let Some(c) = cookies.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--add-header", &format!("Cookie:{}", c)]);
    }
    cmd.arg(url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("yt-dlp analiz süreci başlatılamadı: {}", e))?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        let err_lower = err_text.to_lowercase();

        if err_lower.contains("drm") {
            return Err("Bu içerik DRM korumalıdır ve indirilemez.".to_string());
        }
        if err_lower.contains("private video") || err_lower.contains("sign in") {
            return Err("Bu video gizli veya erişim izni gerektiriyor.".to_string());
        }
        if err_lower.contains("unsupported url") {
            return Err("Desteklenmeyen veya geçersiz video bağlantısı.".to_string());
        }
        return Err(format!("Video bilgisi alınamadı: {}", err_text.trim()));
    }

    // 4. Parse JSON metadata (robustly handle single JSON, multiple JSON lines for multi-video tweets, or trailing text)
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let trimmed_stdout = stdout_text.trim();

    // First attempt: Try extracting the first valid JSON line (typical for yt-dlp multi-video or tweet threads)
    let mut parsed_val: Option<serde_json::Value> = None;
    for line in trimmed_stdout.lines() {
        let l = line.trim();
        if l.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
                if v.get("id").is_some() || v.get("title").is_some() || v.get("formats").is_some() {
                    parsed_val = Some(v);
                    break;
                }
            }
        }
    }

    // Second attempt: Try serde_json Stream Deserializer (handles multiple objects on separate lines)
    let val = match parsed_val {
        Some(v) => v,
        None => {
            let stream = serde_json::Deserializer::from_str(trimmed_stdout).into_iter::<serde_json::Value>();
            let mut found = None;
            for item in stream {
                if let Ok(v) = item {
                    if v.get("id").is_some() || v.get("title").is_some() || v.get("formats").is_some() {
                        found = Some(v);
                        break;
                    }
                }
            }
            match found {
                Some(v) => v,
                None => {
                    serde_json::from_str::<serde_json::Value>(trimmed_stdout)
                        .map_err(|e| format!("Video meta verisi çözümlenemedi: {}", e))?
                }
            }
        }
    };

    let sanitize_title = |raw: &str| -> String {
        raw.chars()
            .map(|c| if ['\\', '/', ':', '*', '?', '"', '<', '>', '|'].contains(&c) { '_' } else { c })
            .collect::<String>()
            .trim()
            .to_string()
    };

    let raw_title = val["title"].as_str().unwrap_or("video");
    let safe_title = sanitize_title(raw_title);
    let lower_title = safe_title.to_lowercase();
    let is_generic_stream_title = safe_title.is_empty()
        || matches!(
            lower_title.as_str(),
            "master" | "index" | "playlist" | "manifest" | "video" | "basliksiz_video"
        )
        || lower_title.starts_with("media_")
        || lower_title.starts_with("hls_")
        || lower_title.starts_with("chunklist");

    let title = if is_generic_stream_title {
        fallback_title
            .map(sanitize_title)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| if safe_title.is_empty() { "video".to_string() } else { safe_title })
    } else {
        safe_title
    };
    let duration = val["duration"].as_u64();
    let thumbnail = val["thumbnail"].as_str().map(|s| s.to_string());

    // Exact byte size from HTTP/DASH headers; ignore HLS (m3u8) manifest estimates
    let extract_exact_size = |f: &serde_json::Value| -> Option<u64> {
        if f["protocol"].as_str().unwrap_or("").contains("m3u8") {
            return None;
        }
        f["filesize"]
            .as_u64()
            .filter(|&sz| sz > 0)
            .or_else(|| f["filesize_approx"].as_u64().filter(|&sz| sz > 0))
    };

    // Fallback bitrate * duration estimate when exact byte sizes are absent
    let extract_est_size = |f: &serde_json::Value| -> Option<u64> {
        let dur = duration.filter(|&d| d > 0)?;
        let rate = f["tbr"].as_f64().or_else(|| {
            let vbr = f["vbr"].as_f64().unwrap_or(0.0);
            let abr = f["abr"].as_f64().unwrap_or(0.0);
            (vbr + abr > 0.0).then_some(vbr + abr)
        })?;
        if rate > 0.0 {
            let bytes = (rate * 1000.0 / 8.0 * (dur as f64)) as u64;
            if bytes > 0 {
                return Some(bytes);
            }
        }
        None
    };

    // yt-dlp sorts formats ascending by preference, so the last matching stream wins
    let record_stream_size =
        |f: &serde_json::Value, exact: &mut Option<u64>, est: &mut Option<u64>| {
            if let Some(sz) = extract_exact_size(f) {
                *exact = Some(sz);
            } else if let Some(sz) = extract_est_size(f) {
                *est = Some(sz);
            }
        };

    // 5. Inspect available raw formats and find the preferred audio stream size
    let mut available_heights = BTreeSet::new();
    let mut has_audio = false;
    let mut last_exact_audio: Option<u64> = None;
    let mut last_est_audio: Option<u64> = None;

    if let Some(formats) = val["formats"].as_array() {
        for f in formats {
            let vcodec = f["vcodec"].as_str().unwrap_or("none");
            let acodec = f["acodec"].as_str().unwrap_or("none");
            if acodec != "none" {
                has_audio = true;
                if vcodec == "none" {
                    record_stream_size(f, &mut last_exact_audio, &mut last_est_audio);
                }
            }
            if let Some(h) = f["height"].as_u64() {
                if h > 0 {
                    available_heights.insert(h);
                }
            }
        }
    }
    let best_audio_size = last_exact_audio.or(last_est_audio);

    // Helper to calculate total merged/single size for a target height
    let calc_size_for_height = |target_h: u64| -> Option<u64> {
        let mut last_exact_video: Option<u64> = None;
        let mut last_est_video: Option<u64> = None;
        let mut last_exact_single: Option<u64> = None;
        let mut last_est_single: Option<u64> = None;

        if let Some(formats) = val["formats"].as_array() {
            for f in formats {
                if f["height"].as_u64() == Some(target_h) {
                    let vcodec = f["vcodec"].as_str().unwrap_or("none");
                    let acodec = f["acodec"].as_str().unwrap_or("none");
                    if vcodec != "none" && acodec == "none" {
                        record_stream_size(f, &mut last_exact_video, &mut last_est_video);
                    } else if vcodec != "none" && acodec != "none" {
                        record_stream_size(f, &mut last_exact_single, &mut last_est_single);
                    }
                }
            }
        }

        if let Some(video) = last_exact_video.or(last_est_video) {
            Some(video + best_audio_size.unwrap_or(0))
        } else if let Some(single) = last_exact_single.or(last_est_single) {
            Some(single)
        } else {
            val["filesize"].as_u64().or_else(|| val["filesize_approx"].as_u64())
        }
    };

    // Standard resolutions to check against available heights
    let standard_targets = [
        (2160, "4K (2160p)"),
        (1440, "2K (1440p)"),
        (1080, "1080p Full HD"),
        (720, "720p HD"),
        (480, "480p SD"),
        (360, "360p"),
        (240, "240p"),
    ];

    let mut qualities = Vec::new();

    for (target_h, label) in standard_targets {
        // Only include if video source actually supports this height or greater
        let supports = available_heights.iter().any(|&h| h == target_h);
        if supports {
            let est_size = calc_size_for_height(target_h);
            qualities.push(VideoQualityOption {
                id: format!("{}p", target_h),
                label: label.to_string(),
                format_spec: format!("bestvideo[height<={target_h}]+bestaudio/best[height<={target_h}]/best"),
                extension: "mp4".to_string(),
                height: Some(target_h),
                is_audio_only: false,
                filesize_approx: est_size,
            });
        }
    }

    // If source has unique non-standard heights, add highest available
    if qualities.is_empty() {
        if let Some(&max_h) = available_heights.iter().max() {
            let est_size = calc_size_for_height(max_h);
            qualities.push(VideoQualityOption {
                id: format!("{}p", max_h),
                label: format!("{}p En Yüksek Kalite", max_h),
                format_spec: format!("bestvideo[height<={max_h}]+bestaudio/best[height<={max_h}]/best"),
                extension: "mp4".to_string(),
                height: Some(max_h),
                is_audio_only: false,
                filesize_approx: est_size,
            });
        } else {
            // Default best fallback
            let fallback_size = val["filesize"].as_u64().or_else(|| val["filesize_approx"].as_u64());
            qualities.push(VideoQualityOption {
                id: "best".to_string(),
                label: "En İyi Kalite".to_string(),
                format_spec: "bestvideo+bestaudio/best".to_string(),
                extension: "mp4".to_string(),
                height: None,
                is_audio_only: false,
                filesize_approx: fallback_size,
            });
        }
    }

    // Add audio-only option if audio exists
    if has_audio {
        qualities.push(VideoQualityOption {
            id: "audio_only".to_string(),
            label: "Yalnızca Ses (En Yüksek Kalite - M4A/MP3)".to_string(),
            format_spec: "bestaudio/best".to_string(),
            extension: "m4a".to_string(),
            height: None,
            is_audio_only: true,
            filesize_approx: best_audio_size,
        });
    }

    Ok(VideoAnalysisResult {
        url: url.to_string(),
        title,
        duration_seconds: duration,
        thumbnail_url: thumbnail,
        qualities,
    })
}
