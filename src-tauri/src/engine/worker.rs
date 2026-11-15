use crate::engine::task::SegmentProgress;
use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, COOKIE, RANGE, REFERER, USER_AGENT};
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter, SeekFrom};
use tokio::sync::watch;

struct RateLimiterState {
    window_start: Instant,
    bytes_in_window: u64,
}

#[derive(Clone)]
pub struct RateLimiter {
    limit_bytes_per_sec: Arc<AtomicU64>,
    state: Arc<tokio::sync::Mutex<RateLimiterState>>,
}

impl RateLimiter {
    pub fn new(limit_bytes_per_sec: Option<u64>) -> Self {
        Self {
            limit_bytes_per_sec: Arc::new(AtomicU64::new(limit_bytes_per_sec.unwrap_or(0))),
            state: Arc::new(tokio::sync::Mutex::new(RateLimiterState {
                window_start: Instant::now(),
                bytes_in_window: 0,
            })),
        }
    }

    pub fn unlimited() -> Self {
        Self::new(None)
    }

    pub fn set_limit(&self, limit_bytes_per_sec: Option<u64>) {
        self.limit_bytes_per_sec
            .store(limit_bytes_per_sec.unwrap_or(0), Ordering::Relaxed);
    }

    pub fn get_limit(&self) -> u64 {
        self.limit_bytes_per_sec.load(Ordering::Relaxed)
    }

