/**
 * Mak Download Manager (MDM) - Chrome & Brave Background Service Worker
 * Manages Native Messaging communication, context menus, and download interception.
 */

const NATIVE_HOST = "com.mak.mdm";

// Send message to MDM Native Messaging Host
function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message || "Bilinmeyen hata";
          console.warn("[MDM Extension] Native messaging error:", err);
          reject(new Error(err));
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Persistent sniffer: captures live video media streams across service worker sleeps (IDM Style)
const storage = chrome.storage?.session || chrome.storage?.local;

async function getCapturedMediaForTab(tabId) {
  if (!tabId || tabId < 0) return [];
  try {
    const key = `tab_media_${tabId}`;
    const res = await storage.get([key]);
    return res[key] || [];
  } catch {
    return [];
  }
}

async function addCapturedMediaForTab(tabId, url, type, initiator = null) {
  if (!tabId || tabId < 0 || !url) return;
  try {
    const key = `tab_media_${tabId}`;
    const res = await storage.get([key]);
    let list = res[key] || [];
    const existing = list.find((item) => item.url === url);
    if (!existing) {
      list.unshift({ url, timestamp: Date.now(), type, initiator: initiator || null });
      if (list.length > 30) list = list.slice(0, 30);
      await storage.set({ [key]: list });
    } else {
      existing.timestamp = Date.now();
      if (initiator && !existing.initiator) {
        existing.initiator = initiator;
      }
      await storage.set({ [key]: list });
    }
  } catch (e) {
    console.warn("[MDM] Storage save error:", e);
  }
}

function inspectMediaUrl(rawUrl) {
  if (!rawUrl) return { isAudio: false, isVideo: false, isProgressive: false, bitrate: 0, videoId: null, vencodeTag: "" };

  let decodedEfg = "";
  if (rawUrl.includes("efg=")) {
    try {
      const match = rawUrl.match(/efg=([^&]+)/);
      if (match && match[1]) {
        decodedEfg = atob(decodeURIComponent(match[1]));
      }
    } catch {}
  }

  let videoId = null;
  let bitrate = 0;
  let vencodeTag = "";
  if (decodedEfg) {
    try {
      const parsed = JSON.parse(decodedEfg);
      videoId = parsed.video_id ? String(parsed.video_id) : null;
      bitrate = parsed.bitrate || 0;
      vencodeTag = parsed.vencode_tag || "";
    } catch {}
  }

  const lower = rawUrl.toLowerCase();
  const isAudio =
    lower.includes("_audio") ||
    lower.includes("audio_only") ||
    lower.includes("heaac") ||
    vencodeTag.includes("audio") ||
    vencodeTag.includes("heaac") ||
    (bitrate > 0 && bitrate < 110000 && !vencodeTag.includes("video"));

  const isProgressive =
    lower.includes("browser_native") ||
    lower.includes("playable_url") ||
    lower.includes("progressive") ||
    (!isAudio && !lower.includes("dash_") && !vencodeTag.includes("dash_"));

  const isVideo = !isAudio;

  return { isAudio, isVideo, isProgressive, bitrate, videoId, vencodeTag };
}

function isAudioStream(url) {
  return inspectMediaUrl(url).isAudio;
}

function isVideoStream(url) {
  return inspectMediaUrl(url).isVideo;
}

function isProgressiveStream(url) {
  return inspectMediaUrl(url).isProgressive;
}

function getStreamBitrate(url) {
  return inspectMediaUrl(url).bitrate;
}

function sanitizeFacebookCdnUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    // Removing bytestart and byteend causes the Facebook CDN server to serve the complete file
    parsed.searchParams.delete("bytestart");
    parsed.searchParams.delete("byteend");
    return parsed.toString();
  } catch {
    return rawUrl.replace(/[?&]bytestart=\d+/, "").replace(/[?&]byteend=\d+/, "");
  }
}

