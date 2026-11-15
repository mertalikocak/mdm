use crate::db::Database;
use crate::engine::probe::{get_collision_free_path, sanitize_filename};
use crate::engine::task::{DownloadStatus, DownloadTask};
use crate::video::binaries::{find_ffmpeg, install_ffmpeg, install_or_update_ytdlp};
use crate::video::downloader::{execute_video_download, VideoDownloadParams};
use chrono::Utc;
use reqwest::Client;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Mutex, RwLock};

pub type ProgressEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

struct VideoSmoothingState {
    history: VecDeque<(Instant, u64)>,
    ema_speed: Option<f64>,
    smoothed_eta: Option<f64>,
    last_reported_eta: Option<u64>,
    start_instant: Instant,
    last_tick_time: Instant,
    last_emit_time: Instant,
    known_total_bytes: u64,
}

#[derive(Clone)]
struct ActiveVideoTask {
    cancel_tx: watch::Sender<bool>,
    is_paused: Arc<AtomicBool>,
    done_rx: watch::Receiver<bool>,
}

fn get_video_downloaded_bytes(dest: &str) -> u64 {
    let dest_path = Path::new(dest);
    if let Ok(meta) = std::fs::metadata(dest_path) {
        if meta.len() > 0 {
            return meta.len();
        }
    }

    let direct_part = format!("{}.part", dest);
    if let Ok(meta) = std::fs::metadata(&direct_part) {
        if meta.len() > 0 {
            return meta.len();
        }
    }

    // Check for DASH stream files in destination folder (e.g. stem.f*.mp4, stem.f*.webm, .part, .temp)
    if let (Some(parent), Some(stem)) = (dest_path.parent(), dest_path.file_stem().and_then(|n| n.to_str())) {
        if let Ok(entries) = std::fs::read_dir(parent) {
            let mut total_part_bytes = 0u64;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(stem) && (name.ends_with(".part") || name.contains(".f") || name.contains(".temp")) {
                    if let Ok(m) = entry.metadata() {
                        total_part_bytes += m.len();
                    }
                }
            }
            if total_part_bytes > 0 {
                return total_part_bytes;
            }
        }
    }

    0
}

pub struct VideoManager {
    db: Arc<Database>,
    bin_dir: PathBuf,
    client: Client,
    progress_emitter: Option<ProgressEmitter>,
    active_tasks: Arc<RwLock<HashMap<String, ActiveVideoTask>>>,
    ffmpeg_install_lock: Arc<Mutex<()>>,
}

impl VideoManager {
    pub fn new(db: Arc<Database>, bin_dir: PathBuf) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            db,
            bin_dir,
            client,
            progress_emitter: None,
            active_tasks: Arc::new(RwLock::new(HashMap::new())),
            ffmpeg_install_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn set_progress_emitter(&mut self, emitter: ProgressEmitter) {
        self.progress_emitter = Some(emitter);
    }

    pub fn get_bin_dir(&self) -> &Path {
        &self.bin_dir
    }

    pub async fn install_ytdlp(&self) -> Result<String, String> {
        install_or_update_ytdlp(&self.bin_dir, &self.client).await
    }

    pub async fn is_task_active(&self, id: &str) -> bool {
        self.active_tasks.read().await.contains_key(id)
    }

    pub async fn add_video_task(
        &self,
        url: &str,
        title: &str,
        format_spec: &str,
        extension: &str,
        is_audio_only: bool,
        destination_dir: &str,
        total_bytes: Option<u64>,
        cookies: Option<String>,
        referrer: Option<String>,
        user_agent: Option<String>,
    ) -> Result<DownloadTask, String> {
        let clean_name = sanitize_filename(title);
        let filename_with_ext = format!("{}.{}", clean_name, extension);
        let final_dest = get_collision_free_path(destination_dir, &filename_with_ext);

        let task_id = uuid::Uuid::new_v4().to_string();

        let task = DownloadTask {
            id: task_id.clone(),
            url: url.to_string(),
            filename: filename_with_ext,
            destination_path: final_dest.clone(),
            total_bytes,
            downloaded_bytes: 0,
            speed_bytes_per_sec: 0,
            eta_seconds: None,
            status: DownloadStatus::Queued,
            error_message: None,
            supports_range: false,
            segment_count: 1,
            segments: Vec::new(),
            // Tag with video format indicator for easy identification & resumption
            etag: Some(format!("video:{}:{}", if is_audio_only { "audio" } else { "video" }, format_spec)),
            last_modified: None,
            created_at: Utc::now(),
            completed_at: None,
            cookies,
            referrer,
            user_agent,
        };

        self.db.insert_or_update_task(&task).map_err(|e| e.to_string())?;

        // Start downloading immediately
        self.start_video_download(task_id, format_spec.to_string(), is_audio_only)
            .await?;

        Ok(task)
    }