    pub async fn acquire(&self, bytes: usize) {
        let limit = self.limit_bytes_per_sec.load(Ordering::Relaxed);
        if limit == 0 {
            return;
        }

        let mut lock = self.state.lock().await;
        let now = Instant::now();
        let elapsed = now.duration_since(lock.window_start);

        if elapsed >= Duration::from_millis(1000) {
            lock.window_start = now;
            lock.bytes_in_window = bytes as u64;
            return;
        }

        lock.bytes_in_window += bytes as u64;
        if lock.bytes_in_window > limit {
            let sleep_duration = Duration::from_millis(1000).saturating_sub(elapsed);
            if !sleep_duration.is_zero() {
                drop(lock);
                tokio::time::sleep(sleep_duration).await;
                let mut lock2 = self.state.lock().await;
                lock2.window_start = Instant::now();
                lock2.bytes_in_window = 0;
            }
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum WorkerError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Task was cancelled or paused")]
    Cancelled,
    #[error("Unexpected server status: {0}")]
    HttpStatus(u16),
    #[error("Server ignored HTTP Range request and returned HTTP {0}")]
    RangeIgnoredByServer(u16),
    #[error("Invalid Content-Range header from server: expected start {expected}, got {actual:?}")]
    InvalidContentRange { expected: u64, actual: Option<String> },
    #[error("Segment {index} stream terminated prematurely: expected {expected} bytes, received {received} bytes")]
    IncompleteSegment { index: usize, expected: u64, received: u64 },
    #[error("Missing segment part file: {0}")]
    MissingPartFile(String),
    #[error("Corrupt segment part #{index}: expected size {expected} bytes, but file has {actual} bytes")]
    CorruptPartFile { index: usize, expected: u64, actual: u64 },
    #[error("Integrity check failed: expected total {expected} bytes, merged {actual} bytes")]
    IntegrityMismatch { expected: u64, actual: u64 },
}

pub type MergeProgressCallback = Box<dyn Fn(f64) + Send + Sync>;

pub struct DownloadWorker;

async fn wait_for_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

impl DownloadWorker {
    pub async fn safe_swap_file(temp_path: &Path, dest_path: &Path) -> Result<(), WorkerError> {
        let backup_path = PathBuf::from(format!("{}.mdmbak", dest_path.display()));
        let had_existing = dest_path.exists();

        if had_existing {
            if backup_path.exists() {
                let _ = tokio::fs::remove_file(&backup_path).await;
            }
            tokio::fs::rename(dest_path, &backup_path).await?;
        }

        match tokio::fs::rename(temp_path, dest_path).await {
            Ok(()) => {
                if had_existing && backup_path.exists() {
                    let _ = tokio::fs::remove_file(&backup_path).await;
                }
                Ok(())
            }
            Err(e) => {
                // Rollback backup file so existing data is never destroyed
                if had_existing && backup_path.exists() {
                    let _ = tokio::fs::rename(&backup_path, dest_path).await;
                }
                Err(WorkerError::Io(e))
            }
        }
    }

    pub async fn download_single(
        client: &Client,
        url: &str,
        dest_path: &str,
        supports_range: bool,
        downloaded_counter: Arc<AtomicU64>,
        total_counter: Arc<AtomicU64>,
        rate_limiter: Option<RateLimiter>,
        cancel_rx: watch::Receiver<bool>,
        cookies: Option<&str>,
        referrer: Option<&str>,
        user_agent: Option<&str>,
    ) -> Result<(), WorkerError> {
        let temp_path = format!("{}.mdmpart", dest_path);
        let mut existing_len = 0u64;

        if supports_range {
            if let Ok(metadata) = tokio::fs::metadata(&temp_path).await {
                existing_len = metadata.len();
            }
        }

        let mut file = if existing_len > 0 && supports_range {
            let mut f = OpenOptions::new()
                .create(true)
                .write(true)
                .open(&temp_path)
                .await?;
            f.seek(SeekFrom::Start(existing_len)).await?;
            downloaded_counter.store(existing_len, Ordering::SeqCst);
            f
        } else {
            downloaded_counter.store(0, Ordering::SeqCst);
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&temp_path)
                .await?
        };

        let mut req = client.get(url);
        if let Some(c) = cookies {
            req = req.header(COOKIE, c);
        }
        if let Some(r) = referrer {
            req = req.header(REFERER, r);
        }
        if let Some(ua) = user_agent {
            req = req.header(USER_AGENT, ua);
        }
        if supports_range && existing_len > 0 {
            req = req.header(RANGE, format!("bytes={}-", existing_len));
        }

        let mut send_cancel_rx = cancel_rx.clone();
        let resp = tokio::select! {
            biased;
            _ = wait_for_cancel(&mut send_cancel_rx) => return Err(WorkerError::Cancelled),
            res = req.send() => res?,
        };
        let status = resp.status();

        if supports_range && existing_len > 0 {
            if status.as_u16() != 206 {
                // Server did not honor range resume: restart from scratch
                drop(file);
                downloaded_counter.store(0, Ordering::SeqCst);
                if let Some(len) = resp.content_length() {
                    if len > 0 {
                        total_counter.store(len, Ordering::SeqCst);
                    }
                }
                let mut f = OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&temp_path)
                    .await?;
                return Self::stream_to_file(resp, &mut f, downloaded_counter, rate_limiter, cancel_rx, &temp_path, dest_path).await;
            } else {
                // 206 Partial Content resume: discover full total from Content-Range or existing_len + content_length
                let parsed_total = resp
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|cr| cr.rfind('/').and_then(|i| cr[i + 1..].trim().parse::<u64>().ok()));
                if let Some(tot) = parsed_total {
                    if tot > 0 {
                        total_counter.store(tot, Ordering::SeqCst);
                    }
                } else if let Some(rem) = resp.content_length() {
                    total_counter.store(existing_len + rem, Ordering::SeqCst);
                }
            }
        } else {
            if !status.is_success() && status.as_u16() != 206 {
                return Err(WorkerError::HttpStatus(status.as_u16()));
            }
            if let Some(len) = resp.content_length() {
                if len > 0 {
                    total_counter.store(len, Ordering::SeqCst);
                }
            }
        }