const IGNORED_MEDIA_EXTENSIONS =
  /\.(jpg|jpeg|png|webp|gif|svg|ico|srt|vtt|css|js|json|woff|woff2|ttf|otf|ts|m4s)(\?|$)/i;

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!details || !details.url || details.tabId < 0) return;
      const u = details.url;

      // Never capture images, subtitles, scripts, fonts, or individual HLS/DASH segments as master media
      if (IGNORED_MEDIA_EXTENSIONS.test(u)) return;

      // Exclude YouTube internals (yt-dlp natively analyzes and downloads YouTube full streams)
      if (u.includes("googlevideo.com") || u.includes("youtube.com") || u.includes("youtu.be")) {
        return;
      }

      // Filter for actual video streams (Facebook CDN MP4, Twitter twimg MP4/M3U8, HLS/DASH manifests, direct video streams)
      const isFbVideo =
        u.includes("video.xx.fbcdn.net") ||
        (u.includes("fbcdn.net") && (u.includes("/m412/") || u.includes("vencode_tag") || u.includes("/v/t2/") || u.includes(".mp4")));

      const isTwitterVideo =
        u.includes("twimg.com") && (u.includes("/amplify_video/") || u.includes(".mp4") || u.includes(".m3u8"));

      const isHlsOrDashManifest =
        /\.(m3u8|mpd)(\?|$|#)/i.test(u) ||
        ((details.type === "xmlhttprequest" || details.type === "other" || details.type === "media") &&
          /(\/master\.txt|\/playlist\.txt|\/manifest\.m3u8|\/index\.m3u8|\/m3u8\/|master\.m3u8|playlist\.m3u8)/i.test(u));

      const isGenericVideo =
        (details.type === "media" || details.type === "xmlhttprequest" || details.type === "other") &&
        (/\.(mp4|webm|mkv)(\?|$|#)/i.test(u) ||
          isHlsOrDashManifest ||
          (details.type === "media" && !/\.(mp3|wav|ogg|aac)(\?|$|#)/i.test(u)));

      if (isFbVideo || isTwitterVideo || isGenericVideo) {
        const reqInitiator = details.documentUrl || details.initiator || null;
        addCapturedMediaForTab(details.tabId, u, details.type, reqInitiator);
      }
    },
    { urls: ["<all_urls>"] }
  );
}

// Clean up when tab is closed
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    try {
      storage.remove(`tab_media_${tabId}`).catch(() => {});
    } catch {}
  });
}

