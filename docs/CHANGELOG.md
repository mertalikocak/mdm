# CHANGELOG.md

### [2026-11-15] - Project Memory Initialization

**Summary:** Created initial project memory documentation (`PROJECT_CONTEXT.md`, `CHANGELOG.md`, `DECISIONS.md`) following code review audit and before starting bugfix and UI overhaul work.
**Modified files:** `docs/PROJECT_CONTEXT.md`, `docs/CHANGELOG.md`, `docs/DECISIONS.md`
**Technical details:** Documented verified architecture, runtime bugs from `crash.log` / `host.log`, native messaging setup, and baseline build commands.
**Database changes:** None.
**Tests:** Baseline `cmd /c "cd src-tauri && cargo check --bins"` passed (exit code 0, prior to edit phase).
**Known issues:** Window permission errors, multi-instance WebView2 crash, stale AppData binary conflict, DASH progress reset, and browser interception bugs queued for resolution.

### [2026-11-15] - Backend Stability, Browser Interception, Progress Metrics & Classic IDM UI Overhaul

**Summary:** Resolved desktop crash/stability bugs, fixed YouTube/HTTP browser download interception and confirmation dialogs, unified HTTP & DASH progress/speed/ETA metrics, redesigned the UI into a classic flat Turkish IDM-style interface, and deployed fresh release binaries.
**Modified files:** `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/db/repository.rs`, `src-tauri/src/engine/{worker,probe,manager}.rs`, `src-tauri/src/video/{analyzer,downloader,manager}.rs`, `src-tauri/src/native_messaging/{ipc,mod}.rs`, `src-tauri/tests/integration_tests.rs`, `browser-extension/{background,popup}.js`, `src/App.tsx`, `src/components/{AddDownloadModal,DownloadProgressModal,DownloadTable,Navbar,SettingsModal,Sidebar,SegmentVisualizer,StatusBadge}.tsx`.
**Technical details:**
- Added explicit `core:window:allow-*`, `core:event:default`, and `core:webview:default` permissions in `capabilities/default.json`.
- Prevented WebView2 multi-instance `0x800700AA` crashes via pre-startup TCP `127.0.0.1:47990` delegation in `main.rs`, and eliminated invalid HWND `0x80070578` close errors by removing post-`hide()` resize/center calls in `lib.rs` and `commands.rs`.
- Made `Database::conn()` resilient to poisoned mutexes, added `update_task_total_bytes`, fixed `update_task_progress` direct byte updates, and expanded `ON CONFLICT(id)` upserts.
- Converted `RateLimiter` to `Arc<AtomicU64>` wired to `set_speed_limit`, added `HEAD` -> `GET Range: bytes=0-0` probe fallback, automated temp file cleanup, `RangeIgnoredByServer` single-stream fallback, `tokio::select!` worker cancellation, and `done_rx` synchronization in `pause_task`/`cancel_task`.
- Combined DASH video+audio stream bytes and `filesize_approx` sums in `video/` with rolling 3.0s EMA speed and ETA smoothing.
- Enabled automatic download interception by default in `browser-extension/background.js`, forwarded cookies + `finalUrl`, stopped premature cancel/erase, and opened compact dialog non-blockingly (`dialog_opened`).
- Added native Win32 FFI `pick_folder` (`SHBrowseForFolderW`) and redesigned React UI + compact modals to clean classic desktop styling.
**Database changes:** No schema DDL changes; updated SQLite upsert/progress/total-byte queries in `src-tauri/src/db/repository.rs`.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code 0 (TypeScript check passed, Vite built 1607 modules in 5.28s, `prepare-resources.cjs` ran cleanly after release build as well).
- `cmd /c 'cd src-tauri && cargo test && cargo build --release --bins'` -> exit code 0 (`integration_tests.rs`: 30 passed, 0 failed in 4.10s; `release` binaries built in 2m 15s).
- `cmd /c '"%LOCALAPPDATA%\mdm\mdm.exe" --register-host'` -> exit code 0 (`com.mak.mdm.json` pointing to updated `%LOCALAPPDATA%\mdm\mdm_host.exe`).
**Known issues:** Already-loaded unpacked Chrome/Brave extensions need manual reload in `chrome://extensions` to pick up updated `browser-extension/` scripts; live YouTube runtime depends on `yt-dlp.exe`/`ffmpeg.exe` in `%LOCALAPPDATA%\mdm\bin`.