        Self::stream_to_file(resp, &mut file, downloaded_counter, rate_limiter, cancel_rx, &temp_path, dest_path).await
    }

    async fn stream_to_file(
        resp: reqwest::Response,
        file: &mut File,
        downloaded_counter: Arc<AtomicU64>,
        rate_limiter: Option<RateLimiter>,
        mut cancel_rx: watch::Receiver<bool>,
        temp_path: &str,
        dest_path: &str,
    ) -> Result<(), WorkerError> {
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        let mut stream = resp.bytes_stream();

        loop {
            let next_item = tokio::select! {
                biased;
                _ = wait_for_cancel(&mut cancel_rx) => None,
                item = tokio::time::timeout(Duration::from_secs(30), stream.next()) => Some(item),
            };
            let chunk = match next_item {
                Some(Ok(Some(Ok(bytes)))) => bytes,
                Some(Ok(Some(Err(e)))) => {
                    let _ = writer.flush().await;
                    return Err(WorkerError::Network(e));
                }
                Some(Ok(None)) => break,
                Some(Err(_)) => {
                    let _ = writer.flush().await;
                    return Err(WorkerError::Io(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Veri akışı zaman aşımına uğradı (30 sn)",
                    )));
                }
                None => {
                    let _ = writer.flush().await;
                    return Err(WorkerError::Cancelled);
                }
            };
            if let Some(limiter) = &rate_limiter {
                limiter.acquire(chunk.len()).await;
            }
            writer.write_all(&chunk).await?;
            downloaded_counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }

        writer.flush().await?;
        Self::safe_swap_file(Path::new(temp_path), Path::new(dest_path)).await?;
        Ok(())
    }

    pub async fn download_segment(
        client: &Client,
        url: &str,
        temp_part_path: PathBuf,
        seg_index: usize,
        start_byte: u64,
        end_byte: u64,
        existing_downloaded: u64,
        seg_counter: Arc<AtomicU64>,
        downloaded_counter: Arc<AtomicU64>,
        rate_limiter: Option<RateLimiter>,
        mut cancel_rx: watch::Receiver<bool>,
        cookies: Option<&str>,
        referrer: Option<&str>,
        user_agent: Option<&str>,
    ) -> Result<(), WorkerError> {
        let seg_expected = end_byte.saturating_sub(start_byte) + 1;

        // If segment is already fully downloaded on disk, verify and return
        if existing_downloaded >= seg_expected {
            seg_counter.store(seg_expected, Ordering::SeqCst);
            return Ok(());
        }

        let resume_start = start_byte + existing_downloaded;
        let expected_bytes_to_read = end_byte.saturating_sub(resume_start) + 1;

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .open(&temp_part_path)
            .await?;

        file.seek(SeekFrom::Start(existing_downloaded)).await?;
        file.set_len(existing_downloaded).await?;

        let range_header = format!("bytes={}-{}", resume_start, end_byte);
        let mut req = client.get(url).header(RANGE, range_header);
        if let Some(c) = cookies {
            req = req.header(COOKIE, c);
        }
        if let Some(r) = referrer {
            req = req.header(REFERER, r);
        }
        if let Some(ua) = user_agent {
            req = req.header(USER_AGENT, ua);
        }
        let mut send_cancel_rx = cancel_rx.clone();
        let resp = tokio::select! {
            biased;
            _ = wait_for_cancel(&mut send_cancel_rx) => return Err(WorkerError::Cancelled),
            res = req.send() => res?,
        };
        let status = resp.status();

        // Server MUST return 206 Partial Content when a range is requested!
        // If server returns 200 OK, it ignored the range header and is sending the entire file from 0!
        if status.as_u16() == 200 {
            return Err(WorkerError::RangeIgnoredByServer(200));
        }

        if status.as_u16() != 206 {
            return Err(WorkerError::HttpStatus(status.as_u16()));
        }

        // Validate Content-Range header: bytes START-END/TOTAL
        if let Some(content_range) = resp.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
            if let Some(bytes_pos) = content_range.find("bytes ") {
                let range_part = &content_range[bytes_pos + 6..];
                if let Some(dash_pos) = range_part.find('-') {
                    if let Ok(returned_start) = range_part[..dash_pos].trim().parse::<u64>() {
                        if returned_start != resume_start {
                            return Err(WorkerError::InvalidContentRange {
                                expected: resume_start,
                                actual: Some(content_range.to_string()),
                            });
                        }
                    }
                }
            }
        }

        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        let mut stream = resp.bytes_stream();
        let mut session_bytes_read = 0u64;

        loop {
            let next_item = tokio::select! {
                biased;
                _ = wait_for_cancel(&mut cancel_rx) => None,
                item = tokio::time::timeout(Duration::from_secs(30), stream.next()) => Some(item),
            };
            let chunk = match next_item {
                Some(Ok(Some(Ok(bytes)))) => bytes,
                Some(Ok(Some(Err(e)))) => {
                    let _ = writer.flush().await;
                    return Err(WorkerError::Network(e));
                }
                Some(Ok(None)) => break,
                Some(Err(_)) => {
                    let _ = writer.flush().await;
                    return Err(WorkerError::Io(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Parça veri akışı zaman aşımına uğradı (30 sn)",
                    )));
                }
                None => {
                    let _ = writer.flush().await;
                    return Err(WorkerError::Cancelled);
                }
            };
            if let Some(limiter) = &rate_limiter {
                limiter.acquire(chunk.len()).await;
            }
            writer.write_all(&chunk).await?;
            session_bytes_read += chunk.len() as u64;
            downloaded_counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            seg_counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }

        writer.flush().await?;

        // Verify that the exact number of expected bytes was received
        if session_bytes_read != expected_bytes_to_read {
            return Err(WorkerError::IncompleteSegment {
                index: seg_index,
                expected: expected_bytes_to_read,
                received: session_bytes_read,
            });
        }

        Ok(())
    }

    pub async fn finalize_segments(
        dest_path: &str,
        part_paths: Vec<PathBuf>,
        expected_segments: &[SegmentProgress],
        total_bytes: Option<u64>,
    ) -> Result<(), WorkerError> {
        Self::finalize_segments_with_progress(
            dest_path,
            part_paths,
            expected_segments,
            total_bytes,
            None,
        )
        .await
    }

    pub async fn finalize_segments_with_progress(
        dest_path: &str,
        part_paths: Vec<PathBuf>,
        expected_segments: &[SegmentProgress],
        total_bytes: Option<u64>,
        progress_cb: Option<MergeProgressCallback>,
    ) -> Result<(), WorkerError> {
        // 1. Strict pre-validation: every single part file must exist and have the exact expected length
        for (idx, seg) in expected_segments.iter().enumerate() {
            let part_path = &part_paths[idx];
            if !part_path.exists() {
                return Err(WorkerError::MissingPartFile(part_path.display().to_string()));
            }

            let meta = tokio::fs::metadata(part_path).await?;
            let expected_seg_len = seg.end_byte.saturating_sub(seg.start_byte) + 1;
            if meta.len() != expected_seg_len {
                return Err(WorkerError::CorruptPartFile {
                    index: seg.index,
                    expected: expected_seg_len,
                    actual: meta.len(),
                });
            }
        }

        let expected_total = total_bytes
            .unwrap_or_else(|| {
                expected_segments
                    .iter()
                    .map(|s| s.end_byte.saturating_sub(s.start_byte) + 1)
                    .sum()
            })
            .max(1);

        if let Some(ref cb) = progress_cb {
            cb(0.0);
        }

        let merge_start = Instant::now();
        let mut last_emit = merge_start;
        let mut last_pct = 0.0f64;

        let temp_final = format!("{}.mdmmerge", dest_path);
        let mut final_file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp_final)
            .await?;

        let mut buffer = vec![0u8; 256 * 1024]; // 256KB high-efficiency merge buffer
        let mut total_merged = 0u64;

        for part_path in &part_paths {
            let mut part_file = File::open(part_path).await?;
            loop {
                let n = part_file.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                final_file.write_all(&buffer[..n]).await?;
                total_merged += n as u64;

                if let Some(ref cb) = progress_cb {
                    let pct = ((total_merged as f64 / expected_total as f64) * 100.0).clamp(0.0, 99.9);
                    if pct - last_pct >= 2.0 && last_emit.elapsed() >= Duration::from_millis(35) {
                        last_pct = pct;
                        last_emit = Instant::now();
                        cb(pct);
                    }
                }
            }
            final_file.flush().await?;
        }

        drop(final_file);

        // 2. Strict total length verification
        if let Some(expected) = total_bytes {
            if total_merged != expected {
                let _ = tokio::fs::remove_file(&temp_final).await;
                return Err(WorkerError::IntegrityMismatch {
                    expected,
                    actual: total_merged,
                });
            }
        }

        // 3. On Windows, handle target file replacement safely with rollback guarantee
        Self::safe_swap_file(Path::new(&temp_final), Path::new(dest_path)).await?;

        // 4. Cleanup temporary segment files after successful atomic rename
        for part_path in &part_paths {
            let _ = tokio::fs::remove_file(part_path).await;
        }

        if let Some(ref cb) = progress_cb {
            if merge_start.elapsed() < Duration::from_millis(300) {
                for step in [25.0, 55.0, 85.0, 100.0] {
                    if step > last_pct {
                        cb(step);
                        tokio::time::sleep(Duration::from_millis(55)).await;
                    }
                }
            } else {
                cb(100.0);
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        }

        Ok(())
    }

    /// Compute SHA-256 hash of a file for cryptographic integrity verification
    pub async fn compute_file_sha256<P: AsRef<Path>>(path: P) -> Result<String, WorkerError> {
        let mut file = File::open(path).await?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];

        loop {
            let n = file.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }

        Ok(format!("{:x}", hasher.finalize()))
    }
}