// Setup context menus upon installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "mdm_download_link",
    title: "MDM ile İndir",
    contexts: ["link"],
  });

  chrome.contextMenus.create({
    id: "mdm_download_video",
    title: "MDM ile Video İndir",
    contexts: ["page", "video", "audio"],
  });

  // Default settings
  chrome.storage.local.get(["interceptDownloads"], (result) => {
    if (result.interceptDownloads === undefined) {
      chrome.storage.local.set({ interceptDownloads: true });
    }
  });

  console.log("[MDM Extension] Installed and context menus registered.");
});

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "mdm_download_link") {
    const targetUrl = info.linkUrl;
    if (!targetUrl) return;

    // Check blob / data limitations
    if (targetUrl.startsWith("blob:") || targetUrl.startsWith("data:")) {
      console.warn("[MDM Extension] Blob or Data URL cannot be downloaded externally:", targetUrl);
      notifyUser(
        "İndirme Sınırı",
        "Blob ve Data bağlantıları tarayıcının yerel bellek nesneleridir. Harici indirme yöneticileri bu nesnelere doğrudan erişemez."
      );
      return;
    }

    try {
      // Collect cookies if available
      let cookieHeader = "";
      try {
        const cookies = await chrome.cookies.getAll({ url: targetUrl });
        if (cookies && cookies.length > 0) {
          cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        }
      } catch {
        // Optional cookie access
      }

      const response = await sendNativeMessage({
        type: "add_download",
        url: targetUrl,
        filename: null,
        destination_dir: null,
        referrer: tab?.url || null,
        cookies: cookieHeader || null,
        user_agent: navigator.userAgent,
      });

      if (response?.type === "download_added") {
        if (response.status === "dialog_opened") {
          notifyUser("MDM İndirme Penceresi", `${response.filename || 'Dosya'} için indirme onay penceresi açıldı.`);
        } else {
          notifyUser("MDM İndirme Başlatıldı", `${response.filename} kuyruğa eklendi.`);
        }
      } else if (response?.type === "duplicate_ignored") {
        notifyUser("MDM Bilgi", response.message);
      } else if (response?.type === "error") {
        notifyUser("MDM Hata", response.message);
      }
    } catch (err) {
      handleHostError(err);
    }
  } else if (info.menuItemId === "mdm_download_video") {
    // Determine the actual video URL:
    // On video streaming sites (YouTube, Vimeo, etc.), info.srcUrl is a blob: URL that external downloaders cannot access.
    // Therefore, the page URL (tab.url or info.pageUrl) is the real canonical URL that yt-dlp needs.
    let targetUrl = info.pageUrl || tab?.url || info.srcUrl;
    if (info.srcUrl && !info.srcUrl.startsWith("blob:") && !info.srcUrl.startsWith("data:")) {
      const isVideoPlatform = /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitter\.com|x\.com|instagram\.com|facebook\.com)/i.test(tab?.url || "");
      if (!isVideoPlatform) {
        targetUrl = info.srcUrl;
      }
    }

    if (!targetUrl) return;

    notifyUser("MDM Video İndirme", "MDM indirme penceresi açılıyor, video analiz edilecek...");

    try {
      let cookieHeader = "";
      try {
        const cookieUrls = [...new Set([targetUrl, info.frameUrl, tab?.url].filter(Boolean))];
        const cookiePairs = new Map();
        for (const cu of cookieUrls) {
          const list = await chrome.cookies.getAll({ url: cu });
          if (list) {
            for (const c of list) cookiePairs.set(c.name, c.value);
          }
        }
        if (cookiePairs.size > 0) {
          cookieHeader = Array.from(cookiePairs.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
        }
      } catch {}

      const response = await sendNativeMessage({
        type: "probe_video",
        url: targetUrl,
        referrer: info.frameUrl || tab?.url || null,
        cookies: cookieHeader || null,
        user_agent: navigator.userAgent,
        title: (tab?.title && tab.title.trim()) ? tab.title.trim() : null,
      });

      if (response?.type === "download_added" && response?.status === "dialog_opened") {
        notifyUser(
          "MDM Video Penceresi",
          "Video analiz penceresi açıldı. MDM üzerinden kaliteyi seçip indirmeyi başlatabilirsiniz."
        );
      } else if (response?.type === "video_probed") {
        notifyUser(
          "Video Bulundu",
          `"${response.data.title}" analiz edildi. MDM penceresinden kaliteyi seçip başlatın.`
        );
      } else if (response?.type === "error") {
        notifyUser("MDM Video Hatası", response.message);
      }
    } catch (err) {
      handleHostError(err);
    }
  }
});

// Synchronous interception cache so onCreated/onDeterminingFilename can cancel before Chrome opens "Save As"
let interceptDownloadsEnabled = true;
try {
  chrome.storage.local.get({ interceptDownloads: true }, (res) => {
    interceptDownloadsEnabled = res.interceptDownloads !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.interceptDownloads) {
      interceptDownloadsEnabled = changes.interceptDownloads.newValue !== false;
    }
  });
} catch {}

const handledDownloadIds = new Set();
const pendingNamesById = new Map();
const fallbackBrowserUrls = new Set();

