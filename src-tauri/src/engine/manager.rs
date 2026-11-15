use crate::db::Database;
use crate::engine::planner::plan_segments;
use crate::engine::probe::{get_collision_free_path, probe_url_with_headers};
use crate::engine::task::{DownloadStatus, DownloadTask, EngineStats};
use crate::engine::worker::{DownloadWorker, RateLimiter, WorkerError};
use chrono::Utc;
use reqwest::Client;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, RwLock};

pub fn cleanup_task_temp_files(dest_path: &str) {
    for suffix in [".mdmpart", ".mdmmerge", ".mdmbak", ".part"] {
        let p = format!("{}{}", dest_path, suffix);
        if Path::new(&p).exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    let dest = Path::new(dest_path);
    if let (Some(parent), Some(file_name)) = (dest.parent(), dest.file_name().and_then(|n| n.to_str())) {
        let part_prefix = format!("{}.part", file_name);
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if let Some(rest) = name.strip_prefix(&part_prefix) {
                        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
}

pub type ProgressEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

struct ActiveTask {
    cancel_tx: watch::Sender<bool>,
    done_rx: watch::Receiver<bool>,
    downloaded_counter: Arc<AtomicU64>,
}

pub struct DownloadManager {
    client: Client,
    db: Arc<Database>,
    progress_emitter: Option<ProgressEmitter>,
    active_tasks: Arc<RwLock<HashMap<String, ActiveTask>>>,
    max_concurrent: usize,
    global_rate_limiter: RateLimiter,
}

impl DownloadManager {
    pub fn new(db: Arc<Database>, max_concurrent: usize) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 MDM/0.1")
            .build()
            .unwrap_or_default();

        let initial_limit = if let Ok(Some(val)) = db.get_setting("app_settings") {
            serde_json::from_str::<crate::engine::task::AppSettings>(&val)
                .ok()
                .and_then(|s| s.global_speed_limit_bytes)
        } else {
            None
        };

        Self {
            client,
            db,
            progress_emitter: None,
            active_tasks: Arc::new(RwLock::new(HashMap::new())),
            max_concurrent,
            global_rate_limiter: RateLimiter::new(initial_limit),
        }
    }

    pub fn set_speed_limit(&self, limit_bytes_per_sec: Option<u64>) {
        self.global_rate_limiter.set_limit(limit_bytes_per_sec);
    }

    pub fn set_progress_emitter(&mut self, emitter: ProgressEmitter) {
        self.progress_emitter = Some(emitter);
    }

    pub fn get_client(&self) -> &Client {
        &self.client
    }

    pub async fn add_task(
        &self,
        url: &str,
        destination_dir: &str,
        segments_count: usize,
    ) -> Result<DownloadTask, String> {
        self.add_task_with_options(url, None, destination_dir, segments_count, true, None, None, None).await
    }

    pub async fn add_task_with_options(
        &self,
        url: &str,
        custom_filename: Option<String>,
        destination_dir: &str,
        segments_count: usize,
        start_immediately: bool,
        cookies: Option<String>,
        referrer: Option<String>,
        user_agent: Option<String>,
    ) -> Result<DownloadTask, String> {
        let probe = crate::engine::probe::probe_url_with_headers(
            &self.client,
            url,
            cookies.as_deref(),
            referrer.as_deref(),
            user_agent.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;

        let filename = match custom_filename {
            Some(f) if !f.trim().is_empty() => crate::engine::probe::sanitize_filename(&f),
            _ => probe.filename,
        };

        let final_dest = get_collision_free_path(destination_dir, &filename);
        let planned_segments = plan_segments(probe.total_bytes, segments_count, probe.supports_range);

        let initial_status = if start_immediately {
            DownloadStatus::Queued
        } else {
            DownloadStatus::Paused
        };

        let task = DownloadTask {
            id: uuid::Uuid::new_v4().to_string(),
            url: probe.resolved_url,
            filename,
            destination_path: final_dest,
            total_bytes: probe.total_bytes,
            downloaded_bytes: 0,
            speed_bytes_per_sec: 0,
            eta_seconds: None,
            status: initial_status,
            error_message: None,
            supports_range: probe.supports_range,
            segment_count: planned_segments.len(),
            segments: planned_segments,
            etag: probe.etag,
            last_modified: probe.last_modified,
            created_at: Utc::now(),
            completed_at: None,
            cookies,
            referrer,
            user_agent,
        };

        self.db
            .insert_or_update_task(&task)
            .map_err(|e| e.to_string())?;

        if start_immediately {
            self.process_queue().await;
        }

        Ok(task)
    }

    pub fn get_max_concurrent(&self) -> usize {
        if let Ok(Some(val)) = self.db.get_setting("app_settings") {
            if let Ok(settings) = serde_json::from_str::<crate::engine::task::AppSettings>(&val) {
                if settings.max_concurrent_downloads > 0 {
                    return settings.max_concurrent_downloads;
                }
            }
        }
        self.max_concurrent
    }

    pub async fn process_queue(&self) {
        let max = self.get_max_concurrent();
        let current_active = self.active_tasks.read().await.len();
        if current_active >= max {
            return;
        }

        let slots = max - current_active;
        if let Ok(tasks) = self.db.list_tasks() {
            let mut queued: Vec<_> = tasks
                .into_iter()
                .filter(|t| t.status == DownloadStatus::Queued)
                .collect();
            // FIFO: oldest queued tasks first
            queued.sort_by_key(|t| t.created_at);

            for next_task in queued.into_iter().take(slots) {
                let id = next_task.id;
                let is_already_active = self.active_tasks.read().await.contains_key(&id);
                if !is_already_active {
                    self.start_download(id).await;
                }
            }
        }
    }

    fn trigger_next_queued(
        db: Arc<Database>,
        active_tasks: Arc<RwLock<HashMap<String, ActiveTask>>>,
        max_concurrent: usize,
        client: Client,
        progress_emitter: Option<ProgressEmitter>,
        global_rate_limiter: RateLimiter,
    ) {
        tokio::spawn(async move {
            let active_count = active_tasks.read().await.len();
            let max = if let Ok(Some(val)) = db.get_setting("app_settings") {
                if let Ok(settings) = serde_json::from_str::<crate::engine::task::AppSettings>(&val) {
                    if settings.max_concurrent_downloads > 0 {
                        settings.max_concurrent_downloads
                    } else {
                        max_concurrent
                    }
                } else {
                    max_concurrent
                }
            } else {
                max_concurrent
            };

            if active_count >= max {
                return;
            }

            let slots = max - active_count;
            if let Ok(tasks) = db.list_tasks() {
                let mut queued: Vec<_> = tasks
                    .into_iter()
                    .filter(|t| t.status == DownloadStatus::Queued)
                    .collect();
                queued.sort_by_key(|t| t.created_at);

                for next_task in queued.into_iter().take(slots) {
                    let is_active = active_tasks.read().await.contains_key(&next_task.id);
                    if !is_active {
                        let dm_stub = DownloadManager {
                            client: client.clone(),
                            db: Arc::clone(&db),
                            progress_emitter: progress_emitter.clone(),
                            active_tasks: Arc::clone(&active_tasks),
                            max_concurrent: max,
                            global_rate_limiter: global_rate_limiter.clone(),
                        };
                        dm_stub.start_download(next_task.id).await;
                    }
                }
            }
        });
    }

    pub fn get_speed_limiter(&self) -> Option<RateLimiter> {
        if let Ok(Some(val)) = self.db.get_setting("app_settings") {
            if let Ok(settings) = serde_json::from_str::<crate::engine::task::AppSettings>(&val) {
                self.global_rate_limiter
                    .set_limit(settings.global_speed_limit_bytes);
            }
        }
        Some(self.global_rate_limiter.clone())
    }

    pub async fn start_download(&self, task_id: String) {
        let tasks = self.db.list_tasks().unwrap_or_default();
        let task = match tasks.into_iter().find(|t| t.id == task_id) {
            Some(t) => t,
            None => return,
        };

        let dest_path = task.destination_path.clone();
        let mut task = task;
        let mut is_multi_segment = task.supports_range && task.segments.len() > 1;

        // Ground truth inspection from disk
        let mut initial_part_sizes = Vec::new();
        let mut part_paths = Vec::new();

        if is_multi_segment {
            for seg in &task.segments {
                let part_file = PathBuf::from(format!("{}.part{}", dest_path, seg.index));
                let disk_size = match tokio::fs::metadata(&part_file).await {
                    Ok(m) => m.len(),
                    Err(_) => 0,
                };
                let seg_expected = seg.end_byte.saturating_sub(seg.start_byte) + 1;
                let valid_size = disk_size.min(seg_expected);
                initial_part_sizes.push(valid_size);
                part_paths.push(part_file);
            }
        } else {
            let single_part = PathBuf::from(format!("{}.mdmpart", dest_path));
            let disk_size = if task.supports_range {
                tokio::fs::metadata(&single_part).await.map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };
            initial_part_sizes.push(disk_size);
            part_paths.push(single_part);
        }

        let mut initial_downloaded: u64 = initial_part_sizes.iter().sum();

        // Freshness verification if resuming partial download
        if initial_downloaded > 0 {
            if let Ok(probe) = probe_url_with_headers(
                &self.client,
                &task.url,
                task.cookies.as_deref(),
                task.referrer.as_deref(),
                task.user_agent.as_deref(),
            )
            .await
            {
                let etag_changed = task.etag.is_some() && probe.etag.is_some() && task.etag != probe.etag;
                let modified_changed = task.last_modified.is_some() && probe.last_modified.is_some() && task.last_modified != probe.last_modified;
                let size_changed = task.total_bytes.is_some() && probe.total_bytes.is_some() && task.total_bytes != probe.total_bytes;

                if etag_changed || modified_changed || size_changed || (!probe.supports_range && task.supports_range) {
                    // Stale source! Discard invalid partial downloads to prevent data corruption
                    for p in &part_paths {
                        let _ = tokio::fs::remove_file(p).await;
                    }
                    let _ = tokio::fs::remove_file(format!("{}.mdmpart", dest_path)).await;
                    let _ = tokio::fs::remove_file(format!("{}.mdmmerge", dest_path)).await;

                    for s in initial_part_sizes.iter_mut() {
                        *s = 0;
                    }
                    initial_downloaded = 0;
                    task.etag = probe.etag;
                    task.last_modified = probe.last_modified;
                    task.total_bytes = probe.total_bytes;
                    task.supports_range = probe.supports_range;
                    task.segments = plan_segments(task.total_bytes, task.segment_count, task.supports_range);
                    is_multi_segment = task.supports_range && task.segments.len() > 1;

                    // Rebuild part paths
                    part_paths.clear();
                    initial_part_sizes.clear();
                    if is_multi_segment {
                        for seg in &task.segments {
                            part_paths.push(PathBuf::from(format!("{}.part{}", dest_path, seg.index)));
                            initial_part_sizes.push(0);
                        }
                    } else {
                        part_paths.push(PathBuf::from(format!("{}.mdmpart", dest_path)));
                        initial_part_sizes.push(0);
                    }
                }
            }
        }

        let downloaded_counter = Arc::new(AtomicU64::new(initial_downloaded));
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);

        {
            let mut active = self.active_tasks.write().await;
            if active.contains_key(&task_id) {
                return;
            }
            active.insert(
                task_id.clone(),
                ActiveTask {
                    cancel_tx,
                    done_rx,
                    downloaded_counter: Arc::clone(&downloaded_counter),
                },
            );
        }

        // Build initial segments state
        let mut current_segments = task.segments.clone();
        if is_multi_segment {
            for (idx, seg) in current_segments.iter_mut().enumerate() {
                let bytes = initial_part_sizes[idx];
                let expected = seg.end_byte.saturating_sub(seg.start_byte) + 1;
                seg.downloaded_bytes = bytes;
                seg.completed = bytes >= expected;
            }
        }

        let _ = self.db.update_task_progress(
            &task_id,
            initial_downloaded,
            &DownloadStatus::Downloading,
            None,
            None,
            Some(&current_segments),
        );

        if let Some(emitter) = &self.progress_emitter {
            emitter("download-status-changed", serde_json::json!(&task_id));
        }

        let client = self.client.clone();
        let db = Arc::clone(&self.db);
        let progress_emitter = self.progress_emitter.clone();
        let active_tasks = Arc::clone(&self.active_tasks);
        let id_clone = task_id.clone();
        let rate_limiter = self.get_speed_limiter();
        let global_rate_limiter = self.global_rate_limiter.clone();
        let max_concurrent = self.get_max_concurrent();

        tokio::spawn(async move {
            let url = task.url.clone();
            let total_bytes = task.total_bytes;
            let total_bytes_atomic = Arc::new(AtomicU64::new(total_bytes.unwrap_or(0)));
            let is_multi_flag = Arc::new(AtomicBool::new(is_multi_segment));

            // Setup per-segment live atomic counters
            let seg_counters: Vec<Arc<AtomicU64>> = initial_part_sizes
                .iter()
                .map(|&s| Arc::new(AtomicU64::new(s)))
                .collect();

            // Live progress & speed ticker
            let progress_task_id = id_clone.clone();
            let progress_counter = Arc::clone(&downloaded_counter);
            let progress_total = Arc::clone(&total_bytes_atomic);
            let progress_is_multi = Arc::clone(&is_multi_flag);
            let ticker_db = Arc::clone(&db);
            let progress_seg_counters = seg_counters.clone();
            let mut progress_segments_template = task.segments.clone();
            let ticker_cb = progress_emitter.clone();
            let mut ticker_cancel = cancel_rx.clone();

            let ticker_handle = tokio::spawn(async move {
                let start_instant = Instant::now();
                let initial_bytes = progress_counter.load(Ordering::Relaxed);

                // History buffer of (Instant, cumulative_bytes) for the rolling 3-second window
                let mut history: VecDeque<(Instant, u64)> = VecDeque::new();
                history.push_back((start_instant, initial_bytes));

                let mut ema_speed: Option<f64> = None;
                let mut smoothed_eta: Option<f64> = None;
                let mut last_reported_eta: Option<u64> = None;
                let mut last_saved_total = total_bytes.unwrap_or(0);
                let mut last_tick_time = start_instant;
                let mut interval = tokio::time::interval(Duration::from_millis(600));

                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            let now = Instant::now();
                            let tick_delta = now.duration_since(last_tick_time).as_secs_f64();
                            last_tick_time = now;

                            let dyn_total = progress_total.load(Ordering::Relaxed);
                            let effective_total = if dyn_total > 0 { Some(dyn_total) } else { total_bytes };
                            if dyn_total > 0 && dyn_total != last_saved_total {
                                last_saved_total = dyn_total;
                                let _ = ticker_db.update_task_total_bytes(&progress_task_id, dyn_total);
                            }

                            let current_raw = progress_counter.load(Ordering::Relaxed);
                            let current = if let Some(tot) = effective_total {
                                current_raw.min(tot)
                            } else {
                                current_raw
                            };

                            // Add current reading to rolling history
                            history.push_back((now, current));

                            // Prune history older than 3.0 seconds, keeping one baseline sample
                            while history.len() > 2 {
                                let second_oldest_time = history[1].0;
                                if now.duration_since(second_oldest_time).as_secs_f64() >= 3.0 {
                                    history.pop_front();
                                } else {
                                    break;
                                }
                            }

                            // Compute EMA-smoothed speed over the rolling 3.0s window
                            let oldest = history.front().unwrap();
                            let window_duration = now.duration_since(oldest.0).as_secs_f64();
                            let speed_f = if window_duration >= 0.2 {
                                let bytes_delta = current.saturating_sub(oldest.1);
                                let raw_speed = bytes_delta as f64 / window_duration;
                                let s = match ema_speed {
                                    None => raw_speed,
                                    Some(prev) => prev * 0.6 + raw_speed * 0.4,
                                };
                                ema_speed = Some(s);
                                s
                            } else {
                                0.0
                            };
                            let speed = speed_f.round().max(0.0) as u64;

                            // Compute responsive, jitter-free ETA
                            let elapsed_secs = now.duration_since(start_instant).as_secs_f64();
                            let eta = if let Some(tot) = effective_total {
                                if current >= tot {
                                    Some(0)
                                } else if speed > 512 {
                                    let remaining = tot.saturating_sub(current);
                                    let instant_eta = remaining as f64 / speed_f.max(1.0);

                                    let new_smoothed = match smoothed_eta {
                                        None => instant_eta,
                                        Some(prev_eta) => {
                                            let countdown_target = (prev_eta - tick_delta).max(0.0);
                                            let diverged = prev_eta > 0.0
                                                && (instant_eta / prev_eta > 2.0
                                                    || prev_eta / instant_eta.max(0.1) > 2.0);
                                            let alpha = if elapsed_secs < 3.0 || instant_eta < 10.0 || diverged {
                                                0.45
                                            } else {
                                                0.22
                                            };
                                            countdown_target * (1.0 - alpha) + instant_eta * alpha
                                        }
                                    };
                                    smoothed_eta = Some(new_smoothed);

                                    let rounded_eta = new_smoothed.round().max(1.0) as u64;
                                    let final_eta = match last_reported_eta {
                                        Some(last) if rounded_eta == last + 1 => last,
                                        _ => rounded_eta,
                                    };
                                    last_reported_eta = Some(final_eta);
                                    Some(final_eta)
                                } else {
                                    smoothed_eta = None;
                                    last_reported_eta = None;
                                    None
                                }
                            } else {
                                smoothed_eta = None;
                                last_reported_eta = None;
                                None
                            };

                            // Update segment array snapshot for live visualizer
                            let segments_payload = if progress_is_multi.load(Ordering::Relaxed) {
                                for (idx, seg) in progress_segments_template.iter_mut().enumerate() {
                                    if idx < progress_seg_counters.len() {
                                        let seg_bytes = progress_seg_counters[idx].load(Ordering::Relaxed);
                                        let seg_expected = seg.end_byte.saturating_sub(seg.start_byte) + 1;
                                        seg.downloaded_bytes = seg_bytes.min(seg_expected);
                                        seg.completed = seg.downloaded_bytes >= seg_expected;
                                    }
                                }
                                progress_segments_template.clone()
                            } else {
                                Vec::new()
                            };

                            if let Some(cb) = &ticker_cb {
                                cb("download-progress", serde_json::json!({
                                    "id": progress_task_id,
                                    "downloaded_bytes": current,
                                    "total_bytes": effective_total,
                                    "speed_bytes_per_sec": speed,
                                    "eta_seconds": eta,
                                    "segments": segments_payload,
                                }));
                            }
                        }
                        _ = ticker_cancel.changed() => {
                            break;
                        }
                    }
                }
            });

            // Run download: multi-segment or single-stream
            let cookies = task.cookies.clone();
            let referrer = task.referrer.clone();
            let user_agent = task.user_agent.clone();
            let mut fell_back_to_single = false;

            let download_result = if is_multi_segment {
                let (worker_cancel_tx, worker_cancel_rx) = watch::channel(*cancel_rx.borrow());
                let mut u_rx = cancel_rx.clone();
                let w_tx = worker_cancel_tx.clone();
                let fwd_handle = tokio::spawn(async move {
                    if u_rx.wait_for(|&v| v).await.is_ok() {
                        let _ = w_tx.send(true);
                    }
                });

                let mut seg_tasks = Vec::new();

                for (idx, seg) in task.segments.iter().enumerate() {
                    let part_file = part_paths[idx].clone();
                    let c = client.clone();
                    let u = url.clone();
                    let cnt = Arc::clone(&downloaded_counter);
                    let seg_cnt = Arc::clone(&seg_counters[idx]);
                    let rx = worker_cancel_rx.clone();
                    let s_start = seg.start_byte;
                    let s_end = seg.end_byte;
                    let seg_index = seg.index;
                    let s_down = initial_part_sizes[idx];
                    let r_lim = rate_limiter.clone();
                    let c_ck = cookies.clone();
                    let c_rf = referrer.clone();
                    let c_ua = user_agent.clone();

                    seg_tasks.push(tokio::spawn(async move {
                        let mut attempt = 0u32;
                        let max_retries = 5u32;
                        let seg_expected = s_end.saturating_sub(s_start) + 1;
                        let mut cur_down = s_down;

                        loop {
                            let res = DownloadWorker::download_segment(
                                &c,
                                &u,
                                part_file.clone(),
                                seg_index,
                                s_start,
                                s_end,
                                cur_down,
                                Arc::clone(&seg_cnt),
                                Arc::clone(&cnt),
                                r_lim.clone(),
                                rx.clone(),
                                c_ck.as_deref(),
                                c_rf.as_deref(),
                                c_ua.as_deref(),
                            )
                            .await;

                            match res {
                                Ok(()) => return Ok(()),
                                Err(e) => {
                                    let is_retryable = match &e {
                                        WorkerError::Network(_)
                                        | WorkerError::IncompleteSegment { .. }
                                        | WorkerError::Io(_) => true,
                                        WorkerError::HttpStatus(code) => {
                                            matches!(*code, 408 | 429 | 500 | 502 | 503 | 504)
                                        }
                                        _ => false,
                                    };

                                    if *rx.borrow() || !is_retryable || attempt >= max_retries {
                                        return Err(e);
                                    }

                                    attempt += 1;
                                    let backoff = Duration::from_millis(600 * attempt as u64);
                                    let mut sleep_rx = rx.clone();
                                    tokio::select! {
                                        biased;
                                        _ = async {
                                            while sleep_rx.changed().await.is_ok() {
                                                if *sleep_rx.borrow() {
                                                    break;
                                                }
                                            }
                                        } => return Err(WorkerError::Cancelled),
                                        _ = tokio::time::sleep(backoff) => {}
                                    }
                                    if *rx.borrow() {
                                        return Err(WorkerError::Cancelled);
                                    }

                                    // Reconcile disk part size and counters before resuming
                                    let disk_len = tokio::fs::metadata(&part_file)
                                        .await
                                        .map(|m| m.len().min(seg_expected))
                                        .unwrap_or(0);
                                    let prev_seg = seg_cnt.swap(disk_len, Ordering::SeqCst);
                                    if prev_seg > disk_len {
                                        cnt.fetch_sub(prev_seg - disk_len, Ordering::SeqCst);
                                    } else if disk_len > prev_seg {
                                        cnt.fetch_add(disk_len - prev_seg, Ordering::SeqCst);
                                    }
                                    cur_down = disk_len;
                                }
                            }
                        }
                    }));
                }

                let mut segment_error = None;
                let mut range_ignored = false;
                let mut task_iter = seg_tasks.into_iter();
                while let Some(handle) = task_iter.next() {
                    match handle.await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            if matches!(e, WorkerError::RangeIgnoredByServer(_)) {
                                range_ignored = true;
                            }
                            segment_error = Some(e.to_string());
                            let _ = worker_cancel_tx.send(true);
                            for remaining_handle in task_iter {
                                remaining_handle.abort();
                            }
                            break;
                        }
                        Err(e) => {
                            segment_error = Some(format!("Worker aborted: {}", e));
                            let _ = worker_cancel_tx.send(true);
                            for remaining_handle in task_iter {
                                remaining_handle.abort();
                            }
                            break;
                        }
                    }
                }
                fwd_handle.abort();

                if range_ignored && !*cancel_rx.borrow() {
                    // Server ignored Range header: clean up partial chunks and fall back cleanly to single stream
                    fell_back_to_single = true;
                    is_multi_flag.store(false, Ordering::Relaxed);
                    cleanup_task_temp_files(&dest_path);
                    downloaded_counter.store(0, Ordering::SeqCst);

                    DownloadWorker::download_single(
                        &client,
                        &url,
                        &dest_path,
                        false,
                        Arc::clone(&downloaded_counter),
                        Arc::clone(&total_bytes_atomic),
                        rate_limiter.clone(),
                        cancel_rx.clone(),
                        cookies.as_deref(),
                        referrer.as_deref(),
                        user_agent.as_deref(),
                    )
                    .await
                    .map_err(|e| e.to_string())
                } else if let Some(err) = segment_error {
                    Err(err)
                } else {
                    ticker_handle.abort();
                    let merge_emitter = progress_emitter.clone();
                    let merge_task_id = id_clone.clone();
                    let merge_total = total_bytes.unwrap_or_else(|| downloaded_counter.load(Ordering::Relaxed));
                    let merge_segments: Vec<crate::engine::task::SegmentProgress> = task
                        .segments
                        .iter()
                        .map(|s| {
                            let seg_len = s.end_byte.saturating_sub(s.start_byte) + 1;
                            let mut seg_done = s.clone();
                            seg_done.downloaded_bytes = seg_len;
                            seg_done.completed = true;
                            seg_done
                        })
                        .collect();
                    let merge_cb: Option<crate::engine::worker::MergeProgressCallback> =
                        merge_emitter.map(|emitter| {
                            Box::new(move |pct: f64| {
                                emitter(
                                    "download-progress",
                                    serde_json::json!({
                                        "id": merge_task_id,
                                        "downloaded_bytes": merge_total,
                                        "total_bytes": total_bytes,
                                        "speed_bytes_per_sec": 0,
                                        "eta_seconds": 0,
                                        "segments": merge_segments,
                                        "merging": true,
                                        "merge_progress": pct,
                                    }),
                                );
                            }) as crate::engine::worker::MergeProgressCallback
                        });

                    DownloadWorker::finalize_segments_with_progress(
                        &dest_path,
                        part_paths,
                        &task.segments,
                        total_bytes,
                        merge_cb,
                    )
                    .await
                    .map_err(|e| e.to_string())
                }
            } else {
                DownloadWorker::download_single(
                    &client,
                    &url,
                    &dest_path,
                    task.supports_range,
                    Arc::clone(&downloaded_counter),
                    Arc::clone(&total_bytes_atomic),
                    rate_limiter.clone(),
                    cancel_rx.clone(),
                    cookies.as_deref(),
                    referrer.as_deref(),
                    user_agent.as_deref(),
                )
                .await
                .map_err(|e| e.to_string())
            };

            ticker_handle.abort();

            // Calculate final segment status
            let final_segments = if fell_back_to_single {
                Vec::new()
            } else {
                let mut segs = task.segments.clone();
                for (idx, seg) in segs.iter_mut().enumerate() {
                    if idx < seg_counters.len() {
                        let b = seg_counters[idx].load(Ordering::Relaxed);
                        let exp = seg.end_byte.saturating_sub(seg.start_byte) + 1;
                        seg.downloaded_bytes = b.min(exp);
                        seg.completed = seg.downloaded_bytes >= exp;
                    }
                }
                segs
            };

            let dyn_final_total = total_bytes_atomic.load(Ordering::Relaxed);
            let final_total_opt = if dyn_final_total > 0 {
                Some(dyn_final_total)
            } else {
                total_bytes
            };

            let raw_final = downloaded_counter.load(Ordering::Relaxed);
            let final_downloaded = if let Some(tot) = final_total_opt {
                raw_final.min(tot)
            } else {
                raw_final
            };

            let (final_status, err_msg, completed_at) = match download_result {
                Ok(()) => (
                    DownloadStatus::Completed,
                    None,
                    Some(Utc::now()),
                ),
                Err(ref e) if e.contains("cancelled") || *cancel_rx.borrow() => {
                    (DownloadStatus::Paused, None, None)
                }
                Err(e) => (DownloadStatus::Failed, Some(e), None),
            };

            if final_status == DownloadStatus::Completed {
                if let Some(tot) = final_total_opt.or(Some(final_downloaded).filter(|&v| v > 0)) {
                    let _ = db.update_task_total_bytes(&id_clone, tot);
                }
            }

            let _ = db.update_task_progress(
                &id_clone,
                final_downloaded,
                &final_status,
                err_msg.as_deref(),
                completed_at,
                Some(&final_segments),
            );

            {
                let mut active = active_tasks.write().await;
                active.remove(&id_clone);
            }

            let _ = done_tx.send(true);

            if let Some(cb) = &progress_emitter {
                cb("download-status-changed", serde_json::json!(&id_clone));
            }

            // Automatically advance queue when a download slot is freed!
            Self::trigger_next_queued(
                Arc::clone(&db),
                Arc::clone(&active_tasks),
                max_concurrent,
                client.clone(),
                progress_emitter.clone(),
                global_rate_limiter.clone(),
            );
        });
    }

    pub async fn pause_task(&self, id: &str) -> Result<(), String> {
        let mut current_bytes = 0u64;
        let mut wait_rx = None;
        {
            let mut active = self.active_tasks.write().await;
            if let Some(task) = active.remove(id) {
                let _ = task.cancel_tx.send(true);
                current_bytes = task.downloaded_counter.load(Ordering::Relaxed);
                wait_rx = Some(task.done_rx);
            }
        }

        if let Some(mut rx) = wait_rx {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                rx.wait_for(|&done| done),
            )
            .await;
            if let Ok(tasks) = self.db.list_tasks() {
                if let Some(t) = tasks.into_iter().find(|t| t.id == id) {
                    if t.status == DownloadStatus::Completed {
                        return Ok(());
                    }
                    current_bytes = current_bytes.max(t.downloaded_bytes);
                }
            }
        } else if let Ok(tasks) = self.db.list_tasks() {
            if let Some(t) = tasks.into_iter().find(|t| t.id == id) {
                current_bytes = t.downloaded_bytes;
            }
        }

        self.db
            .update_task_progress(id, current_bytes, &DownloadStatus::Paused, None, None, None)
            .map_err(|e| e.to_string())?;

        if let Some(emitter) = &self.progress_emitter {
            emitter("download-status-changed", serde_json::json!(id));
        }

        // Freeing slot: process next queued item
        self.process_queue().await;
        Ok(())
    }

    pub async fn resume_task(&self, id: &str) -> Result<(), String> {
        self.start_download(id.to_string()).await;
        Ok(())
    }

    pub async fn cancel_task(&self, id: &str) -> Result<(), String> {
        let mut current_bytes = 0u64;
        let mut wait_rx = None;
        {
            let mut active = self.active_tasks.write().await;
            if let Some(task) = active.remove(id) {
                let _ = task.cancel_tx.send(true);
                current_bytes = task.downloaded_counter.load(Ordering::Relaxed);
                wait_rx = Some(task.done_rx);
            }
        }

        if let Some(mut rx) = wait_rx {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                rx.wait_for(|&done| done),
            )
            .await;
        }

        let mut dest_to_clean: Option<String> = None;
        if let Ok(tasks) = self.db.list_tasks() {
            if let Some(t) = tasks.into_iter().find(|t| t.id == id) {
                dest_to_clean = Some(t.destination_path.clone());
                if current_bytes == 0 {
                    current_bytes = t.downloaded_bytes;
                }
            }
        }

        if let Some(dest) = dest_to_clean {
            cleanup_task_temp_files(&dest);
        }

        self.db
            .update_task_progress(id, current_bytes, &DownloadStatus::Cancelled, None, None, None)
            .map_err(|e| e.to_string())?;

        if let Some(emitter) = &self.progress_emitter {
            emitter("download-status-changed", serde_json::json!(id));
        }

        // Freeing slot: process next queued item
        self.process_queue().await;
        Ok(())
    }

    pub async fn get_stats(&self) -> EngineStats {
        let active_count = self.active_tasks.read().await.len();
        let tasks = self.db.list_tasks().unwrap_or_default();

        let queued = tasks.iter().filter(|t| t.status == DownloadStatus::Queued).count();
        let completed = tasks.iter().filter(|t| t.status == DownloadStatus::Completed).count();

        EngineStats {
            total_download_speed: 0,
            active_downloads: active_count,
            queued_downloads: queued,
            completed_downloads: completed,
        }
    }
}

