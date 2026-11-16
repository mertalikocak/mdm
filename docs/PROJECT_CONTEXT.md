# PROJECT_CONTEXT.md — Mak Download Manager (MDM)

## Project Overview
Mak Download Manager (MDM) is a Windows desktop download manager inspired by Internet Download Manager (IDM). It provides segmented parallel HTTP downloads, YouTube/video extraction via `yt-dlp` and `ffmpeg`, persistent SQLite task storage, and Chrome/Brave browser download interception via Native Messaging.

## Technology Stack
- **Desktop Shell**: Tauri 2 (`tauri ^2.2.0`)
- **Frontend**: React 18 (`^18.3.1`), TypeScript 5, Vite 6, Tailwind CSS 3, Lucide React (`^0.475.0`)
- **Backend Core**: Rust (2021 edition), Tokio (`1.43`), Reqwest (`0.12`, streaming), Rusqlite (`0.33`, bundled SQLite with WAL mode), `thiserror`, `chrono`, `uuid`, `sha2`, `futures-util`, `url`
- **Binaries**: `mdm` (Tauri desktop app, `src-tauri/src/main.rs`) and `mdm_host` (Native Messaging stdio bridge, `src-tauri/src/bin/mdm_host.rs`)
- **Video Extraction**: External `yt-dlp.exe` and `ffmpeg.exe` / `ffprobe.exe` in `%LOCALAPPDATA%\mdm\bin`
- **Browser Extension**: Chrome Manifest V3 (`browser-extension/`)

## Architecture Overview
- **Decoupled Engine**: UI handles presentation only and communicates via typed Tauri IPC commands (`src-tauri/src/commands.rs`) and real-time Tauri events (`download-progress`, `open-download-confirm`, etc.).
- **HTTP Download Engine**: `src-tauri/src/engine/` handles URL probing (`probe.rs`), segment planning (`planner.rs`), streaming workers to `.part<index>` / `.mdmpart` with atomic `.mdmmerge` finalization (`worker.rs`), and queue/progress orchestration (`manager.rs`).
- **Video Engine**: `src-tauri/src/video/` integrates `yt-dlp` metadata analysis (`analyzer.rs`), binary discovery/installation (`binaries.rs`), streaming stdout progress parsing (`downloader.rs`), and queue/progress state (`manager.rs`).
- **Native Messaging & IPC**: `mdm_host.exe` communicates over stdio with Chrome/Brave and forwards requests to the running desktop app via TCP (`127.0.0.1:47990`) or Named Pipe (`\\.\pipe\mdm_ipc`), with offline `pending_confirm.json` launch fallback (`native_messaging/mod.rs`, `native_messaging/ipc.rs`, `native_messaging/registry.rs`).

## Directory Structure and Important Files
- `src-tauri/Cargo.toml` — Rust crate and binaries configuration (`mdm`, `mdm_host`, `mdm_lib`)
- `src-tauri/.cargo/config.toml` — Redirects build target directory to `%LOCALAPPDATA%\CargoTarget\mdm` (OneDrive lock avoidance)
- `src-tauri/capabilities/default.json` — Tauri v2 window/event/webview permissions
- `src-tauri/src/main.rs` — Desktop entrypoint, panic hook (`crash.log`), `--register-host` / `--unregister-host` CLI flags
- `src-tauri/src/lib.rs` — App initialization, tray menu, event wiring, IPC startup, window event handling
- `src-tauri/src/commands.rs` — Tauri IPC command handlers
- `src-tauri/src/db/schema.rs` & `repository.rs` — SQLite schema (`downloads`, `settings`) and persistence repository
- `src-tauri/src/engine/{task,probe,planner,worker,manager}.rs` — HTTP segmented engine
- `src-tauri/src/video/{analyzer,binaries,downloader,manager}.rs` — Video download engine
- `src-tauri/src/native_messaging/{mod,ipc,registry}.rs` & `src-tauri/src/bin/mdm_host.rs` — Browser native messaging integration
- `browser-extension/{manifest.json,background.js,content.js,popup.html,popup.js}` — Browser extension
- `src/{App.tsx,index.css}` & `src/components/*` — React desktop UI and compact dialogs (plus `?shot=` browser preview hook)
- `prepare-resources.cjs` — Packages binaries/extension assets during build
- `scripts/capture_screenshots.cjs` & `scripts/build_landing_page.cjs` — Captures real UI screenshots (`docs/screenshots/*.png`) via headless Chrome and builds self-contained `mdm_tanitim.html` & `dist-installer/index.html`

## Database Schema and Important Relationships
SQLite database initialized in `%LOCALAPPDATA%\mdm` (WAL mode):
- `downloads` table: stores task metadata, URLs, destination paths, `total_bytes`, `downloaded_bytes`, `status`, `error_message`, `segments_json`, headers/cookies/referrer/user-agent, `completed_at`, etc.
- `settings` table: key-value store (`app_settings` JSON storing concurrency, default paths, speed limits, appearance).