function shouldInterceptDownload(downloadItem) {
  if (!interceptDownloadsEnabled || !downloadItem) return false;
  if (downloadItem.state && downloadItem.state !== "in_progress") return false;
  if (downloadItem.byExtensionId) return false;
  if (downloadItem.paused === true) return false;
  if (downloadItem.startTime) {
    const startedMs = Date.parse(downloadItem.startTime);
    if (!Number.isNaN(startedMs) && Date.now() - startedMs > 15000) return false;
  }
  const url = downloadItem.finalUrl || downloadItem.url || "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (fallbackBrowserUrls.has(url)) return false;
  return true;
}

function cancelBrowserDownloadImmediately(downloadId) {
  try {
    chrome.downloads.cancel(downloadId, () => {
      void chrome.runtime.lastError;
      chrome.downloads.erase({ id: downloadId }, () => {
        void chrome.runtime.lastError;
      });
    });
  } catch {}
  setTimeout(() => {
    try {
      chrome.downloads.erase({ id: downloadId }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
  }, 200);
}

async function forwardInterceptedDownload(downloadItem) {
  if (handledDownloadIds.has(downloadItem.id)) return;
  handledDownloadIds.add(downloadItem.id);
  setTimeout(() => {
    handledDownloadIds.delete(downloadItem.id);
    pendingNamesById.delete(downloadItem.id);
  }, 60000);

  const url = downloadItem.finalUrl || downloadItem.url;
  if (!downloadItem.filename && !pendingNamesById.has(downloadItem.id)) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  let cookieHeader = "";
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies && cookies.length > 0) {
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch (e) {
    console.warn("[MDM Extension] Cookie collection skipped:", e);
  }

  const rawName = pendingNamesById.get(downloadItem.id) || downloadItem.filename || null;
  const filename = rawName ? rawName.split(/[\/\\]/).pop() : null;

  try {
    const response = await sendNativeMessage({
      type: "add_download",
      url: url,
      filename: filename,
      destination_dir: null,
      referrer: downloadItem.referrer || null,
      cookies: cookieHeader || null,
      user_agent: navigator.userAgent,
    });

    if (response?.type === "download_added" || response?.type === "duplicate_ignored") {
      if (response.type === "duplicate_ignored") {
        notifyUser("MDM Bilgi", response.message);
      } else if (response.status === "dialog_opened") {
        notifyUser("MDM İndirme Yakalandı", `${response.filename || "Dosya"} için indirme onay penceresi açıldı.`);
      } else {
        notifyUser("MDM İndirme Yakalandı", `${response.filename} indirilmeye başlandı.`);
      }
    } else if (response?.type === "error") {
      notifyUser("MDM Hata", response.message);
    }
  } catch (err) {
    console.error("[MDM Extension] Failed to forward download to native host, falling back to browser:", err);
    fallbackBrowserUrls.add(url);
    setTimeout(() => fallbackBrowserUrls.delete(url), 15000);
    try {
      chrome.downloads.download({ url });
    } catch {}
  }
}

if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, _suggest) => {
    if (!shouldInterceptDownload(downloadItem)) return;
    if (downloadItem.filename) {
      pendingNamesById.set(downloadItem.id, downloadItem.filename.split(/[\/\\]/).pop());
    }
    cancelBrowserDownloadImmediately(downloadItem.id);
    forwardInterceptedDownload(downloadItem);
  });
}

// Download Interception
chrome.downloads.onCreated.addListener((downloadItem) => {
  if (!shouldInterceptDownload(downloadItem)) return;
  cancelBrowserDownloadImmediately(downloadItem.id);
  forwardInterceptedDownload(downloadItem);
});

