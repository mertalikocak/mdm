# Mak Download Manager (MDM) — Engineering & Architecture Guide

## 1. System Overview

Mak Download Manager (MDM) is a high-performance Windows desktop download manager inspired by Internet Download Manager (IDM). It emphasizes real-world download speed, segmented parallel HTTP streaming, rock-solid data integrity, crash recovery, and modern Windows desktop ergonomics.

### Stack
- **Desktop Shell**: Tauri 2 (v2.2+)
- **Frontend**: React 18, TypeScript 5, Vite 6, Tailwind CSS 3, Lucide React
- **Backend Core**: Rust (2021 edition), Tokio async runtime, Reqwest with streaming, Rusqlite (bundled SQLite with WAL mode)
- **Architecture Pattern**: Decoupled engine. The UI contains zero download logic; it communicates strictly via typed Tauri IPC commands and real-time events.

---

## 2. Directory Structure

```
MDM/
├── src-tauri/                 # Rust backend and download engine
│   ├── Cargo.toml             # Rust dependencies (Tauri, Tokio, Reqwest, Rusqlite)
│   ├── tauri.conf.json        # Tauri 2 app and window configuration
│   ├── build.rs               # Tauri build hooks
│   ├── capabilities/
│   │   └── default.json       # Narrow Tauri permissions
│   ├── icons/                 # Generated application icons (all resolutions)
│   ├── .cargo/
│   │   └── config.toml        # Redirects target-dir outside OneDrive (avoids file-lock OS error 32)
│   └── src/
│       ├── main.rs            # Windows subsystem executable entrypoint
│       ├── lib.rs             # Tauri app setup and command handler registration
│       ├── commands.rs        # Typed IPC command handlers
│       ├── state.rs           # Shared state (Arc<Database>, Arc<DownloadManager>)
│       ├── db/
│       │   ├── mod.rs
│       │   ├── schema.rs      # SQLite schema definitions (downloads, settings)
│       │   └── repository.rs  # Thread-safe SQLite repository with WAL mode
│       ├── engine/
│       │   ├── mod.rs
│       │   ├── task.rs        # DownloadTask, DownloadStatus, SegmentProgress models
│       │   ├── probe.rs       # HTTP Range probe, Content-Length, safe filename extraction
│       │   ├── planner.rs     # Segment partitioner (1, 2, 4, 8, 16 connections)
│       │   ├── worker.rs      # Streaming chunk downloader (.mdmpart) and atomic merger
│       │   └── manager.rs     # Concurrency manager, speed ticker, and event emitter
│       └── video/
│           └── mod.rs         # Clean VideoExtractor abstraction trait for future yt-dlp integration
├── src/                       # Frontend (React 18 + TypeScript + Vite)
│   ├── main.tsx               # React root entrypoint
│   ├── App.tsx                # Main desktop layout, event listeners, state coordination
│   ├── index.css              # Tailwind base, dark mode, custom scrollbars
│   ├── types/
│   │   └── download.ts        # Shared TypeScript models (mirrored from Rust engine)
│   ├── utils/
│   │   └── formatters.ts      # Byte, speed, ETA, and date formatters
│   ├── mock/
│   │   └── mockData.ts        # Realistic preview mock dataset for isolated development
│   └── components/
│       ├── Sidebar.tsx        # Navigation categories, counters, theme switch, settings trigger
│       ├── Navbar.tsx         # Action buttons (Add, Pause/Resume All, Clear), speed HUD
│       ├── DownloadTable.tsx  # Interactive task rows, file icons, and actions
│       ├── SegmentVisualizer.tsx # IDM-inspired parallel segment visualization strip
│       ├── StatusBadge.tsx    # Color-coded animated status indicators
│       ├── AddDownloadModal.tsx # URL input, segment selector, and folder picker
│       └── SettingsModal.tsx  # Concurrency limits, default paths, appearance
├── dist/                      # Compiled frontend bundle
├── package.json               # Node dependencies and scripts
├── tsconfig.json              # TypeScript strict configuration
├── vite.config.ts             # Vite bundler config
└── AGENTS.md                  # This document
```

---

## 3. Core Engine Principles & Safety Guarantees

1. **Never Buffer in Memory**: Data is always streamed via Reqwest's `bytes_stream()` directly to disk using `tokio::io::AsyncWriteExt`.
2. **Range Validation Before Parallelism**: The probe module verifies HTTP 206 Partial Content support before segmenting. If unsupported, the engine falls back to a safe single-stream download.
3. **Safe Part Files & Atomic Finalization**: Segments write to `<destination>.part<index>` files. Once verified complete, they are merged sequentially into a `.mdmmerge` file and atomically renamed to the final destination path.
4. **Collision-Safe Filenames**: The engine never overwrites existing files silently. If `file.zip` exists, it automatically resolves to `file_1.zip`, `file_2.zip`, etc.
5. **Throttled Event Updates**: Progress and speed are broadcasted at 600ms intervals to prevent UI event bus congestion.
6. **OneDrive Build Isolation**: When developing on Windows inside a OneDrive directory, `.cargo/config.toml` redirects the build target directory to `%LOCALAPPDATA%\CargoTarget\mdm` to prevent OneDrive from locking intermediate `.obj` / `.rlib` build files (OS error 32).

---

## 4. Commands for Development & Verification

### Running the Application (Desktop)
```cmd
:: 1. In root directory, install frontend dependencies:
npm install

:: 2. Launch Tauri desktop app in dev mode:
npx tauri dev
```

### Running Frontend Standalone (Fast UI Iteration)
```cmd
npm run dev
:: Opens at http://127.0.0.1:1420/ with simulated mock data and interactive modals
```

### Building & Testing Rust Backend
```cmd
cd src-tauri
cargo test
cargo check
cargo build
```

### Building Frontend Production Bundle
```cmd
npm run build
```

---

## 5. Coding Conventions

- **Tauri IPC**: Always add new commands to `src-tauri/src/commands.rs`, register them in `tauri::generate_handler![]` in `lib.rs`, and declare corresponding types in `src/types/download.ts`.
- **Error Handling**: Use `thiserror` in Rust modules and propagate clear, user-facing error strings over IPC. Never unwrap in network or I/O paths.
- **Security**: Do not execute arbitrary shell commands. System interactions (such as opening file locations in Windows Explorer) must use explicit, sanitized APIs without user-provided shell expansion.
- **Video Module**: The `VideoExtractor` trait in `src-tauri/src/video/mod.rs` isolates third-party tools like `yt-dlp` and `ffmpeg` behind a clean abstraction. Do not implement DRM-circumvention.
