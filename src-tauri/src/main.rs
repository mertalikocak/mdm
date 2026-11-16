// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let log_dir = std::path::PathBuf::from(local).join("mdm");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join("crash.log");
            let msg = format!("Panic: {}\nLocation: {:?}\nBacktrace: {:?}\n", info, info.location(), std::backtrace::Backtrace::capture());
            let _ = std::fs::write(log_path, msg);
        }
    }));

    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|arg| arg == "--register-host") {
        match mdm_lib::native_messaging::registry::register_native_host(None) {
            Ok(manifest_path) => {
                println!("[OK] Native Messaging Host registered at: {}", manifest_path.display());
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("[HATA] Host registration failed: {}", e);
                std::process::exit(1);
            }
        }
    }

    if args.iter().any(|arg| arg == "--unregister-host") {
        match mdm_lib::native_messaging::registry::unregister_native_host() {
            Ok(_) => {
                println!("[OK] Native Messaging Host unregistered successfully.");
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("[HATA] Host unregistration failed: {}", e);
                std::process::exit(1);
            }
        }
    }

    // Single-instance check: if an active instance already listens on local IPC, delegate focus and exit cleanly
    {
        use std::io::Write;
        use std::net::{SocketAddr, TcpStream};
        let addr = SocketAddr::from(([127, 0, 0, 1], 47990));
        if let Ok(mut stream) = TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)) {
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(500)));
            let payload = br#"{"type":"open_mdm_app"}"#;
            let len_bytes = (payload.len() as u32).to_le_bytes();
            let _ = stream.write_all(&len_bytes);
            let _ = stream.write_all(payload);
            let _ = stream.flush();
            std::process::exit(0);
        }
    }

    // Kernel-level single-instance mutex prevents concurrent startup races from spawning duplicate tray instances
    #[cfg(target_os = "windows")]
    let _instance_mutex = {
        use std::ffi::c_void;

        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(
                lpMutexAttributes: *const c_void,
                bInitialOwner: i32,
                lpName: *const u16,
            ) -> *mut c_void;
            fn GetLastError() -> u32;
            fn CloseHandle(hObject: *mut c_void) -> i32;
        }

        struct MutexGuard(*mut c_void);
        impl Drop for MutexGuard {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe {
                        CloseHandle(self.0);
                    }
                }
            }
        }

        const ERROR_ALREADY_EXISTS: u32 = 183;
        let name: Vec<u16> = "Local\\MakDownloadManager_SingleInstance_v1\0"
            .encode_utf16()
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
        if !handle.is_null() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return;
        }
        MutexGuard(handle)
    };

    mdm_lib::run();
}