    pub async fn start_video_download(
        &self,
        id: String,
        format_spec: String,
        is_audio_only: bool,
    ) -> Result<(), String> {
        // If an existing task is currently active or stopping for this ID, cleanly await its exit first
        let prev_task = {
            let active = self.active_tasks.read().await;
            active.get(&id).cloned()
        };
        if let Some(prev) = prev_task {
            prev.is_paused.store(true, Ordering::SeqCst);
            let _ = prev.cancel_tx.send(true);
            let mut done_rx = prev.done_rx.clone();
            let _ = done_rx.wait_for(|&done| done).await;
        }

        let task = self
            .db
            .list_tasks()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| "Görev bulunamadı.".to_string())?;

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        let is_paused = Arc::new(AtomicBool::new(false));

        {
            let mut active = self.active_tasks.write().await;
            active.insert(
                id.clone(),
                ActiveVideoTask {
                    cancel_tx,
                    is_paused: Arc::clone(&is_paused),
                    done_rx,
                },
            );
        }

        let initial_bytes = if task.downloaded_bytes > 0 {
            task.downloaded_bytes
        } else {
            get_video_downloaded_bytes(&task.destination_path)
        };

        // Set status to Downloading in DB
        let _ = self.db.update_task_progress(
            &id,
            initial_bytes,
            &DownloadStatus::Downloading,
            None,
            None,
            None,
        );

        if let Some(emitter) = &self.progress_emitter {
            emitter("download-status-changed", serde_json::json!(&id));
        }

        let db = Arc::clone(&self.db);
        let bin_dir = self.bin_dir.clone();
        let active_tasks = Arc::clone(&self.active_tasks);
        let progress_emitter = self.progress_emitter.clone();
        let task_id = id.clone();
        let url = task.url.clone();
        let dest = task.destination_path.clone();
        let task_cookies = task.cookies.clone();
        let task_referrer = task.referrer.clone();
        let task_user_agent = task.user_agent.clone();
        let ffmpeg_lock = Arc::clone(&self.ffmpeg_install_lock);

