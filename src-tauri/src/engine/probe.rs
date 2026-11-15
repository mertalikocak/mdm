use reqwest::header::{
    ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, COOKIE, ETAG, LAST_MODIFIED, RANGE,
    REFERER, USER_AGENT,
};
use reqwest::Client;
use std::path::Path;
use url::Url;

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub resolved_url: String,
    pub filename: String,
    pub total_bytes: Option<u64>,
    pub supports_range: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(thiserror::Error, Debug)]
pub enum ProbeError {
    #[error("Invalid URL format: {0}")]
    InvalidUrl(String),
    #[error("Unsupported URL scheme: {0}. Only http and https are allowed.")]
    UnsupportedScheme(String),
    #[error("Network request failed: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Server returned error status: {0}")]
    HttpStatus(reqwest::StatusCode),
}

pub async fn probe_url(client: &Client, raw_url: &str) -> Result<ProbeResult, ProbeError> {
    probe_url_with_headers(client, raw_url, None, None, None).await
}

pub async fn probe_url_with_headers(
    client: &Client,
    raw_url: &str,
    cookies: Option<&str>,
    referrer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<ProbeResult, ProbeError> {
    let parsed_url = Url::parse(raw_url).map_err(|e| ProbeError::InvalidUrl(e.to_string()))?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err(ProbeError::UnsupportedScheme(parsed_url.scheme().to_string()));
    }

    // Try a HEAD request first with optional credentials
    let mut head_req = client.head(raw_url);
    if let Some(c) = cookies {
        head_req = head_req.header(COOKIE, c);
    }
    if let Some(r) = referrer {
        head_req = head_req.header(REFERER, r);
    }
    if let Some(ua) = user_agent {
        head_req = head_req.header(USER_AGENT, ua);
    }
    let head_resp = head_req.send().await;

    let head_ok = match head_resp {
        Ok(resp) if resp.status().is_success() => {
            let final_url = resp.url().to_string();
            let headers = resp.headers().clone();
            let status = resp.status();
            let has_len = headers
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .is_some();
            let has_accept_ranges = headers
                .get(ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .map(|a| a.to_ascii_lowercase().contains("bytes"))
                .unwrap_or(false);
            Some((final_url, headers, status, has_len && has_accept_ranges))
        }
        _ => None,
    };

    let (final_url, headers, status) = match head_ok {
        Some((u, h, s, true)) => (u, h, s),
        head_fallback => {
            // Fallback to GET with Range: bytes=0-0 when HEAD failed or omitted Content-Length/Accept-Ranges
            let mut range_req = client.get(raw_url).header(RANGE, "bytes=0-0");
            if let Some(c) = cookies {
                range_req = range_req.header(COOKIE, c);
            }
            if let Some(r) = referrer {
                range_req = range_req.header(REFERER, r);
            }
            if let Some(ua) = user_agent {
                range_req = range_req.header(USER_AGENT, ua);
            }
            match range_req.send().await {
                Ok(range_resp)
                    if range_resp.status().is_success() || range_resp.status().as_u16() == 206 =>
                {
                    let final_url = range_resp.url().to_string();
                    let headers = range_resp.headers().clone();
                    let status = range_resp.status();
                    (final_url, headers, status)
                }
                Ok(range_resp) => {
                    if let Some((u, h, s, _)) = head_fallback {
                        (u, h, s)
                    } else {
                        return Err(ProbeError::HttpStatus(range_resp.status()));
                    }
                }
                Err(e) => {
                    if let Some((u, h, s, _)) = head_fallback {
                        (u, h, s)
                    } else {
                        return Err(ProbeError::Network(e));
                    }
                }
            }
        }
    };

    // 1. Determine Content-Length
    let mut total_bytes = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    // If we used a 206 Partial Content response, parse Content-Range: bytes 0-0/123456
    let mut supports_range = status.as_u16() == 206;
    if let Some(content_range) = headers.get("content-range").and_then(|v| v.to_str().ok()) {
        supports_range = true;
        if let Some(slash_idx) = content_range.rfind('/') {
            let total_str = &content_range[slash_idx + 1..];
            if let Ok(len) = total_str.parse::<u64>() {
                total_bytes = Some(len);
            }
        }
    }

    // Check Accept-Ranges header
    if !supports_range {
        if let Some(accept) = headers.get(ACCEPT_RANGES).and_then(|v| v.to_str().ok()) {
            if accept.to_ascii_lowercase().contains("bytes") {
                supports_range = true;
            }
        }
    }

    // Extract validators
    let etag = headers
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    let last_modified = headers
        .get(LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Extract filename
    let filename = extract_filename(&headers, &final_url);

    Ok(ProbeResult {
        resolved_url: final_url,
        filename,
        total_bytes,
        supports_range: supports_range && total_bytes.is_some() && total_bytes.unwrap_or(0) >= 1024,
        etag,
        last_modified,
    })
}

fn extract_filename(headers: &reqwest::header::HeaderMap, url_str: &str) -> String {
    // 1. Check Content-Disposition: attachment; filename="example.zip" or filename*=UTF-8''example.zip
    if let Some(disp) = headers.get(CONTENT_DISPOSITION).and_then(|v| v.to_str().ok()) {
        if let Some(fn_star) = disp.find("filename*=") {
            let rest = &disp[fn_star + 10..];
            let clean = rest.trim_matches(|c| c == ' ' || c == '"' || c == ';');
            if let Some(pos) = clean.find("''") {
                let encoded = &clean[pos + 2..];
                if let Ok(decoded) = percent_encoding::percent_decode_str(encoded).decode_utf8() {
                    let sanitized = sanitize_filename(&decoded);
                    if !sanitized.is_empty() {
                        return sanitized;
                    }
                }
            }
        }

        if let Some(fn_pos) = disp.find("filename=") {
            let rest = &disp[fn_pos + 9..];
            let clean = rest.split(';').next().unwrap_or("").trim().trim_matches('"');
            let sanitized = sanitize_filename(clean);
            if !sanitized.is_empty() {
                return sanitized;
            }
        }
    }

    // 2. Extract from URL path
    if let Ok(parsed) = Url::parse(url_str) {
        if let Some(segments) = parsed.path_segments() {
            if let Some(last) = segments.last() {
                if !last.is_empty() {
                    let decoded = percent_encoding::percent_decode_str(last)
                        .decode_utf8_lossy()
                        .to_string();
                    let sanitized = sanitize_filename(&decoded);
                    if !sanitized.is_empty() && sanitized.contains('.') {
                        return sanitized;
                    } else if !sanitized.is_empty() {
                        return sanitized;
                    }
                }
            }
        }
    }

    // 3. Fallback timestamp
    format!("download_{}.bin", chrono::Utc::now().timestamp())
}

pub fn sanitize_filename(name: &str) -> String {
    let without_traversal = name.replace("..", "__");
    let sanitized: String = without_traversal
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .collect();
    sanitized.trim().trim_matches('.').to_string()
}

pub fn get_collision_free_path(dest_dir: &str, filename: &str) -> String {
    let dest_path = Path::new(dest_dir);
    let original = dest_path.join(filename);
    if !original.exists() {
        return original.to_string_lossy().to_string();
    }

    let file_stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let mut counter = 1;
    loop {
        let candidate = dest_path.join(format!("{}_{}{}", file_stem, counter, ext));
        if !candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        counter += 1;
    }
}
