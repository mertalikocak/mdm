/**
 * Prepares bundle resources (mdm_host.exe, browser-extension, scripts)
 * before Tauri packages the Windows NSIS installer.
 */

const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const tauriResourcesDir = path.join(rootDir, "src-tauri", "resources");
const extensionSrcDir = path.join(rootDir, "browser-extension");
const extensionDestDir = path.join(tauriResourcesDir, "browser-extension");

// Ensure directory exists
fs.mkdirSync(tauriResourcesDir, { recursive: true });

// 1. Locate and copy mdm_host.exe
const localAppData = process.env.LOCALAPPDATA || "";
const candidateHostPaths = [
  path.join(localAppData, "CargoTarget", "mdm", "release", "mdm_host.exe"),
  path.join(localAppData, "CargoTarget", "mdm", "debug", "mdm_host.exe"),
  path.join(rootDir, "src-tauri", "target", "release", "mdm_host.exe"),
  path.join(rootDir, "src-tauri", "target", "debug", "mdm_host.exe"),
];

function copyIfDifferent(src, dest) {
  if (fs.existsSync(dest)) {
    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);
    if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
      return false;
    }
  }
  fs.copyFileSync(src, dest);
  return true;
}

let hostFound = false;
for (const p of candidateHostPaths) {
  if (fs.existsSync(p)) {
    const destHost = path.join(tauriResourcesDir, "mdm_host.exe");
    if (copyIfDifferent(p, destHost)) {
      console.log(`[OK] mdm_host.exe kopyalandi: ${p} -> ${destHost}`);
    }
    hostFound = true;
    break;
  }
}

if (!hostFound) {
  console.warn("[UYARI] mdm_host.exe bulunamadi! Lutfen once 'cargo build --bins' calistirin.");
}

// 2. Copy browser extension files
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyIfDifferent(srcPath, destPath);
    }
  }
}

copyDirSync(extensionSrcDir, extensionDestDir);

// 3. Copy helper scripts
const scripts = ["register_host.bat", "unregister_host.bat"];
for (const s of scripts) {
  const sPath = path.join(extensionSrcDir, s);
  if (fs.existsSync(sPath)) {
    copyIfDifferent(sPath, path.join(tauriResourcesDir, s));
  }
}

console.log("[OK] Kurulum oncesi paket kaynaklari basariyla hazirlandi.");
