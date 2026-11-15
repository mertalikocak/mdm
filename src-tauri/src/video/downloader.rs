use crate::video::binaries::{create_hidden_command, find_ffmpeg, find_yt_dlp};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;

pub struct VideoDownloadParams<'a> {
    pub bin_dir: &'a Path,
    pub url: &'a str,
    pub format_spec: &'a str,
    pub is_audio_only: bool,
    pub destination_path: &'a str,
    pub cookies: Option<&'a str>,
    pub referrer: Option<&'a str>,
    pub user_agent: Option<&'a str>,
}

pub type VideoProgressCallback = Arc<dyn Fn(u64, Option<u64>, bool, u64, Option<u64>) + Send + Sync>;

async fn kill_child_process_tree(child: &mut tokio::process::Child) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.id() {
        let mut kill_cmd = tokio::process::Command::new("taskkill");
        kill_cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        kill_cmd.creation_flags(0x08000000);
        let _ = kill_cmd.output().await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub async fn execute_video_download(
    params: VideoDownloadParams<'_>,
    progress_cb: Option<VideoProgressCallback>,
    mut cancel_rx: watch::Receiver<bool>,
    is_paused: Arc<AtomicBool>,
) -> Result<(), String> {
    let ytdlp_path = find_yt_dlp(params.bin_dir).ok_or_else(|| {
        "yt-dlp bulunamadı. Lütfen Ayarlar > Araçlar bölümünden yükleyin.".to_string()
    })?;

    let ffmpeg_path = find_ffmpeg(params.bin_dir);

    let mut cmd = create_hidden_command(&ytdlp_path);

    // If ffmpeg is available, tell yt-dlp where it is located
    if let Some(ref ff) = ffmpeg_path {
        if let Some(parent) = ff.parent() {
            cmd.arg("--ffmpeg-location").arg(parent);
        }
    }

    // Format selection
    cmd.arg("-f").arg(params.format_spec);

    if params.is_audio_only && ffmpeg_path.is_some() {
        cmd.arg("-x").arg("--audio-format").arg("m4a");
    }

    // Merge separate video+audio streams into a single mp4 at the exact destination path
    if !params.is_audio_only && ffmpeg_path.is_some() {
        cmd.arg("--merge-output-format").arg("mp4");
    }

    // Ensure progress output is easily parsable line-by-line across DASH and HLS fragment streams
    cmd.arg("--newline");
    cmd.arg("--progress-template")
        .arg("download:[mdm_progress] %(progress.status|downloading)s %(progress.downloaded_bytes|0)s %(progress.total_bytes|0)s %(progress.total_bytes_estimate|0)s %(progress.speed|0)s %(progress.eta|0)s %(info.format_id|unknown)s %(progress.fragment_index|0)s %(progress.fragment_count|0)s");

    cmd.arg("--continue");
    cmd.arg("--no-playlist");
    cmd.arg("--no-warnings");
    cmd.args(["--concurrent-fragments", "4"]);

    if let Some(r) = params.referrer.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--referer", r]);
    }
    if let Some(ua) = params.user_agent.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--user-agent", ua]);
    }
    if let Some(c) = params.cookies.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--add-header", &format!("Cookie:{}", c)]);
    }

    // Destination output path
    cmd.arg("-o").arg(params.destination_path);

    // Video URL
    cmd.arg(params.url);

    // Force UTF-8 encoding for Python/yt-dlp output on Windows
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.arg("--encoding").arg("utf-8");

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("yt-dlp işlemi başlatılamadı: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "yt-dlp standart çıktısına bağlanılamadı.".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "yt-dlp hata çıktısına bağlanılamadı.".to_string())?;

    // Spawn async stderr reader to capture possible errors (lossy UTF-8 safe)
    let stderr_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut err_bytes = Vec::new();
        let mut buf = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buf).await {
            if n == 0 {
                break;
            }
            err_bytes.extend_from_slice(&buf);
            buf.clear();
        }
        String::from_utf8_lossy(&err_bytes).to_string()
    });

    // Read stdout line-by-line for live progress (lossy UTF-8 safe, tracks cumulative DASH/HLS streams)
    let mut reader = BufReader::new(stdout);
    let mut byte_buf = Vec::new();
    let mut completed_streams_bytes = 0u64;
    let mut completed_streams_total = 0u64;
    let mut cur_stream_downloaded = 0u64;
    let mut cur_stream_total: Option<u64> = None;
    let mut cur_format_id = String::new();
    let mut prev_stream_finished = false;
    let mut stdout_errors: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            line_res = reader.read_until(b'\n', &mut byte_buf) => {
                match line_res {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&byte_buf);
                        if let Some(idx) = line.find("[mdm_progress]") {
                            let payload = &line[idx + 14..];
                            let parts: Vec<&str> = payload.split_whitespace().collect();
                            if parts.len() >= 6 {
                                let status_str = parts[0];
                                let d_opt = parts[1].parse::<f64>().ok().filter(|v| *v >= 0.0).map(|v| v as u64);
                                let exact_t_opt = parts[2].parse::<f64>().ok().filter(|v| *v > 0.0).map(|v| v as u64);
                                let est_t_opt = parts[3].parse::<f64>().ok().filter(|v| *v > 0.0).map(|v| v as u64);
                                let speed: u64 = parts[4].parse::<f64>().ok().filter(|v| *v >= 0.0).map(|v| v as u64).unwrap_or(0);
                                let eta: Option<u64> = parts[5].parse::<f64>().ok().filter(|v| *v >= 0.0).map(|v| v as u64);
                                let fmt_id = parts.get(6).copied().unwrap_or("unknown");
                                let frag_idx = parts.get(7).and_then(|s| s.parse::<f64>().ok()).filter(|v| *v > 0.0).map(|v| v as u64);
                                let frag_count = parts.get(8).and_then(|s| s.parse::<f64>().ok()).filter(|v| *v > 0.0).map(|v| v as u64);

                                // Detect genuine stream boundary without false resets from --concurrent-fragments 4
                                let format_switched = !cur_format_id.is_empty()
                                    && fmt_id != "unknown"
                                    && cur_format_id != "unknown"
                                    && fmt_id != cur_format_id;
                                let new_stream_after_finish = prev_stream_finished
                                    && status_str == "downloading"
                                    && d_opt.map(|d| d < cur_stream_downloaded).unwrap_or(false);
                                let major_reset = d_opt
                                    .map(|d| cur_stream_downloaded > 1024 * 1024 && d < cur_stream_downloaded / 4 && frag_idx.unwrap_or(0) <= 2)
                                    .unwrap_or(false);

                                if format_switched || new_stream_after_finish || major_reset {
                                    let finished_size = cur_stream_total
                                        .unwrap_or(cur_stream_downloaded)
                                        .max(cur_stream_downloaded);
                                    completed_streams_bytes += finished_size;
                                    completed_streams_total += cur_stream_total.unwrap_or(finished_size);
                                    cur_stream_downloaded = 0;
                                    cur_stream_total = None;
                                    prev_stream_finished = false;
                                }

                                if fmt_id != "unknown" {
                                    cur_format_id = fmt_id.to_string();
                                }
                                if let Some(d) = d_opt {
                                    cur_stream_downloaded = cur_stream_downloaded.max(d);
                                }

                                if let Some(et) = exact_t_opt {
                                    cur_stream_total = Some(cur_stream_total.map_or(et, |prev| prev.max(et)));
                                } else {
                                    let frag_est = match (frag_idx, frag_count) {
                                        (Some(fi), Some(fc)) if fc > 0 && fi <= fc && cur_stream_downloaded > 0 => {
                                            Some(((cur_stream_downloaded as f64) * (fc as f64) / (fi as f64)).round() as u64)
                                        }
                                        _ => None,
                                    };
                                    if let Some(mut est) = est_t_opt.or(frag_est) {
                                        if status_str != "finished"
                                            && frag_idx.zip(frag_count).map(|(fi, fc)| fi < fc).unwrap_or(true)
                                            && est <= cur_stream_downloaded
                                        {
                                            est = frag_est
                                                .filter(|&fe| fe > cur_stream_downloaded)
                                                .unwrap_or_else(|| cur_stream_downloaded + (cur_stream_downloaded / 10).max(65536))
                                                .max(cur_stream_downloaded + 1);
                                        }
                                        cur_stream_total = Some(est);
                                    }
                                }

                                if status_str == "finished" {
                                    prev_stream_finished = true;
                                    if let Some(t) = cur_stream_total {
                                        cur_stream_downloaded = cur_stream_downloaded.max(t);
                                    }
                                }

                                let total_downloaded = completed_streams_bytes + cur_stream_downloaded;
                                let combined_total = cur_stream_total.map(|ct| completed_streams_total + ct);

                                if let Some(ref cb) = progress_cb {
                                    cb(total_downloaded, combined_total, completed_streams_bytes > 0, speed, eta);
                                }
                            }
                        } else if line.contains("ERROR:") || line.contains("Permission denied") || line.contains("WinError") {
                            stdout_errors.push(line.trim().to_string());
                        }
                        byte_buf.clear();
                    }
                    Err(e) => {
                        kill_child_process_tree(&mut child).await;
                        return Err(format!("Çıktı okuma hatası: {}", e));
                    }
                }
            }
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    kill_child_process_tree(&mut child).await;
                    if is_paused.load(Ordering::SeqCst) {
                        return Err("cancelled:paused".to_string());
                    } else {
                        return Err("cancelled".to_string());
                    }
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("yt-dlp süreci beklenirken hata oluştu: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        if *cancel_rx.borrow() {
            if is_paused.load(Ordering::SeqCst) {
                return Err("cancelled:paused".to_string());
            } else {
                return Err("cancelled".to_string());
            }
        }
        let err_output = stderr_handle.await.unwrap_or_default();
        let mut combined_err = err_output.trim().to_string();
        if !stdout_errors.is_empty() {
            if !combined_err.is_empty() {
                combined_err.push('\n');
            }
            combined_err.push_str(&stdout_errors.join("\n"));
        }
        if combined_err.is_empty() {
            Err(format!("yt-dlp başarısız oldu (çıkış kodu: {:?})", status.code()))
        } else {
            Err(format!("yt-dlp hatası: {}", combined_err))
        }
    }
}