## API Endpoints and Integrations
- **Local IPC Server**: TCP `127.0.0.1:47990` & Windows Named Pipe `\\.\pipe\mdm_ipc` for `mdm_host.exe` -> `mdm.exe` requests (`ProbeVideo`, `AddDownload`, `OpenMdmApp`, etc.).
- **Native Messaging Host**: Registry manifest `com.mak.mdm.json` pointing to `mdm_host.exe`.

## Authentication and Authorization
- Browser cookies, referrer, and user-agent headers forwarded per download task when captured from the extension or specified in options.

## Environment and Configuration Requirements
- Windows OS with CMD workflow; `.cargo/config.toml` targets `%LOCALAPPDATA%\CargoTarget\mdm`.
- `%LOCALAPPDATA%\mdm\bin` houses `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`.
- `%LOCALAPPDATA%\mdm\com.mak.mdm.json` registers the native messaging host.

## Important Implementation Details
- Streams directly to disk without memory buffering; verifies HTTP 206 Partial Content (with `HEAD` -> `GET Range: bytes=0-0` fallback) before segmenting. Uses `connect_timeout(20s)` + `tcp_keepalive(30s)` on `reqwest::Client` and a 30s per-chunk idle timeout + automatic up-to-5 retry resumption in `DownloadManager`/`DownloadWorker`, flushing buffered bytes before returning errors.
- Uses `.part<index>` / `.mdmpart` and `.mdmmerge` atomic renames, explicit temp cleanup on cancel/remove, `tokio::select!` interruptible worker I/O, and collision-free filename resolution; default segmentation is 8 connections (including one-time migration `migrated_default_segments_8` for legacy `app_settings`).
- Live speed limiting via shared `Arc<AtomicU64>` `RateLimiter` synced with SQLite settings and compact modal Speed Limiter UI.
- Video downloads track DASH/HLS multi-stream and fragment progress cumulatively (`video/downloader.rs` + `video/manager.rs`) with rolling 3.0s EMA speed/ETA smoothing, separate `--progress-template` byte/fragment tokens (`total_bytes`, `total_bytes_estimate`, `fragment_index`, `fragment_count`), fragment-ratio total size estimation for HLS `.m3u8` streams, preference-ordered format size estimation (`analyzer.rs`), and non-premature ETA/percentage caps (`DownloadProgressModal.tsx`).
- Browser extension sniffs HLS (`.m3u8` / `master.txt` / `playlist.txt`), DASH (`.mpd`), and `.mp4`/`.webm`/`.mkv` stream requests across embedded movie/video players (`background.js`), ignores `.ts`/`.m4s` segment chatter, records the request `documentUrl`/`initiator` as `Referer`, and forwards `referrer`, `cookies`, `user_agent`, and page `title` through Native Messaging (`ProbeVideo`) and the React video modals (`App.tsx`, `AddDownloadModal.tsx`, `DownloadDialogApp.tsx`) to `yt-dlp` (`--referer`, `--user-agent`, `--add-header Cookie:...`, `--concurrent-fragments 4`).
- Uses `.part<index>` / `.mdmpart` and `.mdmmerge` atomic renames (`finalize_segments_with_progress` emitting live `merging` / `merge_progress` 0%–100% IPC progress events).
- Chromium extension caches `interceptDownloads` synchronously in `background.js` and cancels/erases intercepted browser downloads in both `onCreated` and `onDeterminingFilename` before async Native Messaging calls, preventing Chromium's OS "Save As" dialog from popping up alongside MDM.
- Single-instance desktop startup checks `127.0.0.1:47990` before WebView2 initialization to avoid `HRESULT(0x800700AA)` collisions; native folder browsing uses Win32 `SHBrowseForFolderW` FFI.

