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

    mdm_lib::run();
}
