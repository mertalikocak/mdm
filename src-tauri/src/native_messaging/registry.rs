use std::path::{Path, PathBuf};

pub const EXTENSION_ID: &str = "pgeehhablgafglpdgcdnbpfgfcdajijb";
pub const HOST_NAME: &str = "com.mak.mdm";

/// Finds the real path of `mdm_host.exe` on the current machine
pub fn find_host_binary(explicit_path: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = explicit_path {
        if p.is_file() {
            return Ok(p.to_path_buf());
        }
    }

    // 1. Same directory as current running executable (Installed or portable folder)
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join("mdm_host.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
            let res_candidate = parent.join("resources").join("mdm_host.exe");
            if res_candidate.is_file() {
                return Ok(res_candidate);
            }
        }
    }

    // 2. Cargo target directory in LocalAppData (Development build)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let debug_target = PathBuf::from(&local_app_data)
            .join("CargoTarget")
            .join("mdm")
            .join("debug")
            .join("mdm_host.exe");
        if debug_target.is_file() {
            return Ok(debug_target);
        }

        let release_target = PathBuf::from(&local_app_data)
            .join("CargoTarget")
            .join("mdm")
            .join("release")
            .join("mdm_host.exe");
        if release_target.is_file() {
            return Ok(release_target);
        }

        let mdm_app_target = PathBuf::from(&local_app_data)
            .join("mdm")
            .join("mdm_host.exe");
        if mdm_app_target.is_file() {
            return Ok(mdm_app_target);
        }
    }

    Err("mdm_host.exe ikili dosyası bulunamadı.".to_string())
}

/// Registers the Native Messaging Host manifest and Windows registry keys for Chrome, Brave and Edge
pub fn register_native_host(explicit_path: Option<&Path>) -> Result<PathBuf, String> {
    let host_path = find_host_binary(explicit_path)?;

    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|e| format!("LOCALAPPDATA environment variable not found: {}", e))?;
    let manifest_dir = PathBuf::from(&local_app_data).join("mdm");
    let _ = std::fs::create_dir_all(&manifest_dir);
    let manifest_path = manifest_dir.join(format!("{}.json", HOST_NAME));

    // Construct valid JSON manifest with deterministic extension ID
    let manifest_json = serde_json::json!({
        "name": HOST_NAME,
        "description": "Mak Download Manager Native Messaging Host",
        "path": host_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [
            format!("chrome-extension://{}/", EXTENSION_ID)
        ]
    });

    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest_json).unwrap())
        .map_err(|e| format!("Manifest dosyası yazılamadı: {}", e))?;

    #[cfg(windows)]
    {
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        use std::os::windows::process::CommandExt;

        let manifest_str = manifest_path.to_str().unwrap_or_default();

        let registry_targets = [
            r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mak.mdm",
            r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.mak.mdm",
            r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mak.mdm",
        ];

        for key in &registry_targets {
            let _ = Command::new("reg")
                .args(["add", key, "/ve", "/t", "REG_SZ", "/d", manifest_str, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }

    Ok(manifest_path)
}

/// Unregisters MDM Native Messaging Host registry keys and deletes the manifest file.
/// Never touches user database or downloaded files.
pub fn unregister_native_host() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        use std::os::windows::process::CommandExt;

        let registry_targets = [
            r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mak.mdm",
            r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.mak.mdm",
            r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mak.mdm",
        ];

        for key in &registry_targets {
            let _ = Command::new("reg")
                .args(["delete", key, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let manifest_path = PathBuf::from(local_app_data)
            .join("mdm")
            .join(format!("{}.json", HOST_NAME));
        if manifest_path.is_file() {
            let _ = std::fs::remove_file(manifest_path);
        }
    }

    Ok(())
}

/// Verifies whether the Native Messaging Host is currently registered and points to an existing binary
pub fn verify_native_host_registration() -> bool {
    let local_app_data = match std::env::var("LOCALAPPDATA") {
        Ok(v) => v,
        Err(_) => return false,
    };
    let manifest_path = PathBuf::from(local_app_data)
        .join("mdm")
        .join(format!("{}.json", HOST_NAME));

    if !manifest_path.is_file() {
        return false;
    }

    // Expected host binary for the currently running process
    let expected_host = match find_host_binary(None) {
        Ok(h) => h,
        Err(_) => return false,
    };

    if let Ok(content) = std::fs::read_to_string(&manifest_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(path_str) = val.get("path").and_then(|p| p.as_str()) {
                let current_target = Path::new(path_str);
                return current_target.is_file() && current_target == expected_host;
            }
        }
    }

    false
}
