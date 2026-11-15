document.addEventListener("DOMContentLoaded", async () => {
  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const btnOpenApp = document.getElementById("btnOpenApp");
  const inputUrl = document.getElementById("inputUrl");
  const btnSendDownload = document.getElementById("btnSendDownload");
  const messageBox = document.getElementById("messageBox");
  const toggleIntercept = document.getElementById("toggleIntercept");

  // Load saved settings (default enabled)
  chrome.storage.local.get(["interceptDownloads"], (result) => {
    toggleIntercept.checked = result.interceptDownloads !== false;
  });

  toggleIntercept.addEventListener("change", () => {
    chrome.storage.local.set({ interceptDownloads: toggleIntercept.checked });
  });

  // Check connection to Native Messaging Host
  async function checkConnection() {
    statusBadge.className = "status-badge connecting";
    statusText.textContent = "Bağlanıyor...";

    chrome.runtime.sendMessage({ type: "ping" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        statusBadge.className = "status-badge disconnected";
        statusText.textContent = "Bağlantı Yok";
      } else if (response.data && response.data.type === "pong") {
        statusBadge.className = "status-badge connected";
        statusText.textContent = "MDM Bağlandı";
      } else {
        statusBadge.className = "status-badge disconnected";
        statusText.textContent = "Hata";
      }
    });
  }

  checkConnection();

  // Open MDM application
  btnOpenApp.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open_mdm_app" }, (response) => {
      if (response && response.success) {
        showMessage("MDM masaüstü uygulaması açılıyor...", "success");
      } else {
        showMessage("MDM uygulaması başlatılamadı.", "error");
      }
    });
  });

  // Send quick download
  btnSendDownload.addEventListener("click", async () => {
    const rawUrl = inputUrl.value.trim();
    if (!rawUrl) {
      showMessage("Lütfen bir indirme adresi girin.", "error");
      return;
    }

    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
      showMessage("Yalnızca HTTP ve HTTPS adresleri desteklenir.", "error");
      return;
    }

    btnSendDownload.disabled = true;
    btnSendDownload.textContent = "...";

    chrome.runtime.sendMessage(
      {
        type: "add_download",
        url: rawUrl,
        filename: null,
        destination_dir: null,
        referrer: null,
        cookies: null,
        user_agent: navigator.userAgent,
      },
      (response) => {
        btnSendDownload.disabled = false;
        btnSendDownload.textContent = "İndir";

        if (response && response.success && response.data) {
          if (response.data.type === "download_added") {
            const msg =
              response.data.status === "dialog_opened"
                ? `Onay penceresi açıldı: ${response.data.filename}`
                : `İndirme kuyruğa eklendi: ${response.data.filename}`;
            showMessage(msg, "success");
            inputUrl.value = "";
          } else if (response.data.type === "duplicate_ignored") {
            showMessage(response.data.message, "error");
          } else if (response.data.type === "error") {
            showMessage(response.data.message, "error");
          }
        } else {
          showMessage(
            response?.error || "MDM Native Host ile bağlantı kurulamadı.",
            "error"
          );
        }
      }
    );
  });

  function showMessage(text, type) {
    messageBox.textContent = text;
    messageBox.className = `message-box ${type}`;
    setTimeout(() => {
      messageBox.className = "message-box hidden";
    }, 4000);
  }
});
