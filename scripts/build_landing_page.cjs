/**
 * Generates self-contained single-file download & documentation pages:
 *   - mdm_tanitim.html (project root)
 *   - dist-installer/index.html (inside distribution folder)
 *
 * Embeds real captured screenshots from docs/screenshots/*.png and
 * app icon from src-tauri/icons/128x128.png as base64 data URIs so
 * there are zero external runtime dependencies.
 */

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const shotsDir = path.join(rootDir, "docs", "screenshots");
const iconPath = path.join(rootDir, "src-tauri", "icons", "128x128.png");
const distDir = path.join(rootDir, "dist-installer");
const driveDir = path.join(rootDir, "drive-yuklenecekler");

function formatPkgSize(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const bytes = fs.statSync(filePath).size;
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

const pkgSizes = {
  setupExe: formatPkgSize(path.join(driveDir, "Mak Download Manager_0.1.0_x64-setup.exe"), "6.9 MB"),
  extensionZip: formatPkgSize(path.join(driveDir, "mdm-browser-extension-v1.0.0.zip"), "63 KB"),
  portableZip: formatPkgSize(path.join(driveDir, "mdm-portable-v0.1.0-x64.zip"), "8.7 MB"),
};

function toDataUri(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Eksik gorsel dosyasi: ${filePath}`);
  }
  const b64 = fs.readFileSync(filePath).toString("base64");
  return `data:image/png;base64,${b64}`;
}

const assets = {
  icon: toDataUri(iconPath),
  dashboard: toDataUri(path.join(shotsDir, "dashboard.png")),
  confirmVideo: toDataUri(path.join(shotsDir, "confirm-video.png")),
  confirmFile: toDataUri(path.join(shotsDir, "confirm-file.png")),
  progress: toDataUri(path.join(shotsDir, "progress.png")),
  settings: toDataUri(path.join(shotsDir, "settings.png")),
  extensionPopup: toDataUri(path.join(shotsDir, "extension-popup.png")),
};

const html = `<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mak Download Manager (MDM) — İndirme, Kurulum ve Mimari Rehberi</title>
  <link rel="icon" type="image/png" href="${assets.icon}">
  <style>
    :root {
      --bg: #f5f6f8;
      --surface: #ffffff;
      --surface-2: #eef1f5;
      --surface-code: #f0f3f7;
      --border: #d0d7de;
      --border-strong: #9aa5b4;
      --text: #0f172a;
      --text-muted: #475569;
      --text-subtle: #64748b;
      --accent: #0078d7;
      --accent-hover: #0066b8;
      --accent-soft: rgba(0, 120, 215, 0.1);
      --accent-border: rgba(0, 120, 215, 0.3);
      --success: #15803d;
      --success-soft: rgba(21, 128, 61, 0.1);
      --success-border: rgba(21, 128, 61, 0.3);
      --warning: #b45309;
      --warning-soft: rgba(180, 83, 9, 0.1);
      --header-bg: rgba(245, 246, 248, 0.92);
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
      --shadow-md: 0 8px 24px rgba(15, 23, 42, 0.08);
    }

    html.dark {
      --bg: #12151a;
      --surface: #181b20;
      --surface-2: #1f242b;
      --surface-code: #14171c;
      --border: #2a313c;
      --border-strong: #3b4454;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --text-subtle: #6b788c;
      --accent: #0078d7;
      --accent-hover: #1a86dc;
      --accent-soft: rgba(0, 120, 215, 0.15);
      --accent-border: rgba(56, 152, 236, 0.35);
      --success: #22c55e;
      --success-soft: rgba(34, 197, 94, 0.12);
      --success-border: rgba(34, 197, 94, 0.32);
      --warning: #f59e0b;
      --warning-soft: rgba(245, 158, 11, 0.12);
      --header-bg: rgba(18, 21, 26, 0.92);
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
      --shadow-md: 0 12px 32px rgba(0, 0, 0, 0.45);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      scroll-behavior: smooth;
      scroll-padding-top: 72px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.6;
      font-size: 15px;
      -webkit-font-smoothing: antialiased;
    }

    code, pre, .mono {
      font-family: "JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace;
    }

    .container {
      max-width: 1140px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* Header */
    .site-header {
      position: sticky;
      top: 0;
      z-index: 40;
      background: var(--header-bg);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
    }

    .header-inner {
      height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
      min-width: 0;
    }

    .brand img {
      width: 30px;
      height: 30px;
      border-radius: 6px;
      border: 1px solid var(--border);
      flex-shrink: 0;
    }

    .brand-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }

    .brand-version {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 2px 7px;
      border-radius: 4px;
      white-space: nowrap;
    }

    .nav-links {
      display: flex;
      align-items: center;
      gap: 22px;
    }

    .nav-links a {
      text-decoration: none;
      color: var(--text-muted);
      font-size: 13.5px;
      font-weight: 500;
      transition: color 0.15s ease;
    }

    .nav-links a:hover {
      color: var(--text);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn-icon {
      width: 34px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-muted);
      cursor: pointer;
      transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
    }

    .btn-icon:hover {
      color: var(--text);
      border-color: var(--border-strong);
      background: var(--surface-2);
    }

    .btn-header-dl {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      background: var(--accent);
      color: #ffffff;
      border-radius: 6px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.15s ease;
    }

    .btn-header-dl:hover {
      background: var(--accent-hover);
    }

    /* Section Base */
    section {
      padding: 64px 0;
      border-bottom: 1px solid var(--border);
    }

    section:last-of-type {
      border-bottom: none;
    }

    .section-head {
      margin-bottom: 32px;
      max-width: 720px;
    }

    .eyebrow {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.03em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .section-head h2 {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.25;
      margin-bottom: 10px;
    }

    .section-head p {
      color: var(--text-muted);
      font-size: 15px;
    }

    /* Hero + Download Center */
    .hero-section {
      padding: 48px 0 64px;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: 1fr 1.15fr;
      gap: 36px;
      align-items: start;
    }

    .hero-meta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      border-radius: 4px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    .hero-title {
      font-size: 36px;
      font-weight: 800;
      letter-spacing: -0.025em;
      line-height: 1.15;
      margin-bottom: 14px;
    }

    .hero-desc {
      color: var(--text-muted);
      font-size: 15.5px;
      line-height: 1.65;
      margin-bottom: 24px;
    }

    /* Download Package Stack */
    .dl-stack {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }

    .dl-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 14px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s ease;
    }

    .dl-card:hover {
      border-color: var(--border-strong);
    }

    .dl-card.is-primary {
      border-color: var(--accent-border);
      background: var(--surface-2);
    }

    .dl-info {
      min-width: 0;
    }

    .dl-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 3px;
    }

    .dl-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
    }

    .tag {
      font-size: 11px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-muted);
      white-space: nowrap;
    }

    .tag-blue {
      background: var(--accent-soft);
      border-color: var(--accent-border);
      color: #60a5fa;
    }

    html:not(.dark) .tag-blue {
      color: #005a9e;
    }

    .tag-green {
      background: var(--success-soft);
      border-color: var(--success-border);
      color: var(--success);
    }

    .dl-sub {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .dl-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
      flex-shrink: 0;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text);
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .dl-btn:hover {
      background: var(--surface);
      border-color: var(--border-strong);
    }

    .dl-btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }

    .dl-btn.primary:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    .spec-strip {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      padding: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 12.5px;
    }

    .spec-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .spec-label {
      font-size: 11px;
      color: var(--text-subtle);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      font-weight: 600;
    }

    .spec-value {
      font-weight: 600;
      color: var(--text);
      font-size: 12px;
      word-break: keep-all;
    }

    .spec-value.mono {
      font-size: 11px;
    }

    /* Hero Preview Frame */
    .preview-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow-md);
    }

    .preview-tabs {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 10px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }

    .preview-tab {
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }

    .preview-tab:hover {
      color: var(--text);
      background: var(--surface);
    }

    .preview-tab.active {
      color: var(--text);
      background: var(--surface);
      border-color: var(--border);
    }

    .preview-stage {
      background: #14171c;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 360px;
      cursor: zoom-in;
      position: relative;
    }

    .preview-stage img {
      max-width: 100%;
      max-height: 410px;
      width: auto;
      height: auto;
      border-radius: 4px;
      border: 1px solid #2b3340;
      display: block;
    }

    .preview-caption {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      background: var(--surface-2);
      border-top: 1px solid var(--border);
      font-size: 12.5px;
      color: var(--text-muted);
    }

    .zoom-hint {
      font-size: 11.5px;
      color: var(--text-subtle);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }

    /* Walkthrough Rows (Screenshots) */
    .walkthrough-list {
      display: flex;
      flex-direction: column;
      gap: 40px;
    }

    .walk-row {
      display: grid;
      grid-template-columns: 1fr 1.15fr;
      gap: 32px;
      align-items: center;
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow-sm);
    }

    .walk-row.reverse {
      grid-template-columns: 1.15fr 1fr;
    }

    .walk-row.reverse .walk-media {
      order: -1;
    }

    .walk-num {
      font-size: 12px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 6px;
      display: inline-block;
    }

    .walk-text h3 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.015em;
      margin-bottom: 10px;
    }

    .walk-text p {
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom: 14px;
    }

    .bullet-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .bullet-list li {
      position: relative;
      padding-left: 18px;
      font-size: 13.5px;
      color: var(--text-muted);
    }

    .bullet-list li::before {
      content: "";
      position: absolute;
      left: 0;
      top: 9px;
      width: 6px;
      height: 6px;
      border-radius: 1px;
      background: var(--accent);
    }

    .bullet-list li strong {
      color: var(--text);
      font-weight: 600;
    }

    .shot-frame {
      background: #14171c;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      cursor: zoom-in;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .shot-frame img {
      width: 100%;
      height: auto;
      display: block;
    }

    .shot-pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .shot-pair.shot-pair-mixed {
      grid-template-columns: 1.42fr 0.78fr;
      align-items: stretch;
    }

    .shot-pair.shot-pair-mixed .shot-frame img {
      margin: auto 0;
    }

    .shot-subcap {
      padding: 8px 12px;
      background: var(--surface-2);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    /* Authentic In-Page Video Grabber Widget Preview */
    .grabber-demo-wrap {
      margin-top: 12px;
      background: var(--surface-code);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
    }

    .grabber-demo-player {
      position: relative;
      height: 112px;
      border-radius: 4px;
      background: #0c0e12;
      border: 1px solid #2b3340;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #64748b;
      font-size: 12px;
    }

    .mdm-grabber-mock {
      position: absolute;
      top: -14px;
      right: 10px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid rgba(56, 189, 248, 0.55);
      border-radius: 5px 5px 2px 2px;
      color: #f1f5f9;
      font-size: 11.5px;
      font-weight: 600;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
    }

    .mdm-grabber-play {
      width: 15px;
      height: 15px;
      border-radius: 3px;
      background: linear-gradient(135deg, #10b981 0%, #06b6d4 100%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
    }

    .mdm-grabber-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      background: rgba(56, 189, 248, 0.18);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 3px;
    }

    /* Install Stepper */
    .steps-grid {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .step-card {
      display: grid;
      grid-template-columns: 56px 1fr;
      gap: 20px;
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    .step-badge {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 15px;
      color: var(--accent);
      font-family: "JetBrains Mono", monospace;
    }

    .step-body h3 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .step-body p {
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom: 12px;
    }

    .step-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-top: 12px;
    }

    .sub-panel {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
    }

    .sub-panel h4 {
      font-size: 13.5px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .sub-panel p, .sub-panel ol {
      font-size: 13px;
      color: var(--text-muted);
    }

    .sub-panel ol {
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .copy-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 10px;
      background: var(--surface-code);
      border: 1px solid var(--border);
      border-radius: 5px;
      margin-top: 8px;
      font-size: 12px;
    }

    .copy-row code {
      color: var(--text);
      overflow-x: auto;
      white-space: nowrap;
    }

    .btn-copy {
      padding: 3px 9px;
      font-size: 11.5px;
      font-weight: 600;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-muted);
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }

    .btn-copy:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }

    .btn-copy.copied {
      color: var(--success);
      border-color: var(--success-border);
    }

    /* Chrome Extensions Diagram */
    .ext-diagram {
      margin-top: 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--surface-code);
    }

    .ext-diag-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      gap: 12px;
      flex-wrap: wrap;
    }

    .ext-diag-url {
      padding: 4px 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: monospace;
      color: var(--text-muted);
    }

    .ext-diag-dev {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      color: var(--text);
    }

    .switch-pill {
      width: 32px;
      height: 18px;
      border-radius: 999px;
      background: var(--accent);
      position: relative;
      display: inline-block;
    }

    .switch-pill::after {
      content: "";
      position: absolute;
      top: 2px;
      right: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #ffffff;
    }

    .ext-diag-body {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .ext-diag-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .ext-diag-btn {
      padding: 5px 11px;
      border-radius: 4px;
      border: 1px solid var(--accent-border);
      background: var(--accent-soft);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }

    .ext-diag-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 12px 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      flex-wrap: wrap;
    }

    /* Architecture & Logic */
    .arch-pipeline {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 28px;
    }

    .pipe-node {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .pipe-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      font-weight: 700;
      color: var(--accent);
    }

    .pipe-node h3 {
      font-size: 15px;
      font-weight: 700;
    }

    .pipe-node p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .pipe-file {
      margin-top: auto;
      padding-top: 8px;
      border-top: 1px solid var(--border);
      font-size: 11.5px;
      color: var(--text-subtle);
      font-family: monospace;
    }

    .logic-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
    }

    .logic-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 22px;
    }

    .logic-card h3 {
      font-size: 16.5px;
      font-weight: 700;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .logic-card p {
      font-size: 13.5px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .ipc-flow {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      background: var(--surface-code);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
      font-family: monospace;
      color: var(--text);
    }

    .ipc-arrow {
      color: var(--accent);
      font-weight: 700;
    }

    /* FAQ */
    .faq-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }

    .faq-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px 20px;
    }

    .faq-card h3 {
      font-size: 14.5px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .faq-card p {
      font-size: 13.5px;
      color: var(--text-muted);
      line-height: 1.55;
    }

    .inline-code {
      background: var(--surface-code);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 0.88em;
      color: var(--text);
    }

    /* Lightbox */
    .lightbox {
      position: fixed;
      inset: 0;
      z-index: 100;
      background: rgba(10, 12, 16, 0.88);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .lightbox.open {
      display: flex;
    }

    .lightbox-inner {
      max-width: 1120px;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7);
    }

    .lightbox-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      font-weight: 600;
    }

    .lightbox-body {
      background: #0d1014;
      padding: 16px;
      display: flex;
      justify-content: center;
      max-height: 82vh;
      overflow: auto;
    }

    .lightbox-body img {
      max-width: 100%;
      max-height: 76vh;
      width: auto;
      height: auto;
      border-radius: 4px;
    }

    /* Footer */
    footer {
      padding: 32px 0 42px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-subtle);
    }

    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .footer-inner a {
      color: var(--text-muted);
      text-decoration: none;
    }

    .footer-inner a:hover {
      color: var(--text);
    }

    /* Responsive */
    @media (max-width: 960px) {
      .hero-grid,
      .walk-row,
      .walk-row.reverse,
      .step-columns,
      .logic-grid,
      .faq-grid {
        grid-template-columns: 1fr;
      }
      .walk-row.reverse .walk-media {
        order: 0;
      }
      .arch-pipeline {
        grid-template-columns: repeat(2, 1fr);
      }
      .nav-links {
        display: none;
      }
    }

    @media (max-width: 600px) {
      .hero-title {
        font-size: 28px;
      }
      .arch-pipeline,
      .shot-pair,
      .shot-pair.shot-pair-mixed,
      .spec-strip {
        grid-template-columns: 1fr;
      }
      .step-card {
        grid-template-columns: 1fr;
      }
      .dl-card {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="site-header">
    <div class="container header-inner">
      <a href="#download" class="brand">
        <img src="${assets.icon}" alt="Mak Download Manager">
        <span class="brand-title">Mak Download Manager</span>
        <span class="brand-version">v0.1.0 · x64</span>
      </a>

      <nav class="nav-links" aria-label="Sayfa içi gezinme">
        <a href="#download">İndir</a>
        <a href="#screenshots">Uygulama Görünümleri</a>
        <a href="#install">Kurulum Rehberi</a>
        <a href="#architecture">Çalışma Mantığı</a>
        <a href="#faq">Sorun Giderme</a>
        <a href="https://github.com/mertalikocak/mdm" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>

      <div class="header-actions">
        <button type="button" class="btn-icon" id="themeToggle" title="Tema değiştir" aria-label="Tema değiştir">
          <svg id="themeIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>
          </svg>
        </button>
        <a href="#download" class="btn-header-dl">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          İndir
        </a>
      </div>
    </div>
  </header>

  <!-- Hero & Download Hub -->
  <section id="download" class="hero-section">
    <div class="container hero-grid">
      <div>
        <div class="hero-meta">
          <span>Windows 10 / 11 (64-bit)</span>
          <span>·</span>
          <span>Tauri 2 + Rust + SQLite</span>
        </div>

        <h1 class="hero-title">Mak Download Manager</h1>
        <p class="hero-desc">
          Büyük dosyaları HTTP Range desteğiyle 16 parçaya kadar paralel indiren,
          YouTube ve medya akışlarını <code class="inline-code">yt-dlp</code> + <code class="inline-code">FFmpeg</code>
          ile birleştiren, Chrome ve Brave ile doğrudan haberleşen masaüstü indirme yöneticisi.
        </p>

        <div class="dl-stack">
          <div class="dl-card is-primary">
            <div class="dl-info">
              <div class="dl-title-row">
                <span class="dl-title">Windows Kurulum Paketi (.exe)</span>
                <span class="tag tag-blue">Önerilen</span>
                <span class="tag mono">${pkgSizes.setupExe}</span>
              </div>
              <div class="dl-sub">
                <span class="mono">Mak Download Manager_0.1.0_x64-setup.exe</span> · Kullanıcı dizinine kurulum (yönetici izni gerekmez), Native Messaging otomatik kaydedilir.
              </div>
            </div>
            <a id="dlSetup" href="https://github.com/mertalikocak/mdm/releases/latest/download/Mak.Download.Manager_0.1.0_x64-setup.exe" target="_blank" rel="noopener noreferrer" class="dl-btn primary">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Kurulumu İndir
            </a>
          </div>

          <div class="dl-card">
            <div class="dl-info">
              <div class="dl-title-row">
                <span class="dl-title">Tarayıcı Eklentisi (Chrome / Brave)</span>
                <span class="tag tag-green">Manifest V3</span>
                <span class="tag mono">${pkgSizes.extensionZip}</span>
              </div>
              <div class="dl-sub">
                <span class="mono">mdm-browser-extension-v1.0.0.zip</span> · Sağ tık yakalama, video üstü indirme butonu ve otomatik bağlantı aktarımı.
              </div>
            </div>
            <a id="dlExt" href="https://github.com/mertalikocak/mdm/releases/latest/download/mdm-browser-extension-v1.0.0.zip" target="_blank" rel="noopener noreferrer" class="dl-btn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Eklentiyi İndir
            </a>
          </div>

          <div class="dl-card">
            <div class="dl-info">
              <div class="dl-title-row">
                <span class="dl-title">Taşınabilir Sürüm (Portable ZIP)</span>
                <span class="tag">Kurulumsuz</span>
                <span class="tag mono">${pkgSizes.portableZip}</span>
              </div>
              <div class="dl-sub">
                <span class="mono">mdm-portable-v0.1.0-x64.zip</span> · <span class="mono">mdm.exe</span>, <span class="mono">mdm_host.exe</span> ve <span class="mono">browser-extension/</span> içerir; çıkartıp doğrudan çalıştırın.
              </div>
            </div>
            <a id="dlPortable" href="https://github.com/mertalikocak/mdm/releases/latest/download/mdm-portable-v0.1.0-x64.zip" target="_blank" rel="noopener noreferrer" class="dl-btn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Portable ZIP İndir
            </a>
          </div>
        </div>

        <div class="spec-strip">
          <div class="spec-item">
            <span class="spec-label">İndirme Motoru</span>
            <span class="spec-value">Rust + Tokio (1–16 Segment)</span>
          </div>
          <div class="spec-item">
            <span class="spec-label">Veri ve Ayarlar</span>
            <span class="spec-value mono">%LOCALAPPDATA%\\mdm</span>
          </div>
          <div class="spec-item">
            <span class="spec-label">Eklenti Kimliği (Sabit)</span>
            <span class="spec-value mono">pgeehhablgafglpdgcdnbpfgfcdajijb</span>
          </div>
          <div class="spec-item">
            <span class="spec-label">Gereksinim</span>
            <span class="spec-value">Windows 10/11 x64 + WebView2</span>
          </div>
        </div>
      </div>

      <!-- Interactive Real Screenshot Preview -->
      <div class="preview-box">
        <div class="preview-tabs" role="tablist" aria-label="Pencere önizlemeleri">
          <button type="button" class="preview-tab active" data-shot="dashboard">Ana Panel</button>
          <button type="button" class="preview-tab" data-shot="progress">İlerleme</button>
          <button type="button" class="preview-tab" data-shot="confirmVideo">Video</button>
          <button type="button" class="preview-tab" data-shot="confirmFile">Dosya Onayı</button>
          <button type="button" class="preview-tab" data-shot="settings">Ayarlar</button>
        </div>

        <div class="preview-stage" id="heroPreviewStage" title="Büyütmek için tıklayın">
          <img id="heroPreviewImg" src="${assets.dashboard}" alt="Mak Download Manager ana kontrol paneli">
        </div>

        <div class="preview-caption">
          <span id="heroPreviewCaption">Ana kontrol paneli — kategori filtreleri, canlı hız göstergesi ve 8 parçalı segment çubuğu</span>
          <span class="zoom-hint">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              <line x1="11" y1="8" x2="11" y2="14"></line>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
            Büyüt
          </span>
        </div>
      </div>
    </div>
  </section>

  <!-- Section 1: Real Screenshots Walkthrough -->
  <section id="screenshots">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">Gerçek Uygulama Görünümleri</span>
        <h2>Ekran Görüntüleriyle MDM Arayüzü</h2>
        <p>
          Tüm görseller uygulamanın gerçek masaüstü ve tarayıcı eklentisi ekranlarından alınmıştır.
          İncelemek istediğiniz herhangi bir görüntüye tıklayarak tam boyutta açabilirsiniz.
        </p>
      </div>

      <div class="walkthrough-list">
        <!-- Row 1: Dashboard -->
        <article class="walk-row">
          <div class="walk-text">
            <span class="walk-num">01 / ANA PENCERE</span>
            <h3>Kontrol Paneli ve Paralel Segment Görünümü</h3>
            <p>
              Tüm aktif, tamamlanan, duraklatılmış, kuyrukta bekleyen ve video indirmeleri tek bir masaüstü tablosunda yönetilir.
            </p>
            <ul class="bullet-list">
              <li><strong>Sol Kategori Menüsü:</strong> Görevleri durumuna ve medya türüne göre anlık sayaçlarla filtreler.</li>
              <li><strong>Çok Parçalı İlerleme Şeridi:</strong> Dosyanın hangi bayt dilimlerinin tamamlandığını (yeşil) ve hangilerinin indirildiğini (mavi) aynı satırda gösterir.</li>
              <li><strong>Üst Araç Çubuğu:</strong> Tek tıkla URL ekleme, tümünü devam ettirme/duraklatma, arama ve sağda canlı toplam hız göstergesi.</li>
            </ul>
          </div>
          <div class="walk-media">
            <div class="shot-frame" data-lightbox data-title="Mak Download Manager — Ana Kontrol Paneli" data-src="${assets.dashboard}">
              <img src="${assets.dashboard}" alt="MDM Ana Kontrol Paneli">
              <div class="shot-subcap">
                <span>Ana kontrol paneli (Koyu tema)</span>
                <span class="zoom-hint">Büyüt</span>
              </div>
            </div>
          </div>
        </article>

        <!-- Row 2: Compact Confirmation Dialogs -->
        <article class="walk-row reverse">
          <div class="walk-text">
            <span class="walk-num">02 / KOMPAKT YAKALAMA DİYALOĞU</span>
            <h3>Dosya İndirme Bilgisi ve Video Kalite Seçimi</h3>
            <p>
              Tarayıcıdaki bir indirme bağlantısına ya da video oynatıcının üzerindeki MDM butonuna tıklandığında,
              ana pencereyi açmadan küçük onay penceresi (<code class="inline-code">520×340</code>) belirir.
            </p>
            <ul class="bullet-list">
              <li><strong>Dosya Modu:</strong> Sunucuya <code class="inline-code">HEAD / Range</code> sorgusu atarak boyutu doğrular; 1, 2, 4, 8 veya 16 bağlantı seçimi sunar.</li>
              <li><strong>Video Modu:</strong> <code class="inline-code">yt-dlp</code> ile mevcut akışları tarar; 1080p Full HD, 720p, 480p veya yalnızca ses (<code class="inline-code">M4A</code>) seçeneklerini tahmini boyutlarıyla listeler.</li>
              <li><strong>Kuyruk Esnekliği:</strong> <em>İndirmeyi Başlat</em> ile hemen akış başlatabilir veya <em>Daha Sonra İndir</em> ile kuyruğa alabilirsiniz.</li>
            </ul>
          </div>
          <div class="walk-media">
            <div class="shot-pair">
              <div class="shot-frame" data-lightbox data-title="Dosya İndirme Bilgisi (HTTP Segmentli)" data-src="${assets.confirmFile}">
                <img src="${assets.confirmFile}" alt="Dosya indirme onay penceresi">
                <div class="shot-subcap">
                  <span>Dosya onayı (8 parça)</span>
                  <span class="zoom-hint">Büyüt</span>
                </div>
              </div>
              <div class="shot-frame" data-lightbox data-title="Video İndirme Bilgisi (YouTube / Medya Analizi)" data-src="${assets.confirmVideo}">
                <img src="${assets.confirmVideo}" alt="Video kalite seçimi penceresi">
                <div class="shot-subcap">
                  <span>Video kalite seçimi</span>
                  <span class="zoom-hint">Büyüt</span>
                </div>
              </div>
            </div>
          </div>
        </article>

        <!-- Row 3: Progress Dialog -->
        <article class="walk-row">
          <div class="walk-text">
            <span class="walk-num">03 / CANLI İZLEME &amp; HIZ SINIRLAYICI</span>
            <h3>3 Sekmeli İndirme Durumu ve Bağlantı Tablosu</h3>
            <p>
              Aktif indirme penceresi yalnızca toplam yüzdeyi değil, arka plandaki her bir iş parçacığının
              (<code class="inline-code">worker</code>) durumunu ayrı ayrı raporlar.
            </p>
            <ul class="bullet-list">
              <li><strong>İndirme Durumu:</strong> Anlık aktarım hızı, kalan süre, <code class="inline-code">Devam edebilme</code> bilgisi ve N. 1–8 arası her bağlantının diske yazdığı bayt miktarı.</li>
              <li><strong>Hız Sınırlayıcı:</strong> İndirmeyi durdurmadan küresel hız sınırı (<code class="inline-code">KB/sn</code>) belirleyerek ağ bant genişliğini korur.</li>
              <li><strong>Tamamlanma Seçenekleri:</strong> Bittiğinde pencereyi kapatma, dosyayı otomatik açma ve sesli uyarı tercihleri.</li>
            </ul>
          </div>
          <div class="walk-media">
            <div class="shot-frame" data-lightbox data-title="İndirme Durumu ve 8 Bağlantı Detayı" data-src="${assets.progress}">
              <img src="${assets.progress}" alt="Canlı indirme durumu ve bağlantı tablosu">
              <div class="shot-subcap">
                <span>560×500 indirme ilerleme penceresi</span>
                <span class="zoom-hint">Büyüt</span>
              </div>
            </div>
          </div>
        </article>

        <!-- Row 4: Settings & Browser Extension -->
        <article class="walk-row reverse">
          <div class="walk-text">
            <span class="walk-num">04 / AYARLAR VE TARAYICI ENTEGRASYONU</span>
            <h3>Ayarlar, Video Araçları ve Chrome / Brave Eklentisi</h3>
            <p>
              Tarayıcı eklentisi, masaüstü uygulamasıyla <code class="inline-code">com.mak.mdm</code> Native Messaging
              köprüsü üzerinden sürekli iletişim kurar.
            </p>
            <ul class="bullet-list">
              <li><strong>Ayarlar ve Araçlar:</strong> Varsayılan klasör, eşzamanlı görev sayısı, küresel hız sınırı, koyu/açık tema ve <code class="inline-code">yt-dlp</code> / <code class="inline-code">FFmpeg</code> durum kontrolü.</li>
              <li><strong>Eklenti Açılır Menüsü:</strong> Canlı <em>MDM Bağlandı</em> göstergesi, hızlı URL gönderme ve otomatik indirme yakalama anahtarı.</li>
              <li><strong>Video Üstü Yakalama Butonu:</strong> YouTube ve HTML5 video oynatıcılarının sağ üst dış kenarına yapışarak duraklatılmış videoyu oynatmadan doğrudan analiz başlatır.</li>
            </ul>
            <div class="grabber-demo-wrap">
              <div style="font-size: 11.5px; color: var(--text-subtle); margin-bottom: 18px;">
                Sayfa içi video oynatıcı üzerinde görünen yakalama paneli (<span class="mono">content.css</span>):
              </div>
              <div class="grabber-demo-player">
                <div class="mdm-grabber-mock">
                  <span class="mdm-grabber-play">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </span>
                  <span>MDM ile Video İndir</span>
                  <span class="mdm-grabber-badge">1080P</span>
                </div>
                HTML5 Video Oynatıcı Alanı
              </div>
            </div>
          </div>
          <div class="walk-media">
            <div class="shot-pair shot-pair-mixed">
              <div class="shot-frame" data-lightbox data-title="Ayarlar ve Video Araçları (yt-dlp & FFmpeg)" data-src="${assets.settings}">
                <img src="${assets.settings}" alt="Ayarlar ve araçlar penceresi">
                <div class="shot-subcap">
                  <span>Ayarlar ve araçlar</span>
                  <span class="zoom-hint">Büyüt</span>
                </div>
              </div>
              <div class="shot-frame" data-lightbox data-title="Chrome / Brave Eklentisi (MDM Bağlandı)" data-src="${assets.extensionPopup}">
                <img src="${assets.extensionPopup}" alt="Tarayıcı eklentisi popup penceresi">
                <div class="shot-subcap">
                  <span>Tarayıcı eklentisi</span>
                  <span class="zoom-hint">Büyüt</span>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>

  <!-- Section 2: Step-by-step Installation Guide -->
  <section id="install">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">Kurulum Rehberi</span>
        <h2>3 Adımda Kurulum ve Tarayıcı Bağlantısı</h2>
        <p>
          Uygulama kullanıcı düzeyinde kurulur; Windows yönetici şifresi gerektirmez ve mevcut Chrome/Brave profillerinize güvenle bağlanır.
        </p>
      </div>

      <div class="steps-grid">
        <!-- Step 1 -->
        <div class="step-card">
          <div class="step-badge">01</div>
          <div class="step-body">
            <h3>Masaüstü Uygulamasını Kurun (veya Taşınabilir Sürümü Açın)</h3>
            <p>
              İhtiyacınıza göre kurulum sihirbazını çalıştırın ya da kurulum gerektirmeyen taşınabilir klasörü kullanın.
            </p>
            <div class="step-columns">
              <div class="sub-panel">
                <h4>Seçenek A — Kurulum Sihirbazı (Önerilen)</h4>
                <ol>
                  <li><code class="inline-code">Mak Download Manager_0.1.0_x64-setup.exe</code> dosyasını çalıştırın.</li>
                  <li>Sihirbaz uygulamayı kullanıcı dizininize kurar, Masaüstü ve Başlat Menüsü kısayollarını oluşturur.</li>
                  <li>Chrome, Brave ve Edge için <strong>Native Messaging Host</strong> (<code class="inline-code">com.mak.mdm</code>) otomatik kaydedilir.</li>
                </ol>
                <div class="copy-row">
                  <code>%LOCALAPPDATA%\\Programs\\Mak Download Manager</code>
                  <button type="button" class="btn-copy" data-copy="%LOCALAPPDATA%\\Programs\\Mak Download Manager">Kopyala</button>
                </div>
              </div>
              <div class="sub-panel">
                <h4>Seçenek B — Taşınabilir (Portable) Mod</h4>
                <ol>
                  <li><code class="inline-code">mdm-portable-v0.1.0-x64.zip</code> arşivini dilediğiniz bir klasöre çıkartın.</li>
                  <li>Doğrudan <code class="inline-code">mdm.exe</code> dosyasını çalıştırın; ilk açılışta kendi klasöründeki <code class="inline-code">mdm_host.exe</code> ile tarayıcı kaydını otomatik kurar.</li>
                  <li>İsterseniz <code class="inline-code">register_host.bat</code> ile kaydı manuel de yenileyebilirsiniz.</li>
                </ol>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 2 -->
        <div class="step-card">
          <div class="step-badge">02</div>
          <div class="step-body">
            <h3>Chrome ve Brave Tarayıcı Eklentisini Yükleyin</h3>
            <p>
              Eklenti paketinin içinde sabit RSA açık anahtar (<code class="inline-code">manifest.json &gt; key</code>) bulunduğundan,
              paketlenmemiş olarak yüklendiğinde her bilgisayarda aynı kimliği (<code class="inline-code">pgeehhablgafglpdgcdnbpfgfcdajijb</code>) alır
              ve masaüstü köprüsüyle ek bir ayar yapmadan eşleşir.
            </p>

            <div class="step-columns">
              <div class="sub-panel">
                <h4>1. Eklenti Klasörünü Hazırlayın</h4>
                <p>
                  <code class="inline-code">mdm-browser-extension-v1.0.0.zip</code> arşivini bir klasöre çıkartın
                  ya da kurulum sihirbazının hazır çıkarttığı klasör yolunu kopyalayın:
                </p>
                <div class="copy-row">
                  <code>%LOCALAPPDATA%\\Programs\\Mak Download Manager\\resources\\browser-extension</code>
                  <button type="button" class="btn-copy" data-copy="%LOCALAPPDATA%\\Programs\\Mak Download Manager\\resources\\browser-extension">Kopyala</button>
                </div>
              </div>

              <div class="sub-panel">
                <h4>2. Uzantılar Sayfasını Açın</h4>
                <p>Tarayıcınızın adres çubuğuna aşağıdakilerden birini yapıştırın:</p>
                <div class="copy-row">
                  <code>chrome://extensions</code>
                  <button type="button" class="btn-copy" data-copy="chrome://extensions">Kopyala</button>
                </div>
                <div class="copy-row">
                  <code>brave://extensions</code>
                  <button type="button" class="btn-copy" data-copy="brave://extensions">Kopyala</button>
                </div>
              </div>
            </div>

            <!-- Clean Annotated Diagram of Chrome/Brave Extensions UI -->
            <div class="ext-diagram" aria-label="Chrome ve Brave uzantı yükleme adımları şeması">
              <div class="ext-diag-bar">
                <span class="ext-diag-url">chrome://extensions &nbsp;/&nbsp; brave://extensions</span>
                <span class="ext-diag-dev">
                  <span>3. Sağ üstten &ldquo;Geliştirici modu&rdquo;nu açın</span>
                  <span class="switch-pill" aria-hidden="true"></span>
                </span>
              </div>
              <div class="ext-diag-body">
                <div class="ext-diag-toolbar">
                  <span class="ext-diag-btn">4. Paketlenmemiş öğe yükle (Load unpacked) &rarr; browser-extension klasörünü seçin</span>
                </div>
                <div class="ext-diag-card">
                  <div>
                    <div style="font-weight: 700; font-size: 13.5px;">Mak Download Manager (MDM) Entegrasyonu <span style="font-weight: 500; color: var(--text-subtle);">1.0.0</span></div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                      Kimlik (ID): <code class="inline-code">pgeehhablgafglpdgcdnbpfgfcdajijb</code>
                    </div>
                  </div>
                  <span class="tag tag-green">5. Eklenti simgesinde &ldquo;MDM Bağlandı&rdquo;</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 3 -->
        <div class="step-card">
          <div class="step-badge">03</div>
          <div class="step-body">
            <h3>Video İndirme Araçlarını (yt-dlp ve FFmpeg) Doğrulayın</h3>
            <p>
              YouTube, Vimeo veya akış tabanlı videoları yüksek çözünürlükte indirebilmek için MDM harici
              <code class="inline-code">yt-dlp.exe</code> ve <code class="inline-code">ffmpeg.exe</code> ikililerini izole bir klasörde kullanır.
            </p>
            <ol class="bullet-list">
              <li><strong>Tek Tıkla Güncelleme:</strong> MDM içinden <em>Ayarlar &rarr; Video Araçları &rarr; yt-dlp İndir / Güncelle</em> butonuna basın.</li>
              <li><strong>Araç Dizini:</strong> Araçlar <code class="inline-code">%LOCALAPPDATA%\\mdm\\bin</code> konumunda saklanır; <code class="inline-code">ffmpeg.exe</code> ve <code class="inline-code">ffprobe.exe</code> burada olduğunda 1080p+ görüntü ve ses otomatik birleştirilir.</li>
            </ol>
            <div class="copy-row">
              <code>%LOCALAPPDATA%\\mdm\\bin</code>
              <button type="button" class="btn-copy" data-copy="%LOCALAPPDATA%\\mdm\\bin">Kopyala</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Section 3: Architecture & How It Works -->
  <section id="architecture">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">Genel Mantık ve Teknik Mimari</span>
        <h2>MDM Arka Planda Nasıl Çalışır?</h2>
        <p>
          Arayüz katmanı (<code class="inline-code">React + Tauri IPC</code>) yalnızca sunumdan sorumludur; tüm ağ akışı,
          parçalama, disk I/O ve kurtarma mantığı Rust çekirdeğinde çalışır.
        </p>
      </div>

      <!-- 4-Stage Pipeline -->
      <div class="arch-pipeline">
        <div class="pipe-node">
          <div class="pipe-head">
            <span>AŞAMA 1</span>
            <span>HTTP Probe</span>
          </div>
          <h3>Sonda ve Doğrulama</h3>
          <p>
            <code class="inline-code">HEAD</code> (desteklenmezse <code class="inline-code">GET Range: bytes=0-0</code>) ile dosya boyutunu,
            <code class="inline-code">HTTP 206 Partial Content</code> desteğini ve gerçek dosya adını çıkarır. Destek yoksa güvenli tek akışa düşer.
          </p>
          <div class="pipe-file">engine/probe.rs</div>
        </div>

        <div class="pipe-node">
          <div class="pipe-head">
            <span>AŞAMA 2</span>
            <span>Planner</span>
          </div>
          <h3>Bayt Aralığı Planlama</h3>
          <p>
            Dosya boyutunu seçilen bağlantı sayısına (1, 2, 4, 8 veya 16) göre çakışmasız
            <code class="inline-code">[start_byte..end_byte]</code> dilimlerine böler.
          </p>
          <div class="pipe-file">engine/planner.rs</div>
        </div>

        <div class="pipe-node">
          <div class="pipe-head">
            <span>AŞAMA 3</span>
            <span>Tokio Workers</span>
          </div>
          <h3>Doğrudan Diske Akış</h3>
          <p>
            Her parça kendi <code class="inline-code">Range</code> isteğiyle <code class="inline-code">bytes_stream()</code>
            üzerinden doğrudan <code class="inline-code">.part&lt;index&gt;</code> dosyasına yazar; bellekte tamponlama yapılmaz.
          </p>
          <div class="pipe-file">engine/worker.rs</div>
        </div>

        <div class="pipe-node">
          <div class="pipe-head">
            <span>AŞAMA 4</span>
            <span>Atomic Finalizer</span>
          </div>
          <h3>Sıralı Birleştirme</h3>
          <p>
            Tüm parçalar doğrulandığında geçici <code class="inline-code">.mdmmerge</code> dosyasında sırayla birleştirilir ve
            çakışma kontrolünden sonra atomik olarak hedef ada taşınır.
          </p>
          <div class="pipe-file">engine/worker.rs &amp; manager.rs</div>
        </div>
      </div>

      <!-- 4 Detailed Mechanism Cards -->
      <div class="logic-grid">
        <div class="logic-card">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
            </svg>
            Sıfır Bellek Şişmesi ve SQLite WAL Kurtarma
          </h3>
          <p>
            Çok gigabaytlık ISO veya arşiv dosyaları indirilirken veri RAM'de biriktirilmez; gelen TCP paketleri
            <code class="inline-code">tokio::io::AsyncWriteExt</code> ile doğrudan diske yazılır. Görev durumu, parça ofsetleri
            ve ayarlar <code class="inline-code">%LOCALAPPDATA%\\mdm</code> içindeki WAL modlu SQLite veritabanında tutulur.
            İndirmeyi duraklattığınızda veya uygulama kapandığında parçalar kaldığı bayt konumundan devam eder.
          </p>
          <div class="ipc-flow">
            <span>bytes_stream()</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>.part0..N (Disk)</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>SQLite WAL Offset</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>.mdmmerge &rarr; Hedef</span>
          </div>
        </div>

        <div class="logic-card">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            Tarayıcı – Masaüstü Köprüsü (Native Messaging &amp; IPC)
          </h3>
          <p>
            Eklenti; tarayıcıdan yakaladığı bağlantıyı, gerekiyorsa ilgili sitenin çerezlerini (<code class="inline-code">Cookie</code>),
            <code class="inline-code">Referer</code> ve <code class="inline-code">User-Agent</code> bilgisini yalnızca o indirme görevi için
            <code class="inline-code">mdm_host.exe</code> üzerinden masaüstüne aktarır. Uygulama kapalıysa istek
            <code class="inline-code">pending_confirm.json</code> dosyasına yazılır ve MDM otomatik başlatılır.
          </p>
          <div class="ipc-flow">
            <span>Chrome / Brave</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>mdm_host.exe (stdio)</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>127.0.0.1:47990 / Pipe</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>mdm.exe</span>
          </div>
        </div>

        <div class="logic-card">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2"></rect>
            </svg>
            DASH Video ve Ses Akışı Birleştirme
          </h3>
          <p>
            1080p ve üzeri YouTube videolarında görüntü ve ses ayrı akışlar (DASH) olarak sunulur.
            MDM ön analizde gerçek akış boyutlarını hesaplar; indirme sırasında önce video sonra ses akışını
            kümülatif ilerleme ve 3 saniyelik EMA hız/ETA yumuşatma ile takip eder, ardından <code class="inline-code">FFmpeg</code> ile tek bir <code class="inline-code">.mp4</code> dosyasında birleştirir.
          </p>
          <div class="ipc-flow">
            <span>yt-dlp --dump-json</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>Video + Ses Akışları</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>FFmpeg Mux</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>video.mp4</span>
          </div>
        </div>

        <div class="logic-card">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
            Veri Güvenliği ve Çakışma Koruması
          </h3>
          <p>
            İndirme klasöründe aynı ada sahip bir dosya varsa MDM asla üzerine yazmaz; otomatik olarak
            <code class="inline-code">dosya_1.zip</code>, <code class="inline-code">dosya_2.zip</code> biçiminde yeni ad üretir.
            İptal edilen veya silinen görevlerde geçici <code class="inline-code">.part</code> ve <code class="inline-code">.mdmpart</code> artıkları temizlenir.
            Tüm arayüz bildirimleri 600ms aralıklarla gruplanarak yüksek hızlarda UI donmalarını önler.
          </p>
          <div class="ipc-flow">
            <span>Aynı Ad Kontrolü</span>
            <span class="ipc-arrow">&rarr;</span>
            <span>dosya_1.ext</span>
            <span class="ipc-arrow">·</span>
            <span>600ms Olay Limiti</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Section 4: FAQ & Troubleshooting -->
  <section id="faq">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">Sorun Giderme ve SSS</span>
        <h2>Sıkça Sorulan Sorular</h2>
        <p>Kurulum ve günlük kullanım sırasında karşılaşabileceğiniz durumlar ve net çözümleri.</p>
      </div>

      <div class="faq-grid">
        <div class="faq-card">
          <h3>Eklenti simgesine tıkladığımda &ldquo;Bağlantı Yok&rdquo; yazıyor.</h3>
          <p>
            Tarayıcı Native Messaging Host kaydını bulamamış olabilir. MDM uygulamasını bir kez açın veya
            komut satırından <code class="inline-code">mdm.exe --register-host</code> çalıştırın
            (Taşınabilir sürümde <code class="inline-code">register_host.bat</code> dosyasını çalıştırabilirsiniz).
            Ardından <code class="inline-code">%LOCALAPPDATA%\\mdm\\com.mak.mdm.json</code> dosyasının oluştuğunu kontrol edin.
          </p>
        </div>

        <div class="faq-card">
          <h3>Eklentiyi yükledim/güncelledim ama YouTube'da buton görünmüyor.</h3>
          <p>
            <code class="inline-code">chrome://extensions</code> veya <code class="inline-code">brave://extensions</code> sayfasında
            MDM kartındaki <strong>Yenile</strong> simgesine tıklayın ve açık olan YouTube sekmesini <kbd>F5</kbd> ile yenileyin.
            Video oynatıcısı duraklatılmış olsa bile buton sağ üst dış kenarda görünür ve tıkladığınızda videoyu oynatmadan analizi başlatır.
          </p>
        </div>

        <div class="faq-card">
          <h3>Windows SmartScreen uyarısı çıkarsa ne yapmalıyım?</h3>
          <p>
            Bireysel dağıtım paketleri henüz ticari EV kod imzalama sertifikası içermediğinden Windows Defender SmartScreen uyarı gösterebilir.
            <em>Ek bilgi &rarr; Yine de çalıştır</em> seçeneğiyle kurabilir veya kaynak koddan
            <code class="inline-code">cargo build --release</code> ile kendiniz derleyebilirsiniz.
          </p>
        </div>

        <div class="faq-card">
          <h3>Uygulamayı kaldırdığımda indirdiğim dosyalar silinir mi?</h3>
          <p>
            Hayır. Windows <em>Ayarlar &gt; Uygulamalar</em> üzerinden kaldırma işlemi yalnızca program dosyalarını ve
            Native Messaging kayıt defteri anahtarlarını kaldırır. İndirdiğiniz tüm dosyalar ve
            <code class="inline-code">%LOCALAPPDATA%\\mdm</code> geçmişiniz korunur.
          </p>
        </div>

        <div class="faq-card">
          <h3>Her sitede 16 parça paralel indirme çalışır mı?</h3>
          <p>
            Yalnızca sunucunun <code class="inline-code">Accept-Ranges: bytes</code> ve <code class="inline-code">HTTP 206</code>
            desteği verdiği bağlantılarda paralel parçalama uygulanır. Sunucu tek akışa izin veriyorsa MDM bunu ön sondada tespit eder ve
            hata vermeden tek parça indirmeye geçer.
          </p>
        </div>

        <div class="faq-card">
          <h3>Neden bazı video akışlarında &ldquo;blob:&rdquo; uyarısı görünüyor?</h3>
          <p>
            <code class="inline-code">blob:</code> ve <code class="inline-code">data:</code> adresleri tarayıcı sekmesinin belleğine özgüdür.
            YouTube, Vimeo ve TikTok gibi platformlarda eklenti sayfanın gerçek adresini alarak analizi
            <code class="inline-code">yt-dlp</code> motoruna yönlendirir; ham bellek nesneleri ise güvenlik gereği dışarı aktarılmaz.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer>
    <div class="container footer-inner">
      <div>
        <strong>Mak Download Manager (MDM) v0.1.0</strong> · Tauri 2 · Rust · Tokio · Rusqlite WAL · React 18
      </div>
      <div style="display: flex; gap: 16px;">
        <span>Geliştirici: Mert Ali</span>
        <a href="https://github.com/mertalikocak/mdm/releases" target="_blank" rel="noopener noreferrer">Sürümler (GitHub)</a>
        <a href="#download">Yukarı Çık</a>
      </div>
    </div>
  </footer>

  <!-- Lightbox Modal -->
  <div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-labelledby="lightboxTitle">
    <div class="lightbox-inner">
      <div class="lightbox-bar">
        <span id="lightboxTitle">Önizleme</span>
        <button type="button" class="btn-icon" id="lightboxClose" aria-label="Kapat" style="width: 28px; height: 28px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="lightbox-body">
        <img id="lightboxImg" src="" alt="">
      </div>
    </div>
  </div>

  <script>
    // GitHub Releases resmi doğrudan indirme linkleri:
    const DRIVE_CONFIG = {
      setupExe: "https://github.com/mertalikocak/mdm/releases/latest/download/Mak.Download.Manager_0.1.0_x64-setup.exe",
      extensionZip: "https://github.com/mertalikocak/mdm/releases/latest/download/mdm-browser-extension-v1.0.0.zip",
      portableZip: "https://github.com/mertalikocak/mdm/releases/latest/download/mdm-portable-v0.1.0-x64.zip"
    };

    const SHOTS = {
      dashboard: {
        src: "${assets.dashboard}",
        title: "Mak Download Manager — Ana Kontrol Paneli",
        caption: "Ana kontrol paneli — kategori filtreleri, canlı hız göstergesi ve 8 parçalı segment çubuğu"
      },
      progress: {
        src: "${assets.progress}",
        title: "İndirme Durumu ve 8 Bağlantı İlerleme Tablosu",
        caption: "3 sekmeli indirme durumu penceresi — canlı hız, devam edebilme ve parça bazlı bayt dökümü"
      },
      confirmVideo: {
        src: "${assets.confirmVideo}",
        title: "Dosya İndirme Bilgisi — Video Kalite Seçimi",
        caption: "YouTube / video yakalandığında açılan 520×340 kalite ve format seçimi penceresi"
      },
      confirmFile: {
        src: "${assets.confirmFile}",
        title: "Dosya İndirme Bilgisi — HTTP Segment Onayı",
        caption: "Tarayıcıdan yakalanan doğrudan dosya indirmelerinde parça sayısı ve klasör onayı"
      },
      settings: {
        src: "${assets.settings}",
        title: "Ayarlar ve Video Araçları (yt-dlp & FFmpeg)",
        caption: "Eşzamanlı görev limiti, hız sınırı, tema seçimi ve yt-dlp / FFmpeg durum kontrolü"
      }
    };

    (function initDownloads() {
      const lowerPath = window.location.pathname.toLowerCase();
      const isRootShowcase =
        window.location.protocol === "file:" &&
        lowerPath.endsWith("/mdm_tanitim.html") &&
        !lowerPath.includes("/drive-yuklenecekler/");
      const basePrefix = isRootShowcase ? "./drive-yuklenecekler/" : "./";

      const setupEl = document.getElementById("dlSetup");
      const extEl = document.getElementById("dlExt");
      const portEl = document.getElementById("dlPortable");

      if (DRIVE_CONFIG.setupExe) {
        setupEl.href = DRIVE_CONFIG.setupExe;
        setupEl.target = "_blank";
        setupEl.rel = "noopener noreferrer";
        setupEl.removeAttribute("download");
      } else {
        setupEl.href = basePrefix + encodeURI("Mak Download Manager_0.1.0_x64-setup.exe");
      }

      if (DRIVE_CONFIG.extensionZip) {
        extEl.href = DRIVE_CONFIG.extensionZip;
        extEl.target = "_blank";
        extEl.rel = "noopener noreferrer";
        extEl.removeAttribute("download");
      } else {
        extEl.href = basePrefix + "mdm-browser-extension-v1.0.0.zip";
      }

      if (DRIVE_CONFIG.portableZip) {
        portEl.href = DRIVE_CONFIG.portableZip;
        portEl.target = "_blank";
        portEl.rel = "noopener noreferrer";
        portEl.removeAttribute("download");
      } else {
        portEl.href = basePrefix + "mdm-portable-v0.1.0-x64.zip";
      }
    })();

    (function initThemeToggle() {
      const btn = document.getElementById("themeToggle");
      const root = document.documentElement;
      const icon = document.getElementById("themeIcon");

      function renderIcon() {
        const isDark = root.classList.contains("dark");
        icon.innerHTML = isDark
          ? '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>'
          : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
      }

      btn.addEventListener("click", function () {
        root.classList.toggle("dark");
        renderIcon();
      });
      renderIcon();
    })();

    (function initHeroTabs() {
      const tabs = document.querySelectorAll(".preview-tab");
      const img = document.getElementById("heroPreviewImg");
      const caption = document.getElementById("heroPreviewCaption");
      const stage = document.getElementById("heroPreviewStage");
      let currentKey = "dashboard";

      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          const key = tab.getAttribute("data-shot");
          const item = SHOTS[key];
          if (!item) return;
          currentKey = key;
          tabs.forEach(function (t) { t.classList.remove("active"); });
          tab.classList.add("active");
          img.src = item.src;
          img.alt = item.title;
          caption.textContent = item.caption;
        });
      });

      stage.addEventListener("click", function () {
        const item = SHOTS[currentKey];
        if (item) openLightbox(item.src, item.title);
      });
    })();

    function openLightbox(src, title) {
      const lb = document.getElementById("lightbox");
      const lbImg = document.getElementById("lightboxImg");
      const lbTitle = document.getElementById("lightboxTitle");
      lbImg.src = src;
      lbImg.alt = title || "Önizleme";
      lbTitle.textContent = title || "Önizleme";
      lb.classList.add("open");
    }

    function closeLightbox() {
      document.getElementById("lightbox").classList.remove("open");
    }

    (function initLightboxAndCopy() {
      document.querySelectorAll("[data-lightbox]").forEach(function (el) {
        el.addEventListener("click", function () {
          openLightbox(el.getAttribute("data-src"), el.getAttribute("data-title"));
        });
      });

      document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
      document.getElementById("lightbox").addEventListener("click", function (e) {
        if (e.target === this) closeLightbox();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeLightbox();
      });

      document.querySelectorAll("[data-copy]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const text = btn.getAttribute("data-copy");
          if (!text) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              const prev = btn.textContent;
              btn.textContent = "Kopyalandı";
              btn.classList.add("copied");
              setTimeout(function () {
                btn.textContent = prev;
                btn.classList.remove("copied");
              }, 1600);
            });
          }
        });
      });
    })();
  </script>
</body>
</html>
`;

const rootOut = path.join(rootDir, "mdm_tanitim.html");
const distOut = path.join(distDir, "index.html");
const driveOut = path.join(driveDir, "mdm_tanitim.html");

fs.mkdirSync(driveDir, { recursive: true });
fs.writeFileSync(rootOut, html, "utf8");
fs.writeFileSync(distOut, html, "utf8");
fs.writeFileSync(driveOut, html, "utf8");

console.log(`[OK] ${rootOut} (${Math.round(Buffer.byteLength(html, "utf8") / 1024)} KB)`);
console.log(`[OK] ${distOut} (${Math.round(Buffer.byteLength(html, "utf8") / 1024)} KB)`);
console.log(`[OK] ${driveOut} (${Math.round(Buffer.byteLength(html, "utf8") / 1024)} KB)`);