// Listen for messages from popup.js and content.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === "get_captured_media_for_tab") {
        const tabId = sender.tab?.id;
        const streams = tabId ? await getCapturedMediaForTab(tabId) : [];
        sendResponse({ success: true, streams });
        return;
      }

      if (request.action === "reset_media_for_tab") {
        const tabId = sender.tab?.id;
        if (tabId && tabId >= 0) {
          try {
            await storage.remove(`tab_media_${tabId}`);
          } catch {}
        }
        sendResponse({ success: true });
        return;
      }

      if (request.action === "verify_and_resolve_video") {
        const tabId = sender.tab?.id;
        const targetVideoId = request.targetVideoId || null;
        const tabStreams = tabId ? await getCapturedMediaForTab(tabId) : [];

        if (tabStreams.length === 0) {
          sendResponse({ ready: false });
          return;
        }

        const validStreams = tabStreams.filter((s) => !IGNORED_MEDIA_EXTENSIONS.test(s.url));
        const videoStreams = validStreams.filter((s) => isVideoStream(s.url));

        if (videoStreams.length === 0) {
          sendResponse({ ready: false });
          return;
        }

        // 1. If targetVideoId is specified, check if stream for THIS exact video has been sniffed
        if (targetVideoId) {
          const matching = videoStreams.filter((s) => inspectMediaUrl(s.url).videoId === targetVideoId);
          if (matching.length > 0) {
            const prog = matching.find((s) => isProgressiveStream(s.url));
            const best = [...matching].sort((a, b) => getStreamBitrate(b.url) - getStreamBitrate(a.url))[0];
            const chosen = prog || best;
            sendResponse({ ready: true, url: sanitizeFacebookCdnUrl(chosen.url), videoId: targetVideoId });
            return;
          }
          // The specific video stream has not arrived yet
          sendResponse({ ready: false });
          return;
        }

        // 2. Generic stream: return newest captured video stream
        const newestStream = [...videoStreams].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
        const newestId = inspectMediaUrl(newestStream.url).videoId;
        sendResponse({ ready: true, url: sanitizeFacebookCdnUrl(newestStream.url), videoId: newestId });
        return;
      }

      if (request.action === "download_video_from_page") {
        let u = request.url || "";
        const tabId = sender.tab?.id;
        const tabUrl = sender.tab?.url || "";
        let effectiveReferrer = request.frameUrl || sender.url || request.pageReferrer || tabUrl || null;
        const pageTitle =
          sender.tab?.title && sender.tab.title.trim()
            ? sender.tab.title.trim()
            : request.pageTitle && request.pageTitle.trim()
            ? request.pageTitle.trim()
            : null;

        // Extract requested videoId if passed or from URL
        let targetVideoId = request.targetVideoId || null;
        if (!targetVideoId) {
          const m = (u || tabUrl).match(/\/(?:reel|videos|watch\/?\?v=)(\d+)/);
          if (m && m[1]) targetVideoId = m[1];
        }

        const isStreamingPlatform =
          tabUrl.includes("youtube.com") ||
          tabUrl.includes("youtu.be") ||
          u.includes("youtube.com") ||
          u.includes("youtu.be") ||
          tabUrl.includes("tiktok.com") ||
          tabUrl.includes("vimeo.com");

        const isDirectMediaUrl = (val) =>
          /\.(m3u8|mpd|mp4|webm|mkv)(\?|$|#)/i.test(val || "") ||
          /(\/master\.txt|\/playlist\.txt|\/manifest\.m3u8|\/index\.m3u8|\/m3u8\/)/i.test(val || "");

        // Only use captured raw CDN/HLS media streams for non-major-platform sites (Facebook, Twitter, movie/embed players, direct HTML5 video)
        let tabStreams = tabId && !isStreamingPlatform ? await getCapturedMediaForTab(tabId) : [];

        // On embed players (e.g. rapidrame, vidmoly, closeload), wait briefly if the stream request started right as user clicked
        const isFbOrTw =
          tabUrl.includes("facebook.com") ||
          u.includes("facebook.com") ||
          tabUrl.includes("twitter.com") ||
          tabUrl.includes("x.com");

        if (!isStreamingPlatform && !isFbOrTw && tabId && tabStreams.length === 0 && !isDirectMediaUrl(u)) {
          for (let retry = 0; retry < 3; retry++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            tabStreams = await getCapturedMediaForTab(tabId);
            if (tabStreams.length > 0) break;
          }
        }

        if (!isStreamingPlatform && tabStreams.length > 0) {
          // If page URL is Facebook and not already direct CDN link, use captured stream
          if (!u.includes("fbcdn.net") && (tabUrl.includes("facebook.com") || u.includes("facebook.com"))) {
            let fbStreams = tabStreams.filter((s) => s.url.includes("fbcdn.net") && !IGNORED_MEDIA_EXTENSIONS.test(s.url));

            let candidateStreams = fbStreams;
            let matchedExactId = false;

            if (targetVideoId) {
              let matching = fbStreams.filter((s) => inspectMediaUrl(s.url).videoId === targetVideoId);
              // If targetVideoId is known but its stream hasn't registered in onBeforeRequest yet (newly scrolled video):
              // Wait up to 800ms (4 retries * 200ms) for the in-flight stream chunk to arrive!
              if (matching.length === 0 && tabId) {
                for (let retry = 0; retry < 4; retry++) {
                  await new Promise((resolve) => setTimeout(resolve, 200));
                  const fresh = await getCapturedMediaForTab(tabId);
                  matching = fresh.filter((s) => s.url.includes("fbcdn.net") && inspectMediaUrl(s.url).videoId === targetVideoId && !IGNORED_MEDIA_EXTENSIONS.test(s.url));
                  if (matching.length > 0) {
                    fbStreams = fresh.filter((s) => s.url.includes("fbcdn.net") && !IGNORED_MEDIA_EXTENSIONS.test(s.url));
                    candidateStreams = matching;
                    matchedExactId = true;
                    break;
                  }
                }
              } else if (matching.length > 0) {
                candidateStreams = matching;
                matchedExactId = true;
              }
            }

            const videoOnlyStreams = candidateStreams.filter((s) => isVideoStream(s.url));

            let chosenStream = null;
            if (matchedExactId) {
              // Target video ID matched! Choose progressive or highest bitrate for this exact video
              const prog = candidateStreams.find((s) => isProgressiveStream(s.url));
              const bestBitrate = [...videoOnlyStreams].sort((a, b) => getStreamBitrate(b.url) - getStreamBitrate(a.url))[0];
              chosenStream = prog || bestBitrate;
            } else if (videoOnlyStreams.length > 0) {
              // Target video ID was not matched or generic (e.g. group feed, reels scrolling):
              // CRITICAL: Always pick the NEWEST captured stream (the one currently being played on screen right now!)
              const newestStream = [...videoOnlyStreams].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
              const newestId = inspectMediaUrl(newestStream.url).videoId;

              if (newestId) {
                const newestGroup = videoOnlyStreams.filter((s) => inspectMediaUrl(s.url).videoId === newestId);
                const prog = newestGroup.find((s) => isProgressiveStream(s.url));
                const bestQuality = [...newestGroup].sort((a, b) => getStreamBitrate(b.url) - getStreamBitrate(a.url))[0];
                chosenStream = prog || bestQuality || newestStream;
              } else {
                chosenStream = newestStream;
              }
            }

            if (chosenStream) {
              u = sanitizeFacebookCdnUrl(chosenStream.url);
              if (chosenStream.initiator) {
                effectiveReferrer = chosenStream.initiator;
              }
            }
          } else if (!u.includes("twimg.com") && (tabUrl.includes("twitter.com") || tabUrl.includes("x.com"))) {
            const twStreams = tabStreams.filter((s) => (s.url.includes("video.twimg.com") || s.url.includes(".mp4")) && !IGNORED_MEDIA_EXTENSIONS.test(s.url));
            const progressiveTw = twStreams.find((s) => isProgressiveStream(s.url));
            const newestTw = [...twStreams].filter((s) => isVideoStream(s.url)).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
            const bestTwimg = progressiveTw || newestTw || twStreams[0];
            if (bestTwimg) {
              u = bestTwimg.url;
              if (bestTwimg.initiator) {
                effectiveReferrer = bestTwimg.initiator;
              }
            }
          } else if (!isDirectMediaUrl(u)) {
            // Generic movie/streaming embed players (e.g. rapidrame, vidmoly, closeload):
            // Replace HTML/iframe URL (?rapidrame_id=...) with the captured HLS (.m3u8), DASH (.mpd), or direct .mp4 stream
            const validStreams = tabStreams.filter(
              (s) => s && s.url && !IGNORED_MEDIA_EXTENSIONS.test(s.url) && isVideoStream(s.url)
            );
            const sorted = [...validStreams].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            const masterPlaylist = sorted.find(
              (s) => /(master|playlist|multi)/i.test(s.url) && /(\.m3u8|master\.txt|playlist\.txt|\.mpd)/i.test(s.url)
            );
            const anyManifest = sorted.find((s) =>
              /(\.m3u8|\.mpd|\/master\.txt|\/playlist\.txt|\/manifest\.m3u8|\/index\.m3u8|\/m3u8\/)/i.test(s.url)
            );
            const directMedia = sorted.find(
              (s) => /\.(mp4|webm|mkv)(\?|$|#)/i.test(s.url) || s.type === "media"
            );

            const chosen = masterPlaylist || anyManifest || directMedia;
            if (chosen) {
              u = chosen.url;
              if (chosen.initiator) {
                if (request.frameUrl && request.frameUrl.startsWith(chosen.initiator)) {
                  effectiveReferrer = request.frameUrl;
                } else if (chosen.initiator.includes("://")) {
                  effectiveReferrer = chosen.initiator;
                }
              } else if (request.frameUrl) {
                effectiveReferrer = request.frameUrl;
              }
            }
          }
          // If URL is still a generic home or empty, fallback to the latest captured NON-AUDIO video stream!
          if (!u || u.endsWith(".facebook.com/") || u.endsWith("x.com/") || u.endsWith("/home")) {
            const nonAudio = [...tabStreams]
              .filter((s) => isVideoStream(s.url) && !IGNORED_MEDIA_EXTENSIONS.test(s.url))
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
            if (nonAudio) {
              u = sanitizeFacebookCdnUrl(nonAudio.url);
            }
          }
        }

        if (u.includes("fbcdn.net")) {
          // If the selected URL does not match targetVideoId, or is audio-only, replace it!
          const currentInfo = inspectMediaUrl(u);
          if (targetVideoId && currentInfo.videoId && currentInfo.videoId !== targetVideoId && tabStreams.length > 0) {
            const exactVideoCandidate = tabStreams.find((s) => {
              const info = inspectMediaUrl(s.url);
              return info.videoId === targetVideoId && isVideoStream(s.url) && !IGNORED_MEDIA_EXTENSIONS.test(s.url);
            });
            if (exactVideoCandidate) {
              u = exactVideoCandidate.url;
            }
          } else if (isAudioStream(u) && tabStreams.length > 0) {
            const videoCandidate = tabStreams.find((s) => {
              const info = inspectMediaUrl(s.url);
              const matchesId = currentInfo.videoId ? info.videoId === currentInfo.videoId : (!targetVideoId || !info.videoId || info.videoId === targetVideoId);
              return matchesId && s.url.includes("fbcdn.net") && isVideoStream(s.url) && !IGNORED_MEDIA_EXTENSIONS.test(s.url);
            });
            if (videoCandidate) {
              u = videoCandidate.url;
            }
          }
          u = sanitizeFacebookCdnUrl(u);
        }

        if (
          !u ||
          u === "https://x.com/" ||
          u === "https://x.com/home" ||
          u === "https://twitter.com/" ||
          u === "https://twitter.com/home" ||
          u === "https://www.facebook.com/" ||
          u === "https://facebook.com/" ||
          u.endsWith("/home")
        ) {
          notifyUser(
            "Video Seçilmedi",
            "Genel ana sayfa algılandı. Lütfen videoyu oynattıktan sonra indirmeyi deneyin."
          );
          sendResponse({ success: false, error: "Generic home URL ignored." });
          return;
        }

        // Collect browser cookies across stream CDN, embed frame Referer, and top-level page URL
        let cookieHeader = "";
        try {
          const cookieUrls = [...new Set([u, effectiveReferrer, tabUrl].filter((x) => x && x.startsWith("http")))];
          const cookiePairs = new Map();
          for (const cu of cookieUrls) {
            try {
              const list = await chrome.cookies.getAll({ url: cu });
              if (list) {
                for (const c of list) {
                  cookiePairs.set(c.name, c.value);
                }
              }
            } catch {}
          }
          if (cookiePairs.size > 0) {
            cookieHeader = Array.from(cookiePairs.entries())
              .map(([k, v]) => `${k}=${v}`)
              .join("; ");
          }
        } catch (e) {
          console.warn("[MDM] Cookie retrieval warning:", e);
        }

        // Direct CDN stream link (Facebook CDN, Twimg MP4, direct video streams)
        const isDirectStream =
          !isStreamingPlatform &&
          !IGNORED_MEDIA_EXTENSIONS.test(u) &&
          (u.includes("fbcdn.net") ||
            (u.includes("video.twimg.com") && u.includes(".mp4")) ||
            u.includes(".mp4?") ||
            u.endsWith(".mp4"));

        if (isDirectStream) {
          notifyUser("MDM İndirme", "Doğrudan yüksek hızlı video akışı algılandı, onay penceresi açılıyor...");
          const filename = u.includes("fbcdn.net")
            ? "facebook_video.mp4"
            : u.includes("twimg.com")
            ? "twitter_video.mp4"
            : "video.mp4";

          const response = await sendNativeMessage({
            type: "add_download",
            url: u,
            filename: filename,
            destination_dir: null,
            referrer: effectiveReferrer || tabUrl || null,
            cookies: cookieHeader || null,
            user_agent: navigator.userAgent,
          });

          sendResponse({ success: true, data: response });
          return;
        }

        notifyUser("MDM Video İndirme", "MDM onay penceresi açılıyor, video analiz edilecek...");
        const response = await sendNativeMessage({
          type: "probe_video",
          url: u,
          referrer: effectiveReferrer || tabUrl || null,
          cookies: cookieHeader || null,
          user_agent: navigator.userAgent,
          title: pageTitle,
        });
        if (response?.type === "download_added" && response?.status === "dialog_opened") {
          notifyUser(
            "MDM Video Penceresi",
            "Video analiz penceresi açıldı. Kaliteyi seçip indirmeyi başlatın."
          );
        } else if (response?.type === "video_probed") {
          notifyUser(
            "Video Bulundu",
            `"${response.data.title}" analiz edildi. MDM penceresinden kaliteyi seçip başlatın.`
          );
        } else if (response?.type === "error") {
          notifyUser("MDM Video Hatası", response.message);
        }
        sendResponse({ success: true, data: response });
        return;
      }

      const response = await sendNativeMessage(request);
      sendResponse({ success: true, data: response });
    } catch (err) {
      handleHostError(err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // Keep message channel open for async response
});

function notifyUser(title, message) {
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: title,
        message: message,
        priority: 2,
      });
    }
  } catch (e) {
    console.warn("[MDM] Notification error:", e);
  }
  console.log(`[MDM Notification] ${title}: ${message}`);
}

function handleHostError(err) {
  const msg = err.message || String(err);
  console.error("[MDM Extension] Host communication error:", msg);
  if (msg.includes("specified native messaging host not found") || msg.includes("can't find")) {
    notifyUser(
      "MDM Bağlantı Hatası",
      "MDM Native Messaging Host bulunamadı. Lütfen 'register_host.bat' dosyasını çalıştırın."
    );
  } else {
    notifyUser("MDM Hatası", msg);
  }
}