### [2026-11-15] - Embedded Assets (`custom-protocol`) Fix for Release Binaries

**Summary:** Fixed standalone release `mdm.exe` attempting to connect to `http://localhost:1420` (`ERR_CONNECTION_REFUSED`) by enabling `custom-protocol = ["tauri/custom-protocol"]` as a default Cargo feature.
**Modified files:** `src-tauri/Cargo.toml`
**Technical details:** Standalone `cargo build --release` omitted the `custom-protocol` feature injected by Tauri CLI during `tauri build`, causing Tauri 2 to load `build.devUrl` instead of embedded `../dist` assets. Added `[features] default = ["custom-protocol"]` and `custom-protocol = ["tauri/custom-protocol"]`.
**Database changes:** None.
**Tests:**
- `cmd /c 'cd src-tauri && cargo build --release --bins --features custom-protocol'` -> exit code 0 (`1m 58s`), synced to `%LOCALAPPDATA%\mdm`, `%LOCALAPPDATA%\Mak Download Manager`, and `src-tauri/resources/`.
- Verified launched `mdm.exe` binds `127.0.0.1:47990` with `exit code 0` and no `crash.log` entries.
**Known issues:** None.

### [2026-11-15] - YouTube Size Estimate Alignment & Player Unpause Fix

**Summary:** Fixed overestimated YouTube quality sizes (`~982 MB` vs actual `~377 MB` completion), allowed runtime DASH totals to shrink overstated initial denominators, and stopped clicking the MDM extension grabber from playing paused YouTube videos.
**Modified files:** `src-tauri/src/video/{analyzer,downloader,manager}.rs`, `browser-extension/content.js`.
**Technical details:**
- `src-tauri/src/video/analyzer.rs`: Replaced `prev.max(sz)` stream sizing with `extract_exact_size` (ignoring `m3u8` manifest protocols) + `extract_est_size` fallback and `record_stream_size`, selecting the last matching stream in `yt-dlp`'s preference-sorted `formats` array for audio, DASH video, and single-stream formats.
- `src-tauri/src/video/downloader.rs` & `src-tauri/src/video/manager.rs`: Extended `VideoProgressCallback` with `is_final_stream` (`completed_streams_bytes > 0`) and updated `candidate_total` so overestimated initial `known_total_bytes` (`> st * 5/4` on stream #1, or any variance on the final stream) snaps to real `yt-dlp` stream byte totals instead of staying monotonic high.
- `browser-extension/content.js`: Blocked propagation of `mousedown`, `mouseup`, `pointerdown`, `pointerup`, and `dblclick` on the grabber panel and removed the `video.play()` + `250ms` timeout block in its click handler.
**Database changes:** None (existing `update_task_total_bytes` syncs corrected runtime `candidate_total`).
**Tests:**
- `cmd /c 'cd src-tauri && cargo test && cargo build --release --bins --features custom-protocol'` -> exit code `0` (`integration_tests.rs`: `30 passed, 0 failed` in `4.11s`; release build in `2m 39s`).
- `node prepare-resources.cjs` and sync to `%LOCALAPPDATA%\mdm`, `%LOCALAPPDATA%\Mak Download Manager`, and `src-tauri/resources/` (`14 File(s) copied` for `browser-extension/`) -> exit code `0`.
**Known issues:** Existing browser sessions require clicking Reload on the unpacked extension in `chrome://extensions` and refreshing open YouTube tabs so the updated `content.js` takes effect.

### [2026-11-15] - Per-Chunk Idle Timeout, Segment Auto-Retry & Default 8 Connections

**Summary:** Eliminated the 30-second total HTTP request timeout causing large segments to abort mid-stream (`error decoding response body`), added automatic 5-attempt segment resumption on transient failures, and raised default segment connections from `4` to `8`.
**Modified files:** `src-tauri/src/engine/{worker,manager,task}.rs`, `src-tauri/src/db/{schema,repository}.rs`, `src-tauri/src/native_messaging/mod.rs`, `src/components/AddDownloadModal.tsx`, `src/{App,DownloadDialogApp}.tsx`, `src/mock/mockData.ts`.
**Technical details:**
- `src-tauri/src/engine/manager.rs` & `worker.rs`: Replaced `.timeout(Duration::from_secs(30))` with `.connect_timeout(Duration::from_secs(20))` + `.tcp_keepalive(Duration::from_secs(30))`, added 30s per-chunk `tokio::time::timeout` around `stream.next()`, ensured `BufWriter::flush()` executes before returning stream errors/timeouts, and wrapped multi-segment worker tasks in a 5-retry backoff loop that reconciles `.part<index>` byte offsets on disk before resuming.
- `task.rs`, `schema.rs`, `repository.rs`, `native_messaging/mod.rs`, `AddDownloadModal.tsx`, `App.tsx`, `DownloadDialogApp.tsx`, `mockData.ts`: Changed default `segment_count` / `default_segments` to `8`, wired `settings.default_segments` into `AddDownloadModal`, and added a one-time `migrated_default_segments_8` migration for existing `app_settings` rows still at `4`.
**Database changes:** Updated `CREATE_DOWNLOADS_TABLE` `segment_count` default to `8` and added one-time `migrated_default_segments_8` JSON setting upgrade in `Database::new`.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `5.46s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo test && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`integration_tests.rs`: `30 passed, 0 failed` in `4.09s`; release build in `1m 55s`).
- Stopped running `mdm.exe` and synced binaries to `src-tauri/resources/`, `%LOCALAPPDATA%\mdm`, and `%LOCALAPPDATA%\Mak Download Manager` (`5` binary copies succeeded).
**Known issues:** None in build/tests; live multi-minute HTTP transfer verification pending desktop run.


### [2026-11-15] - Single-Page Download, Installation & Architecture Web App

**Summary:** Built a self-contained, single-file download, installation, and technical walkthrough web page (`mdm_tanitim.html` and `dist-installer/index.html`) ready for Google Drive hosting, featuring real high-DPI screenshots captured from MDM's live React UI and Chromium extension popup.
**Modified files:** `src/App.tsx`, `scripts/capture_screenshots.cjs`, `scripts/build_landing_page.cjs`, `docs/screenshots/{dashboard,confirm-video,confirm-file,progress,settings,extension-popup}.png`, `dist-installer/portable/{mdm.exe,mdm_host.exe,browser-extension/*}`, `mdm_tanitim.html`, `dist-installer/index.html`.
**Technical details:**
- Added a browser-preview-only `?shot=` query parameter hook in `src/App.tsx` (only active when `!isTauri`) to render clean states for `dashboard`, `confirm-video`, `confirm-file`, `progress`, and `settings`.
- Implemented `scripts/capture_screenshots.cjs` using an async Node HTTP server and headless Chrome (`--force-device-scale-factor=2`) to capture 6 real screenshots (`docs/screenshots/*.png`), including mocking `chrome.storage` / `chrome.runtime` in-memory when serving `browser-extension/popup.html`.
- Implemented `scripts/build_landing_page.cjs` to embed all 6 screenshots and `src-tauri/icons/128x128.png` directly as base64 data URIs into a matte dark/light desktop-styled single-file HTML page (`2709 KB`, no emojis, no neon gradients, no external assets).
- Included interactive window preview tabs, lightbox zoom modal, 3-step setup instructions (desktop installer + portable, Chrome/Brave `chrome://extensions` guide with copyable paths and fixed extension ID `pgeehhablgafglpdgcdnbpfgfcdajijb`, `yt-dlp`/`FFmpeg` setup), 4-stage engine architecture breakdown, troubleshooting FAQ, and `DRIVE_CONFIG` override support.
- Synced latest release `mdm.exe`, `mdm_host.exe`, and `browser-extension/*` (`14` files) into `dist-installer/portable/`.
**Database changes:** None.
**Tests:**
- `cmd /c "node scripts/capture_screenshots.cjs"` -> exit code `0` (6 PNG screenshots generated and visually verified).
- `cmd /c "node scripts/build_landing_page.cjs"` -> exit code `0` (`mdm_tanitim.html` and `dist-installer/index.html` generated, `2709 KB` each; full-page headless Chrome preview verified).
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `5.26s`, `prepare-resources.cjs` OK).
**Known issues:** Existing `dist-installer/Mak Download Manager_0.1.0_x64-setup.exe` and `mdm-browser-extension-v1.0.0.zip` predate this session (`12.10.2026`); `dist-installer/portable/` holds the latest `15.11.2026` release binaries.

### [2026-11-15] - Browser Save-As Dialog Suppression & 0%–100% Segment Merge Progress

**Summary:** Eliminated Chromium's native OS "Save As" dialog from opening alongside MDM during download interception and added an IDM-style `0% -> 100%` segment merging phase (`Parçalar birleştiriliyor...`) in the backend and progress UI.
**Modified files:** `browser-extension/background.js`, `src-tauri/src/engine/{worker,manager}.rs`, `src/types/download.ts`, `src/App.tsx`, `src/components/DownloadProgressModal.tsx`.
**Technical details:**
- `browser-extension/background.js`: Cached `interceptDownloadsEnabled` in memory via `chrome.storage.local` + `chrome.storage.onChanged`, registered `chrome.downloads.onDeterminingFilename`, synchronously executed `chrome.downloads.cancel` + `erase` before any `await` in both `onCreated` and `onDeterminingFilename`, deduplicated via `handledDownloadIds`, and added a browser fallback guarded by `fallbackBrowserUrls` / `byExtensionId`.
- `src-tauri/src/engine/worker.rs` & `manager.rs`: Added `MergeProgressCallback` and `DownloadWorker::finalize_segments_with_progress` (throttled percentage callbacks + smooth sub-300ms step interpolation for fast SSDs), stopped `ticker_handle` prior to merging so `"download-progress"` emits `merging: true` / `merge_progress: 0..100`, and removed the redundant post-merge `compute_file_sha256` pass.
- `src/types/download.ts`, `src/App.tsx`, `src/components/DownloadProgressModal.tsx`: Added `merging` / `merge_progress` fields and rendered the blue merge progress bar, percentage label, segment `"Parça birleştiriliyor..."` status, and standalone window title.
**Database changes:** None.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `3.35s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo test && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`integration_tests.rs`: `30 passed, 0 failed` in `4.09s`; release build in `1m 50s`).
- Stopped running `mdm.exe` and synced release binaries + `browser-extension/*` (`14` files) to `src-tauri/resources/`, `%LOCALAPPDATA%\mdm`, and `%LOCALAPPDATA%\Mak Download Manager` -> exit code `0`.
**Known issues:** Already-loaded unpacked Chrome/Brave extensions require clicking **Yenile (Reload)** in `chrome://extensions` to load the updated `background.js`.

### [2026-11-15] - Google Drive Release ZIP Packaging & Standalone HTML Download Update

**Summary:** Rebuilt the NSIS Windows setup executable with complete extension files (`content.js`, `content.css`), generated separate ready-to-upload ZIP/EXE distribution packages in `drive-yuklenecekler/`, and updated `mdm_tanitim.html` (`DRIVE_CONFIG`) for standalone HTML publication with external Google Drive download links.
**Modified files:** `C:\Users\MertAli\AppData\Local\CargoTarget\mdm\release\nsis\x64\installer.nsi`, `scripts/build_landing_page.cjs`, `mdm_tanitim.html`, `dist-installer/index.html`, `dist-installer/Mak Download Manager_0.1.0_x64-setup.exe`, `dist-installer/mdm-browser-extension-v1.0.0.zip`, `dist-installer/mdm-portable-v0.1.0-x64.zip`, `drive-yuklenecekler/*`, `docs/PROJECT_CONTEXT.md`.
**Technical details:**
- Added `content.css` and `content.js` to both `Install` (`File /a`) and `Uninstall` (`Delete`) sections of `installer.nsi` and compiled the updated NSIS installer via `makensis.exe /V2` (`7,254,440` bytes / `6.9 MB`).
- Packaged `drive-yuklenecekler/` via Windows `tar.exe -a -c -f` containing: `mdm-setup-v0.1.0-x64.zip` (`7,236,742` bytes), `Mak Download Manager_0.1.0_x64-setup.exe` (`7,254,440` bytes), `mdm-browser-extension-v1.0.0.zip` (`64,454` bytes / `63 KB`), `mdm-portable-v0.1.0-x64.zip` (`9,110,439` bytes / `8.7 MB`), and standalone `mdm_tanitim.html` (`2,774,369` bytes / `2709 KB`).
- Updated `scripts/build_landing_page.cjs` to dynamically compute exact package sizes from `drive-yuklenecekler/`, switched the third download card to `mdm-portable-v0.1.0-x64.zip` (`Portable ZIP İndir`), and wired `DRIVE_CONFIG` (`setupExe`, `extensionZip`, `portableZip`).
**Database changes:** None.
**Tests:** Verified `makensis.exe /V2` compilation (exit code `0`), inspected all 3 generated ZIP archives via `tar -tf`, regenerated landing pages (`node scripts/build_landing_page.cjs`, exit code `0`), and visually verified the rendered 3-card download section via headless Chrome.
**Known issues:** `DRIVE_CONFIG` URLs in `mdm_tanitim.html` are intentionally empty until the user uploads the ZIP/EXE files to Google Drive and inserts the share/download links.

### [2026-11-15] - Generic Movie/Embed Video Stream Sniffing (HLS/DASH) & Header Forwarding

**Summary:** Fixed `HTTP Error 404: Not Found` errors on embedded streaming/movie sites (e.g., `hdfilmcehennemi` / `rapidrame` / `vidmoly`) by capturing actual `.m3u8`/`.mpd`/`.mp4` streams in the browser extension and forwarding `Referer`, `Cookie`, `User-Agent`, and page title end-to-end to `yt-dlp`.
**Modified files:** `browser-extension/{content,background}.js`, `src-tauri/src/native_messaging/{mod,ipc}.rs`, `src-tauri/src/video/{mod,analyzer,downloader,manager}.rs`, `src-tauri/src/commands.rs`, `src/{App,DownloadDialogApp}.tsx`, `src/components/AddDownloadModal.tsx`.
**Technical details:**
- `browser-extension/content.js` & `background.js`: Passed `frameUrl`, `pageReferrer`, and `pageTitle` from content script; excluded `.ts`/`.m4s` segment URLs from `tab_media_${tabId}`; expanded `webRequest.onBeforeRequest` to capture generic `.m3u8` / `master.txt` / `playlist.txt` / `.mpd` / `.mp4` / `media` requests along with `documentUrl || initiator`; resolved non-platform iframe/HTML URLs to the captured master playlist/manifest/direct stream (polling up to 600ms if newly started); collected cookies across CDN, iframe `Referer`, and tab URL.
- `src-tauri/src/native_messaging/{mod,ipc}.rs`: Extended `ExtensionRequest::ProbeVideo` with optional `referrer`, `cookies`, `user_agent`, and `title` fields (`#[serde(default)]`) and included them in `open-download-confirm` and `pending_confirm.json`.
- `src-tauri/src/video/{mod,analyzer,downloader,manager}.rs` & `commands.rs`: Added `analyze_video_url_with_headers` (preserving `analyze_video_url` signature for tests) with generic `.m3u8` stream title fallback, and forwarded `--referer`, `--user-agent`, `--add-header Cookie:...`, and `--concurrent-fragments 4` to `yt-dlp` in both analysis and download steps.
- `src/{App,DownloadDialogApp}.tsx` & `src/components/AddDownloadModal.tsx`: Forwarded `cookies`, `referrer`, `userAgent`, and `fallbackTitle` to `probe_video_info` and `add_video_download`.
**Database changes:** None (stored existing `cookies`, `referrer`, and `user_agent` columns on video `DownloadTask` rows).
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `4.29s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo test"` -> exit code `0` (`integration_tests.rs`: `30 passed, 0 failed` in `4.10s`).
- `cmd /c "cd src-tauri && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`1m 48s`).
- Synced binaries and `browser-extension/*` (`14` files) to `src-tauri/resources/`, `%LOCALAPPDATA%\mdm`, `%LOCALAPPDATA%\Mak Download Manager`, and `dist-installer\portable\`, and registered host at `%LOCALAPPDATA%\mdm\com.mak.mdm.json` -> exit code `0`.
**Known issues:** Existing unpacked extensions in Chrome/Brave require clicking **Yenile (Reload)** in `chrome://extensions` and refreshing open movie tabs (`F5`). Distribution archives in `drive-yuklenecekler/` and the NSIS `.exe` predate this commit until rebuilt.

### [2026-11-15] - HLS Progress Template, Fragment Total Estimation & Premature 100% / ETA 0s Fix

**Summary:** Fixed HLS (`.m3u8`) downloads immediately displaying `%100` progress and `0s` remaining time (`Kalan süre: 0`) while actively downloading.
**Modified files:** `src-tauri/src/video/{downloader,manager}.rs`, `src/components/DownloadProgressModal.tsx`.
**Technical details:**
- `src-tauri/src/video/downloader.rs`: Separated `yt-dlp`'s combined `%(progress.total_bytes|progress.total_bytes_estimate|0)s` token (whose `|` fallback was emitted verbatim as a non-numeric string when `total_bytes` was `None`) into independent tokens (`total_bytes`, `total_bytes_estimate`, `fragment_index`, `fragment_count`); added fragment-ratio size estimation (`downloaded * fc / fi`) for VBR HLS playlists and narrowed the stream-switch reset condition to avoid false triggers under `--concurrent-fragments 4`.
- `src-tauri/src/video/manager.rs`: Removed `.max(downloaded)` clamping on `candidate_total` and the premature `is_complete` (`0s`) short-circuit so unknown or understated HLS totals stay strictly ahead of `downloaded_bytes` (`raw_speed * raw_eta` or `+5%`/`+10%`) and fall back to `yt-dlp`'s fragment ETA or `None` (`--:--`).
- `src/components/DownloadProgressModal.tsx`: Capped active `downloading` percentage display at `99.9%` (`%99` in compact window title) and suppressed `( %0.00 )` until a positive `total_bytes` is known.
**Database changes:** None.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `5.22s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo test"` -> exit code `0` (`integration_tests.rs`: `30 passed, 0 failed` in `4.10s`).
- `cmd /c "cd src-tauri && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`2m 25s`).
- Synced updated `mdm.exe` and `mdm_host.exe` across `src-tauri/resources/`, `%LOCALAPPDATA%\mdm`, `%LOCALAPPDATA%\Mak Download Manager`, and `dist-installer\portable\`, and ran `--register-host` -> exit code `0`.
**Known issues:** Live `.m3u8` HLS download UI verification needs desktop observation during an active film download; distribution archives in `drive-yuklenecekler/` and the NSIS `.exe` predate these updates until rebuilt.

### [2026-11-15] - Auto-Close Completion Dialog on File/Folder Open

**Summary:** Closed the completion dialog/window automatically when clicking **"Dosyayı Aç"** or **"Klasörü Aç"**, as well as when auto-open on completion (`openFileOnComplete`) is checked.
**Modified files:** `src/components/DownloadProgressModal.tsx`.
**Technical details:**
- Updated both **"Dosyayı Aç"** (`onOpenFile`) and **"Klasörü Aç"** (`onOpenFolder`) click handlers in the completed view to invoke `onClose()` immediately after opening the file or folder.
- Updated the completion `useEffect` (`if (closeOnComplete || openFileOnComplete)`) so enabling automatic file open on completion also closes the dialog after `800ms`.
**Database changes:** None.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `5.80s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`2m 36s`).
- Synced `mdm.exe` and `mdm_host.exe` to `src-tauri/resources/`, `%LOCALAPPDATA%\mdm\`, `%LOCALAPPDATA%\Mak Download Manager\`, and `dist-installer\portable\`, and ran `--register-host` -> exit code `0`. (Rust backend tests were not re-run for this frontend-only edit; last passed 30/30 on prior commit).
**Known issues:** Requires closing/restarting any previously running desktop window instance to pick up the embedded frontend update; distribution archives in `drive-yuklenecekler/` and the NSIS `.exe` predate these updates until rebuilt.

### [2026-11-15] - GitHub Auto-Updater (Approach 1), README & v0.1.0 Installer Packaging

**Summary:** Added built-in GitHub Releases auto-update checking, SHA-256 verification, silent NSIS (`/S`) installation & relaunch, repository `README.md` / `.gitignore`, `latest.json` manifest, and rebuilt v0.1.0 distribution packages.
**Modified files:** `src-tauri/src/updater.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/types/download.ts`, `src/components/SettingsModal.tsx`, `src/App.tsx`, `README.md`, `.gitignore`, `latest.json`, `docs/PROJECT_CONTEXT.md`.
**Technical details:**
- Implemented `src-tauri/src/updater.rs` using `reqwest` + `serde_json::from_str` (checking `https://github.com/mertalikocak/mdm/releases/latest/download/latest.json` with fallback to GitHub Releases API `/repos/mertalikocak/mdm/releases/latest`), streaming download to `%TEMP%\mdm_update_setup.exe` with `250ms` throttled `"app-update-progress"` events, optional `sha2::Sha256` verification, and detached `mdm_apply_update.cmd` silent installer + relaunch.
- Registered `check_app_update` and `install_app_update` Tauri IPC commands in `commands.rs` and `lib.rs`, plus a 4-second delayed startup check emitting `"app-update-available"`.
- Added an in-app update notification banner in `src/App.tsx` and manual check/download/install controls in `src/components/SettingsModal.tsx`.
- Added `.gitignore`, Turkish `README.md` showcasing screenshots in `docs/screenshots/`, and `latest.json` matching `Mak Download Manager_0.1.0_x64-setup.exe`.
**Database changes:** None.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `4.85s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo test && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`tests\integration_tests.rs`: 30 passed, 0 failed in `4.09s`; release compiled in `1m 52s`).
- Synced binaries, rebuilt NSIS installer via `makensis.exe /V2` (`7,348,473` bytes), updated ZIPs in `dist-installer/` and `drive-yuklenecekler/`, and computed SHA-256 (`7caa925cf1abd002954f1f532f67d082f28cf8351400cbadcabc7b88bca67df7`) via `certutil`.
**Known issues:** Live update download/apply requires publishing the `v0.1.0` Release (and a subsequent newer tag such as `v0.1.1`) on GitHub.

### [2026-11-16] - Automatic Startup & On-Demand Provisioning for yt-dlp and FFmpeg

**Summary:** Removed manual setup friction for video downloads by automatically installing `yt-dlp` and `FFmpeg` in the background on startup and on-demand during video analysis or download while keeping the NSIS installer lightweight (~7.3 MB).
**Modified files:** `src-tauri/src/video/manager.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/integration_tests.rs`, `src/components/SettingsModal.tsx`, `README.md`, `latest.json`, `docs/PROJECT_CONTEXT.md`.
**Technical details:**
- Added `ytdlp_install_lock`, `ensure_ytdlp_with_lock`, `ensure_ffmpeg_with_lock`, `ensure_all_tools`, and `analyze_video_with_headers` on `VideoManager` (`src-tauri/src/video/manager.rs`) with `User-Agent` and a 300s download timeout.
- Updated `probe_video_info` (`commands.rs`) to invoke `VideoManager::analyze_video_with_headers` so video probing auto-provisions `yt-dlp.exe` if needed, while keeping `analyzer::analyze_video_url` pure for unit tests.
- Updated `start_video_download` (`video/manager.rs`) to provision both `yt-dlp` and `FFmpeg` safely under mutexes before invoking `execute_video_download`.
- Spawned `video_startup.ensure_all_tools()` in `lib.rs` on app startup and added live `"video-tools-updated"` listener + updated status text in `src/components/SettingsModal.tsx`.
**Database changes:** None.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `4.97s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo test && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`tests\integration_tests.rs`: 31 passed, 0 failed in `4.10s`; release compiled in `1m 52s`).
- Synced binaries, rebuilt NSIS installer via `makensis.exe /V2` (`7,337,060` bytes), updated ZIPs and `latest.json` (`sha256: 8e637b89d41d7a79af1624602c4c0447473dfc22c12bd2e87ad289f98ddfd19e`).
**Known issues:** Requires internet access on first run or first video request if `%LOCALAPPDATA%\mdm\bin` is empty.

### [2026-11-16] - Responsive Table, Sidebar, and Navbar Layout for Smaller Windows

**Summary:** Fixed right-edge horizontal clipping of the download table (`İşlemler` column) and improved responsive layout across smaller desktop window widths.
**Modified files:** `src/components/DownloadTable.tsx`, `src/components/Sidebar.tsx`, `src/components/Navbar.tsx`, `latest.json`, `docs/PROJECT_CONTEXT.md`.
**Technical details:**
- Changed `DownloadTable` from `table-auto` to `table-fixed w-full`, tightened fixed column widths, and removed `max-w-[225px]` on file path so long filenames/paths cleanly truncate inside the flexible `Dosya Adı` column without expanding the table beyond `942px` (or smaller panes).
- Added responsive column breakpoints (`Hız` visible `md:`, `Kalan Süre` visible `lg:`), collapsible icon-rail sidebar below `md:` (`w-14 md:w-44 lg:w-52`), and `min-w-0` / `shrink-0` toolbar sizing in `Navbar`.
**Database changes:** None.
**Tests:**
- `cmd /c "npx tsc --noEmit && npm run build"` -> exit code `0` (`vite` built 1607 modules in `4.80s`, `prepare-resources.cjs` OK).
- `cmd /c "cd src-tauri && cargo build --release --bins --features custom-protocol"` -> exit code `0` (`2m 17s`).
- Synced release binaries, rebuilt NSIS installer (`7,337,270` bytes), updated ZIPs and `latest.json` (`sha256: d4a36e47d5c1d7991cfb74bad422319e2c2edf5423912f8e266975900f572caf`). (Rust tests were not re-run for this UI-only change; last passed 31/31 prior to UI change).
**Known issues:** None.
