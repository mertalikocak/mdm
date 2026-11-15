use mdm_lib::db::Database;
use mdm_lib::native_messaging::{
    handle_extension_request, read_native_packet, write_native_packet, ExtensionRequest,
    ExtensionResponse,
};
use std::io::{stdin, stdout};
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // Resolve MDM application data directory on Windows
    let app_data_dir = match std::env::var("LOCALAPPDATA") {
        Ok(local) => PathBuf::from(local).join("mdm"),
        Err(_) => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };

    let _ = std::fs::create_dir_all(&app_data_dir);
    let db_path = app_data_dir.join("mdm_v1.db");
    let bin_dir = app_data_dir.join("bin");
    let _ = std::fs::create_dir_all(&bin_dir);

    let default_download_dir = match std::env::var("USERPROFILE") {
        Ok(prof) => PathBuf::from(prof).join("Downloads"),
        Err(_) => PathBuf::from("C:\\Downloads"),
    };

    let database = match Database::new(&db_path) {
        Ok(db) => Arc::new(db),
        Err(e) => {
            let err_resp = serde_json::json!({
                "type": "error",
                "code": "DB_INIT_FAILED",
                "message": format!("Database initialization error: {}", e)
            });
            let _ = write_native_packet(&mut stdout(), &err_resp);
            return;
        }
    };

    let mut stdin_lock = stdin().lock();
    let mut stdout_lock = stdout();

    // Standard Chromium Native Messaging stdio loop
    loop {
        match read_native_packet(&mut stdin_lock) {
            Ok(json_val) => {
                let req: Result<ExtensionRequest, _> = serde_json::from_value(json_val);
                let resp = match req {
                    Ok(parsed_req) => {
                        let ipc_res = mdm_lib::native_messaging::ipc::send_ipc_to_app(&parsed_req).await;
                        let log_entry = format!(
                            "[{}] IPC success: {} | Req: {:?}\n",
                            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                            ipc_res.is_ok(),
                            parsed_req
                        );
                        let _ = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(app_data_dir.join("host.log"))
                            .and_then(|mut f| std::io::Write::write_all(&mut f, log_entry.as_bytes()));

                        match ipc_res {
                            Ok(app_resp) => app_resp,
                            Err(e) => {
                                let err_entry = format!("   -> IPC failed: {}. Running fallback.\n", e);
                                let _ = std::fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(app_data_dir.join("host.log"))
                                    .and_then(|mut f| std::io::Write::write_all(&mut f, err_entry.as_bytes()));

                                // Fallback: MDM is not running, handle locally and launch app
                                handle_extension_request(
                                    Arc::clone(&database),
                                    &bin_dir,
                                    &default_download_dir.to_string_lossy(),
                                    parsed_req,
                                )
                                .await
                            }
                        }
                    }
                    Err(e) => ExtensionResponse::Error {
                        code: "PARSE_ERROR".to_string(),
                        message: format!("Geçersiz istek formatı: {}", e),
                    },
                };

                let resp_val = match serde_json::to_value(&resp) {
                    Ok(v) => v,
                    Err(e) => serde_json::json!({
                        "type": "error",
                        "code": "SERIALIZE_ERROR",
                        "message": e.to_string()
                    }),
                };

                if write_native_packet(&mut stdout_lock, &resp_val).is_err() {
                    break;
                }
            }
            Err(_) => {
                // EOF or pipe broken: browser disconnected the port
                break;
            }
        }
    }
}