## Current Development Status
- Backend engine stability (per-chunk idle timeout, auto-retry resumption, 0%–100% merge progress reporting, default 8 segments + DB migration), Tauri v2 capabilities, SQLite progress/conflict handling, DASH/HTTP progress/ETA metrics, accurate video format size estimation, generic embed/HLS video stream sniffing with header forwarding (`Referer`/`Cookie`/`User-Agent`/title fallback), synchronous Chromium download interception, and classic IDM-inspired Turkish desktop UI overhaul are implemented and verified.
- Fresh release binaries (`mdm.exe`, `mdm_host.exe`) and updated extension assets (`14` files including `background.js`, `content.js`, `content.css`) are synchronized across `src-tauri/resources/`, `%LOCALAPPDATA%\mdm`, `%LOCALAPPDATA%\Mak Download Manager`, `dist-installer\portable\`, and Native Messaging Host is registered at `%LOCALAPPDATA%\mdm\com.mak.mdm.json` (note: NSIS setup EXE / `drive-yuklenecekler/` archives predate this final embed stream sniffing update unless rebuilt).
- Separate ready-to-upload Google Drive packages (`Mak Download Manager_0.1.0_x64-setup.exe`, `mdm-setup-v0.1.0-x64.zip`, `mdm-browser-extension-v1.0.0.zip`, `mdm-portable-v0.1.0-x64.zip`) and standalone single-file HTML (`mdm_tanitim.html`) with 6 embedded high-DPI UI screenshots (`docs/screenshots/*.png`) and `DRIVE_CONFIG` (`setupExe`, `extensionZip`, `portableZip`) remain in `drive-yuklenecekler/` and `dist-installer/`.

## Known Bugs and Limitations
- Previously installed unpacked Chrome/Brave extensions require clicking **Yenile (Reload)** in `chrome://extensions` (or re-loading `browser-extension/`) and refreshing open tabs so Chromium picks up updated `background.js` / `content.js` / `popup.js`.
- External runtime behavior with live DRM-free video extraction depends on `yt-dlp.exe` / `ffmpeg.exe` in `%LOCALAPPDATA%\mdm\bin` (no live movie-site GUI click test executed in headless terminal).

## Pending Tasks and Next Steps
- Reload the extension in `chrome://extensions`, refresh any open streaming/movie tabs (`F5`), play the video briefly, and verify MDM extracts and downloads embedded `.m3u8`/`.mp4` streams instead of failing with HTTP 404 on iframe URLs.
- Rebuild NSIS setup / `drive-yuklenecekler/` ZIPs before uploading to Google Drive if you want the distributable installers/extension ZIP to include the generic embed stream sniffing update.

## Build, Test and Deployment Commands
- Frontend dev: `npm run dev`
- Frontend typecheck & production build: `npx tsc --noEmit && npm run build`
- Backend check/test/build (inside `src-tauri`): `cargo check --bins`, `cargo test`, `cargo build --release --bins --features custom-protocol` (`custom-protocol` is enabled by default in `Cargo.toml` so standalone `cargo build --release` embeds `dist/` instead of targeting `devUrl` `http://localhost:1420`)
- Landing page & screenshots: `node scripts/capture_screenshots.cjs` and `node scripts/build_landing_page.cjs`
- Native host registration: `mdm.exe --register-host`

## Session Handoff
- **Completed this session**:
  - Added zero-setup automatic `yt-dlp` + `FFmpeg` provisioning (`src-tauri/src/video/manager.rs`, `commands.rs`, `lib.rs`, `src/components/SettingsModal.tsx`, `README.md`): `VideoManager::ensure_all_tools()` runs asynchronously on app startup to download missing `yt-dlp.exe` and `ffmpeg.exe`/`ffprobe.exe` into `%LOCALAPPDATA%\mdm\bin` without inflating the ~7.3 MB installer; `VideoManager::analyze_video_with_headers()` (`probe_video_info`) and `start_video_download()` also auto-provision under `ytdlp_install_lock`/`ffmpeg_install_lock` if needed, emitting `"video-tools-updated"` so `SettingsModal` updates live.
  - Added integration test `test_video_manager_ensure_tools_and_scheme_validation` in `src-tauri/tests/integration_tests.rs`.
  - Verified `npx tsc --noEmit && npm run build` (exit 0, `4.97s`), `cargo test` (`31 passed, 0 failed` in `4.10s`), `cargo build --release --bins --features custom-protocol` (`1m 52s`), rebuilt NSIS installer `Mak Download Manager_0.1.0_x64-setup.exe` (`7,337,060` bytes, SHA-256 `8e637b89d41d7a79af1624602c4c0447473dfc22c12bd2e87ad289f98ddfd19e`), and updated `latest.json` + distribution archives.
- **Remaining/incomplete work**: Push updated commit to `https://github.com/mertalikocak/mdm.git`; user publishing GitHub Release `v0.1.0` with `Mak Download Manager_0.1.0_x64-setup.exe` and `latest.json`.
- **Current implementation status**: All code, tests, binaries, NSIS setup, and docs are updated and verified.
- **Known errors or blockers**: None.
- **Exact next recommended step**: Push to GitHub `main` and create Release `v0.1.0` uploading `Mak Download Manager_0.1.0_x64-setup.exe` and `latest.json`.
- **Important files to inspect when continuing**: `src-tauri/src/video/manager.rs`, `src-tauri/src/video/binaries.rs`, `src-tauri/src/lib.rs`, `src/components/SettingsModal.tsx`.
- **Tests still to be executed**: Live end-to-end test on a clean Windows environment without pre-existing `%LOCALAPPDATA%\mdm\bin`.
