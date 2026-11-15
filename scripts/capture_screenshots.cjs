/**
 * Captures real high-DPI screenshots of MDM's React UI (?shot=...) and
 * browser extension popup into docs/screenshots/ using headless Chrome.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const extDir = path.join(rootDir, "browser-extension");
const outDir = path.join(rootDir, "docs", "screenshots");

const chromeCandidates = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
].filter(Boolean);

const browserExe = chromeCandidates.find((p) => fs.existsSync(p));
if (!browserExe) {
  console.error("Chrome/Edge/Brave bulunamadi.");
  process.exit(1);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const CHROME_MOCK_SCRIPT = `<script>
window.chrome = {
  storage: {
    local: {
      get: function(keys, cb) { cb({ interceptDownloads: true }); },
      set: function(obj, cb) { if (cb) cb(); }
    }
  },
  runtime: {
    lastError: null,
    sendMessage: function(msg, cb) {
      if (!cb) return;
      if (msg && msg.type === "ping") {
        cb({ success: true, data: { type: "pong" } });
      } else {
        cb({ success: true, data: {} });
      }
    }
  }
};
</script>`;

function createStaticServer() {
  return http.createServer((req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname.startsWith("/extension/")) {
      const rel = pathname.replace(/^\/extension\//, "");
      const filePath = path.join(extDir, rel);
      if (!filePath.startsWith(extDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      if (rel === "popup.html") {
        let html = fs.readFileSync(filePath, "utf8");
        html = html.replace('<script src="popup.js"></script>', `${CHROME_MOCK_SCRIPT}\n  <script src="popup.js"></script>`);
        res.end(html);
        return;
      }
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (pathname === "/") pathname = "/index.html";
    let filePath = path.join(distDir, pathname.replace(/^\//, ""));
    if (!filePath.startsWith(distDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function captureShot(url, outFile, width, height, profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profileDir}`,
    "--force-device-scale-factor=2",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=1500",
    `--screenshot=${outFile}`,
    url,
  ];
  await execFileAsync(browserExe, args, { timeout: 25000 });
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.error("dist/index.html bulunamadi. Once 'npm run build' calistirin.");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdm-shots-"));
  const server = createStaticServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const shots = [
    { name: "dashboard.png", url: `${baseUrl}/?shot=dashboard`, width: 1150, height: 740 },
    { name: "confirm-video.png", url: `${baseUrl}/?shot=confirm-video`, width: 520, height: 340 },
    { name: "confirm-file.png", url: `${baseUrl}/?shot=confirm-file`, width: 520, height: 340 },
    { name: "progress.png", url: `${baseUrl}/?shot=progress`, width: 560, height: 500 },
    { name: "settings.png", url: `${baseUrl}/?shot=settings`, width: 900, height: 680 },
    { name: "extension-popup.png", url: `${baseUrl}/extension/popup.html`, width: 360, height: 470 },
  ];

  try {
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const target = path.join(outDir, s.name);
      await captureShot(s.url, target, s.width, s.height, path.join(profileDir, `p${i}`));
      const sizeKb = Math.round(fs.statSync(target).size / 1024);
      console.log(`[OK] ${s.name} (${s.width}x${s.height} @2x) -> ${sizeKb} KB`);
    }
  } finally {
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
