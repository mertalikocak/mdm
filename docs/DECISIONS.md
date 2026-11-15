# DECISIONS.md

### 2026-11-15 — Single-Instance IPC Delegation Before WebView2 Startup
- **Date:** 2026-11-15
- **Decision:** Check `127.0.0.1:47990` with a short TCP connect timeout (`400ms`) inside `src-tauri/src/main.rs` before calling `mdm_lib::run()`, send `{"type":"open_mdm_app"}`, and exit cleanly if an instance is already active.
- **Reasoning:** Launching a second WebView2 instance against the same user data directory causes `HRESULT(0x800700AA) "İstenen kaynak kullanımda"` crashes (recorded in `crash.log`). Checking the existing local IPC port delegates focus cleanly without adding extra Tauri single-instance plugin dependencies.
- **Alternatives considered:** Adding `tauri-plugin-single-instance` crate. Rejected to keep dependencies minimal and leverage the already-present IPC listener.
- **Consequences and trade-offs:** Requires the running instance's IPC TCP listener (`127.0.0.1:47990`) to be healthy; CLI flags (`--register-host`, `--unregister-host`) must continue executing before this check.

### 2026-11-15 — Native Win32 FFI Folder Picker Instead of Shell/PowerShell
- **Date:** 2026-11-15
- **Decision:** Implement `pick_folder` in `src-tauri/src/commands.rs` using Windows `shell32`/`ole32` FFI (`SHBrowseForFolderW` + `SHGetPathFromIDListW`) inside `tokio::task::spawn_blocking` instead of `window.prompt` or spawning PowerShell.
- **Reasoning:** Complies with both `GEMINI.md` (never use PowerShell) and `AGENTS.md` (no arbitrary shell command execution; explicit sanitized Windows APIs), while giving users a real native folder browser dialog.
- **Alternatives considered:** Adding `tauri-plugin-dialog` Cargo/NPM dependencies. FFI avoids extra plugin capability/JS dependency churn for a single directory picker.
- **Consequences and trade-offs:** Windows-specific `#[cfg(windows)]` implementation with explicit COM initialization/cleanup on the blocking worker thread.

### 2026-11-15 — Decouple Extension Confirmation UI From Blocking IPC Analysis
- **Date:** 2026-11-15
- **Decision:** Have `ProbeVideo` and offline Native Messaging launches open the compact dialog immediately (`dialog_opened` / `open-download-confirm`) and run `yt-dlp` metadata analysis asynchronously inside `AddDownloadModal.tsx`, while tracking DASH video+audio stream bytes cumulatively.
- **Reasoning:** Blocking IPC on `yt-dlp --dump-json` caused slow/double invocations and missing download dialogs; cumulative DASH byte accounting prevents progress/size resets when `yt-dlp` switches from video stream to audio stream.
- **Alternatives considered:** Pre-analyzing inside `ipc.rs` before emitting the UI event. Rejected because it stalls the native messaging host response and duplicates work triggered by React modal mount.
- **Consequences and trade-offs:** Compact dialog shows an explicit Turkish analysis spinner immediately while quality options load.

### 2026-11-15 — Live Atomic Speed Limiter & Cumulative DASH Progress Accounting
- **Date:** 2026-11-15
- **Decision:** Replace static `RateLimiter` configuration with `Arc<AtomicU64>` updated via `set_speed_limit` IPC, compute video + audio DASH stream bytes cumulatively across `yt-dlp` download phases, and derive speed/ETA from a rolling 3.0s byte window with EMA smoothing.
- **Reasoning:** Static rate limits ignored live user adjustments in Settings/Progress Speed Limiter tabs, while per-stream `yt-dlp` progress resets and cumulative elapsed division distorted file size, progress %, speed, and ETA.
- **Alternatives considered:** Re-spawning active HTTP transfers on limit changes or reading disk file sizes via polling. Rejected due to TCP teardown overhead and noisy multi-stream temp file naming in `yt-dlp`.
- **Consequences and trade-offs:** Requires monotonic guards in DB progress writes and cumulative offset tracking across `yt-dlp` format ID transitions.

### 2026-11-15 — Interruptible Worker I/O & Synchronized Pause/Cancel Lifecycle
- **Date:** 2026-11-15
- **Decision:** Wrap worker HTTP request sends and `bytes_stream()` reads in `tokio::select!` with a channel-close-safe `wait_for_cancel` helper, flush `BufWriter` / truncate partial files on exit, and await worker completion (`done_rx`) inside `pause_task` and `cancel_task` (while guarding against duplicate `start_download` entries in `active_tasks`).
- **Reasoning:** Unawaited background workers kept Windows file handles open during immediate `resume_task` or `cleanup_task_temp_files` calls and overwrote completed/paused SQLite statuses; blocking `stream.next().await` delayed pauses on stalled servers.
- **Alternatives considered:** Fire-and-forget cancellation flags without waiting. Rejected due to Windows file-sharing violations and test/UI status races.
- **Consequences and trade-offs:** `pause_task` / `cancel_task` take up to a bounded 2s timeout waiting for clean shutdown, returning `<1ms` when the server or stream is active/stalled.
