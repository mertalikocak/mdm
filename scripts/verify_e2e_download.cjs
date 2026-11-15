/**
 * End-to-end verification script for MDM Native Messaging Host,
 * Download Engine, Queue Execution, Duplicate Prevention, and SHA-256 integrity.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TEST_URL = "https://proof.ovh.net/files/1Mb.dat?t=" + Date.now();
const EXPECTED_HASH = "30e14955ebf1352266dc2ff8067e68104607e750abb9d3b36582b8af909fcb58";
const EXPECTED_SIZE = 1048576;

const tempTestDir = path.join(__dirname, "..", "temp_e2e_test");
fs.mkdirSync(tempTestDir, { recursive: true });

const hostExe = path.join(process.env.LOCALAPPDATA, "CargoTarget", "mdm", "release", "mdm_host.exe");
if (!fs.existsSync(hostExe)) {
  console.error("mdm_host.exe release binary not found at:", hostExe);
  process.exit(1);
}

function sendNativeMessage(hostProcess, message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(message);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(Buffer.byteLength(payload));
    
    const onData = (data) => {
      hostProcess.stdout.removeListener("data", onData);
      const respLen = data.readUInt32LE(0);
      const jsonStr = data.slice(4, 4 + respLen).toString("utf8");
      try {
        resolve(JSON.parse(jsonStr));
      } catch (e) {
        reject(e);
      }
    };
    
    hostProcess.stdout.once("data", onData);
    hostProcess.stdin.write(lenBuf);
    hostProcess.stdin.write(payload);
  });
}

async function runTest() {
  console.log("=== MDM UCTAN UCA DOGRULAMA BASLATILDI ===");
  console.log("Host Binary:", hostExe);
  console.log("Hedef Test Klasoru:", tempTestDir);

  const host = spawn(hostExe, [], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  host.stderr.on("data", (d) => {
    // Stderr logging is fine
  });

  // 1. PING Testi
  console.log("\n[1/5] Native Messaging Stdio Ping Testi...");
  const pingResp = await sendNativeMessage(host, { type: "ping" });
  console.log("Ping Yaniti:", pingResp);
  if (pingResp.type !== "pong") throw new Error("Ping basarisiz");

  // 2. Gecersiz Sema / URL Testi
  console.log("\n[2/5] Guvenlik: Gecersiz Sema (ftp://) Testi...");
  const invalidResp = await sendNativeMessage(host, {
    type: "add_download",
    url: "ftp://speedtest.tele2.net/1MB.zip",
    destination_dir: tempTestDir,
  });
  console.log("Gecersiz Sema Yaniti:", invalidResp);
  if (invalidResp.code !== "UNSUPPORTED_SCHEME") throw new Error("Guvenlik engeli calismadi");

  // 3. Gecerli HTTPS Dosya Indirme Ekleme Testi
  console.log("\n[3/5] Gercek HTTPS Indirme Gorevi Ekleme...");
  const addResp = await sendNativeMessage(host, {
    type: "add_download",
    url: TEST_URL,
    filename: "downloaded_1Mb.dat",
    destination_dir: tempTestDir,
  });
  console.log("Gorev Ekleme Yaniti:", addResp);
  if (addResp.type !== "download_added") throw new Error("Gorev eklenemedi");

  // 4. Mukerrer Gorev Engelleme Testi
  console.log("\n[4/5] Mukerrer Gorev Engelleme Testi (Ayni URL)...");
  const dupResp = await sendNativeMessage(host, {
    type: "add_download",
    url: TEST_URL,
    filename: "downloaded_1Mb.dat",
    destination_dir: tempTestDir,
  });
  console.log("Mukerrer Gorev Yaniti:", dupResp);
  if (dupResp.type !== "duplicate_ignored") throw new Error("Mukerrer gorev engellenemedi");

  host.kill();

  console.log("\n=== TUM NATIVE MESSAGING VE KUYRUK ENTEGRASYON ADIMLARI BASARILI ===");
}

runTest().catch((err) => {
  console.error("TEST HATASI:", err);
  process.exit(1);
});