        tokio::spawn(async move {
            // FFmpeg is required to merge YouTube's separate video/audio streams into one file
            let ffmpeg_result = {
                let _guard = ffmpeg_lock.lock().await;
                if find_ffmpeg(&bin_dir).is_some() {
                    Ok(())
                } else {
                    install_ffmpeg(&bin_dir).await.map(|_| ())
                }
            };

            let p_task_id = task_id.clone();
            let p_emitter = progress_emitter.clone();
            let db_ref = Arc::clone(&db);

            let last_downloaded_atomic = Arc::new(AtomicU64::new(0));
            let cb_last_bytes = Arc::clone(&last_downloaded_atomic);
            let initial_known_total = task.total_bytes.unwrap_or(0);

            let smoothing_state = Arc::new(std::sync::Mutex::new(VideoSmoothingState {
                history: VecDeque::new(),
                ema_speed: None,
                smoothed_eta: None,
                last_reported_eta: None,
                start_instant: Instant::now(),
                last_tick_time: Instant::now(),
                last_emit_time: Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now),
                known_total_bytes: initial_known_total,
            }));

            let progress_cb = Arc::new(move |downloaded: u64, stream_total: Option<u64>, is_final_stream: bool, raw_speed: u64, raw_eta: Option<u64>| {
                cb_last_bytes.store(downloaded, Ordering::Relaxed);
                let now = Instant::now();
                let mut state = match smoothing_state.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };

                // Allow overstated pre-analysis sizes to snap down to real yt-dlp totals,
                // while preserving expected video+audio total during stream #1 when close
                let mut candidate_total = match (state.known_total_bytes, stream_total) {
                    (_, Some(st)) if st > 0 && is_final_stream => st,
                    (kt, Some(st)) if st > 0 => {
                        if kt >= st && kt <= st.saturating_mul(5) / 4 {
                            kt
                        } else {
                            st
                        }
                    }
                    (kt, _) => kt,
                };

                // Keep a known positive total ahead of active downloaded bytes (common on VBR HLS estimates)
                if candidate_total > 0 && downloaded >= candidate_total {
                    if let Some(re) = raw_eta.filter(|&e| e > 0) {
                        if raw_speed > 0 {
                            candidate_total = downloaded.saturating_add(raw_speed.saturating_mul(re));
                        } else {
                            candidate_total = downloaded.saturating_add((downloaded / 10).max(65536));
                        }
                    } else {
                        candidate_total = downloaded.saturating_add((downloaded / 20).max(65536));
                    }
                }

                if candidate_total > 0 && candidate_total != state.known_total_bytes {
                    state.known_total_bytes = candidate_total;
                    let _ = db_ref.update_task_total_bytes(&p_task_id, candidate_total);
                }

                let effective_total = (state.known_total_bytes > 0)
                    .then_some(state.known_total_bytes)
                    .or_else(|| stream_total.filter(|&t| t > downloaded));

                let ms_since_emit = now.duration_since(state.last_emit_time).as_millis();
                // Throttle event emissions to avoid flooding the IPC bus
                if ms_since_emit < 400 {
                    return;
                }

                let tick_delta = now.duration_since(state.last_tick_time).as_secs_f64();
                state.last_tick_time = now;
                state.last_emit_time = now;

                state.history.push_back((now, downloaded));

                // Prune history older than 3.0 seconds, keeping one baseline sample
                while state.history.len() > 2 {
                    let second_oldest_time = state.history[1].0;
                    if now.duration_since(second_oldest_time).as_secs_f64() >= 3.0 {
                        state.history.pop_front();
                    } else {
                        break;
                    }
                }

                // Compute EMA-smoothed speed over the rolling 3.0s window
                let oldest = state.history.front().unwrap();
                let window_duration = now.duration_since(oldest.0).as_secs_f64();
                let raw_calc_speed = if window_duration >= 0.2 {
                    let bytes_delta = downloaded.saturating_sub(oldest.1);
                    let calc = bytes_delta as f64 / window_duration;
                    if calc < 1.0 && raw_speed > 0 && window_duration < 1.0 {
                        raw_speed as f64
                    } else {
                        calc
                    }
                } else {
                    raw_speed as f64
                };

                let speed_f = if raw_calc_speed > 0.0 || state.ema_speed.is_some() {
                    let s = match state.ema_speed {
                        None => raw_calc_speed,
                        Some(prev) => prev * 0.6 + raw_calc_speed * 0.4,
                    };
                    state.ema_speed = Some(s);
                    s
                } else {
                    0.0
                };
                let speed = speed_f.round().max(0.0) as u64;

                // Compute responsive, dampened ETA (never emit 0s mid-download)
                let elapsed_secs = now.duration_since(state.start_instant).as_secs_f64();
                let eta = if speed > 512 && effective_total.filter(|&t| t > downloaded).is_some() {
                    let remaining = effective_total.unwrap().saturating_sub(downloaded);
                    let instant_eta = remaining as f64 / speed_f.max(1.0);

                    let new_smoothed = match state.smoothed_eta {
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
                    state.smoothed_eta = Some(new_smoothed);

                    let rounded_eta = new_smoothed.round().max(1.0) as u64;
                    let final_eta = match state.last_reported_eta {
                        None => rounded_eta,
                        Some(last) => {
                            if rounded_eta == last + 1 {
                                last
                            } else {
                                rounded_eta
                            }
                        }
                    };
                    state.last_reported_eta = Some(final_eta);
                    Some(final_eta)
                } else if let Some(re) = raw_eta.filter(|&e| e > 0) {
                    state.smoothed_eta = Some(re as f64);
                    state.last_reported_eta = Some(re);
                    Some(re)
                } else {
                    state.smoothed_eta = None;
                    state.last_reported_eta = None;
                    None
                };

                if let Some(ref em) = p_emitter {
                    em(
                        "download-progress",
                        serde_json::json!({
                            "id": p_task_id,
                            "downloaded_bytes": downloaded,
                            "total_bytes": effective_total,
                            "speed_bytes_per_sec": speed,
                            "eta_seconds": eta,
                            "segments": [],
                        }),
                    );
                }
                let _ = db_ref.update_task_progress(
                    &p_task_id,
                    downloaded,
                    &DownloadStatus::Downloading,
                    None,
                    None,
                    None,
                );
            });

            let params = VideoDownloadParams {
                bin_dir: &bin_dir,
                url: &url,
                format_spec: &format_spec,
                is_audio_only,
                destination_path: &dest,
                cookies: task_cookies.as_deref(),
                referrer: task_referrer.as_deref(),
                user_agent: task_user_agent.as_deref(),
            };

            let result = match ffmpeg_result {
                Err(e) => Err(format!("FFmpeg kurulamadı (ses/görüntü birleştirme için gerekli): {}", e)),
                Ok(()) => {
                    execute_video_download(
                        params,
                        Some(progress_cb),
                        cancel_rx,
                        is_paused,
                    )
                    .await
                }
            };

            // Remove from active tasks map
            {
                let mut active = active_tasks.write().await;
                active.remove(&task_id);
            }
            // Notify any waiting pause/resume call that this execution has completely finished
            let _ = done_tx.send(true);

            let (final_status, err_msg, completed_at) = match result {
                Ok(()) => (DownloadStatus::Completed, None, Some(Utc::now())),
                Err(ref e) if e == "cancelled:paused" => (DownloadStatus::Paused, None, None),
                Err(ref e) if e == "cancelled" => (DownloadStatus::Cancelled, None, None),
                Err(e) => (DownloadStatus::Failed, Some(e), None),
            };

            let db_bytes = db.list_tasks().ok().and_then(|ts| ts.into_iter().find(|t| t.id == task_id)).map(|t| t.downloaded_bytes).unwrap_or(0);
            let disk_bytes = get_video_downloaded_bytes(&dest);
            let reported_bytes = last_downloaded_atomic.load(Ordering::Relaxed);
            let max_accumulated = disk_bytes.max(reported_bytes).max(db_bytes);
            let final_bytes = if final_status == DownloadStatus::Completed {
                std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(max_accumulated)
            } else {
                max_accumulated
            };

            if final_status == DownloadStatus::Completed && final_bytes > 0 {
                let _ = db.update_task_total_bytes(&task_id, final_bytes);
            }

            let _ = db.update_task_progress(
                &task_id,
                final_bytes,
                &final_status,
                err_msg.as_deref(),
                completed_at,
                None,
            );

            if let Some(emitter) = &progress_emitter {
                emitter("download-status-changed", serde_json::json!(&task_id));
            }
        });

        Ok(())
    }

    pub async fn pause_video_task(&self, id: &str) -> Result<(), String> {
        let existing = {
            let active = self.active_tasks.read().await;
            active.get(id).cloned()
        };

        if let Some(task) = existing {
            task.is_paused.store(true, Ordering::SeqCst);
            let _ = task.cancel_tx.send(true);
            let mut done_rx = task.done_rx.clone();
            // Await child process termination so all file locks are released cleanly
            let _ = done_rx.wait_for(|&done| done).await;
        }

        if let Ok(tasks) = self.db.list_tasks() {
            if let Some(t) = tasks.into_iter().find(|x| x.id == id) {
                let part_size = get_video_downloaded_bytes(&t.destination_path);
                let valid_size = part_size.max(t.downloaded_bytes);
                let _ = self.db.update_task_progress(
                    id,
                    valid_size,
                    &DownloadStatus::Paused,
                    None,
                    None,
                    None,
                );
            }
        }

        if let Some(emitter) = &self.progress_emitter {
            emitter("download-status-changed", serde_json::json!(id));
        }

        Ok(())
    }

    pub async fn cancel_video_task(&self, id: &str) -> Result<(), String> {
        let existing = {
            let active = self.active_tasks.read().await;
            active.get(id).cloned()
        };

        if let Some(task) = existing {
            task.is_paused.store(false, Ordering::SeqCst);
            let _ = task.cancel_tx.send(true);
            let mut done_rx = task.done_rx.clone();
            let _ = done_rx.wait_for(|&done| done).await;
        }

        let mut dest_to_clean = None;
        if let Ok(tasks) = self.db.list_tasks() {
            if let Some(t) = tasks.into_iter().find(|x| x.id == id) {
                dest_to_clean = Some(t.destination_path.clone());
                let _ = self.db.update_task_progress(
                    id,
                    t.downloaded_bytes,
                    &DownloadStatus::Cancelled,
                    None,
                    None,
                    None,
                );
            }
        }

        // Clean any leftover .part and DASH stream files
        if let Some(dest) = dest_to_clean {
            let dest_path = Path::new(&dest);
            let direct_part = format!("{}.part", dest);
            let _ = std::fs::remove_file(direct_part);

            if let (Some(parent), Some(file_name)) = (dest_path.parent(), dest_path.file_name().and_then(|n| n.to_str())) {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with(file_name) && (name.ends_with(".part") || name.contains(".f")) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }

        if let Some(emitter) = &self.progress_emitter {
            emitter("download-status-changed", serde_json::json!(id));
        }

        Ok(())
    }
}
