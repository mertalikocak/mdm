/**
 * Mak Download Manager (MDM) - Video Grabber Content Script (IDM Style)
 * Automatically detects HTML5 videos across YouTube, Twitter/X, Facebook,
 * Instagram, TikTok, Reddit, and all web platforms.
 * Docks the download button directly onto the top-right OUTER edge of the video player.
 */

(function () {
  "use strict";

  const ATTACHED_ATTR = "data-mdm-grabber-attached";
  let activeUrl = window.location.href;
  const activePanels = new Map(); // video -> panel element

  // SVG Icons
  const PLAY_ARROW_SVG = `
    <svg viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z"/>
    </svg>
  `;

  /**
   * Extracts direct CDN video URL from Facebook page scripts or DOM
   */
  function extractFacebookCdnUrl(video) {
    if (video) {
      if (video.currentSrc && !video.currentSrc.startsWith("blob:") && video.currentSrc.includes("fbcdn.net")) {
        if (!video.currentSrc.includes("_audio") && !video.currentSrc.includes("heaac")) {
          return video.currentSrc;
        }
      }
      if (video.src && !video.src.startsWith("blob:") && video.src.includes("fbcdn.net")) {
        if (!video.src.includes("_audio") && !video.src.includes("heaac")) {
          return video.src;
        }
      }
    }

    const keys = [
      "playable_url_quality_hd",
      "browser_native_hd_url",
      "playable_url",
      "browser_native_sd_url",
      "hd_src_no_ratelimit",
      "sd_src_no_ratelimit",
      "hd_src",
      "sd_src",
    ];

    try {
      const scripts = document.querySelectorAll("script:not([src])");
      for (const s of scripts) {
        const text = s.textContent;
        if (!text || (!text.includes("playable_url") && !text.includes("browser_native") && !text.includes("fbcdn.net"))) {
          continue;
        }

        for (const k of keys) {
          // Matches standard: "playable_url":"https://..."
          // Matches escaped: \"playable_url\":\"https:\/\/...\"
          // Matches extra-escaped: \\\"playable_url\\\":\\\"https:\\\/\\\/...\\\"
          const reg = new RegExp(`(?:\\\\*"${k}\\\\*")\\s*:\\s*\\\\*"([^\\\\"]+)\\\\*"`, "i");
          const match = text.match(reg);
          if (match && match[1]) {
            let rawUrl = match[1];
            rawUrl = rawUrl.replace(/\\u0026/g, "&").replace(/&amp;/g, "&").replace(/\\\//g, "/");
            try {
              rawUrl = JSON.parse(`"${rawUrl}"`);
            } catch {}
            if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
              if (!rawUrl.includes("_audio") && !rawUrl.includes("heaac")) {
                return rawUrl;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[MDM] FB script extraction error:", e);
    }

    return null;
  }

  /**
   * Resolves the canonical video/post URL for social media platforms.
   * Returns null if no specific video/post URL could be resolved
   * (to prevent showing on generic home feeds where only home URL would be sent).
   */
  function resolveVideoTargetUrl(video) {
    if (!video) return null;

    const host = window.location.hostname.toLowerCase();
    const pathname = window.location.pathname.toLowerCase();

    // 0. Dedicated video streaming platforms (YouTube, Vimeo, TikTok, Dailymotion):
    // ALWAYS use canonical page URL so that yt-dlp analyzes the complete high-quality video and formats!
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      return window.location.href;
    }
    if (host.includes("vimeo.com") || host.includes("dailymotion.com") || host.includes("tiktok.com")) {
      return window.location.href;
    }

    // Direct video stream source if valid HTTP/HTTPS and not blob/data
    if (
      video.currentSrc &&
      !video.currentSrc.startsWith("blob:") &&
      !video.currentSrc.startsWith("data:") &&
      (video.currentSrc.startsWith("http://") || video.currentSrc.startsWith("https://"))
    ) {
      return video.currentSrc;
    }

    // Direct source tags
    for (const s of video.querySelectorAll("source")) {
      if (s.src && !s.src.startsWith("blob:") && !s.src.startsWith("data:") && (s.src.startsWith("http://") || s.src.startsWith("https://"))) {
        return s.src;
      }
    }

    // 1. Twitter / X (feed tweets or single status)
    if (host.includes("twitter.com") || host.includes("x.com")) {
      // If we are already on a specific tweet status page
      if (pathname.includes("/status/")) {
        return window.location.href;
      }

      // Check if video is inside a Tweet article
      const tweet =
        video.closest('article[data-testid="tweet"]') ||
        video.closest("article") ||
        video.closest('[data-testid="cellInnerDiv"]');
      if (tweet) {
        // Robust X strategy: In Twitter DOM, the canonical tweet permalink contains the <time> tag
        const timeEl = tweet.querySelector("time");
        if (timeEl) {
          const timeLink = timeEl.closest("a");
          if (timeLink && timeLink.href && timeLink.href.includes("/status/")) {
            return timeLink.href;
          }
        }

        // Secondary strategy: Any status link that is not analytics/photo
        const allStatusLinks = tweet.querySelectorAll('a[href*="/status/"]');
        for (const link of allStatusLinks) {
          if (
            link.href &&
            !link.href.includes("/analytics") &&
            !link.href.includes("/photo/") &&
            !link.href.includes("/quotes")
          ) {
            return link.href;
          }
        }
      }

      // If video is inside a modal / lightbox (when user clicked to expand)
      const modal = video.closest('[aria-modal="true"], [data-testid="sheetDialog"], [role="dialog"]');
      if (modal) {
        if (window.location.href.includes("/status/")) {
          return window.location.href;
        }
        const modalLink = modal.querySelector('a[href*="/status/"]');
        if (modalLink && modalLink.href) {
          return modalLink.href;
        }
      }

      // If video's currentSrc is a twimg video URL
      if (video.currentSrc && video.currentSrc.includes("video.twimg.com")) {
        return video.currentSrc;
      }

      // On home feed without resolved tweet link: DO NOT show/return home URL
      return null;
    }

    // 2. Facebook (feed units, reels, watch, or posts)
    if (host.includes("facebook.com")) {
      // Priority 1: Extract direct high-speed CDN MP4 link from Facebook DOM or embedded scripts
      const directCdnUrl = extractFacebookCdnUrl(video);
      if (directCdnUrl) {
        return directCdnUrl;
      }

      // If on a dedicated single video/reel page
      if (
        (pathname.includes("/reel/") ||
         pathname.includes("/watch") ||
         pathname.includes("/videos/") ||
         pathname.includes("/posts/") ||
         pathname.includes("/permalink/") ||
         pathname.includes("/story.php")) &&
        !pathname.includes("/groups/")
      ) {
        return window.location.href;
      }

      // Check if video is expanded in theater/dialog mode
      const dialog = video.closest('div[role="dialog"]');
      if (dialog) {
        if (
          window.location.pathname.includes("/reel/") ||
          window.location.pathname.includes("/watch") ||
          window.location.pathname.includes("/videos/")
        ) {
          return window.location.href;
        }
        const dialogLink = dialog.querySelector(
          'a[href*="/reel/"], a[href*="/videos/"], a[href*="/watch"], a[href*="/posts/"], a[href*="permalink.php"]'
        );
        if (dialogLink && dialogLink.href) {
          return dialogLink.href;
        }
      }

      // Feed post unit
      const post =
        video.closest('div[role="article"]') ||
        video.closest('[data-pagelet*="FeedUnit"]') ||
        video.closest('[data-pagelet*="Reels"]') ||
        video.closest('[data-pagelet*="Video"]') ||
        video.closest('[role="feed"] > div');
      if (post) {
        const videoLink = post.querySelector(
          'a[href*="/reel/"], a[href*="/videos/"], a[href*="/watch"], a[href*="/posts/"], a[href*="permalink.php"], a[href*="story.php"]'
        );
        if (videoLink && videoLink.href && !videoLink.href.endsWith("facebook.com/") && !videoLink.href.includes("#")) {
          return videoLink.href;
        }
      }

      // If direct fbcdn media URL exists
      if (video.currentSrc && video.currentSrc.includes("fbcdn.net")) {
        return video.currentSrc;
      }

      // On home feed without resolved post link: DO NOT show/return home URL
      return null;
    }

    // 3. Instagram (reels, post cards, or modals)
    if (host.includes("instagram.com")) {
      if (pathname.includes("/reel/") || pathname.includes("/p/")) {
        return window.location.href;
      }
      const post = video.closest("article") || video.closest('div[role="dialog"]');
      if (post) {
        const reelLink = post.querySelector('a[href*="/reel/"], a[href*="/p/"]');
        if (reelLink && reelLink.href) {
          return reelLink.href;
        }
      }
      return null;
    }

    // 4. TikTok (recommend feed or post)
    if (host.includes("tiktok.com")) {
      if (pathname.includes("/video/")) {
        return window.location.href;
      }
      const feedItem =
        video.closest('[data-e2e="feed-item"]') ||
        video.closest('[data-e2e="recommend-list-item-container"]');
      if (feedItem) {
        const videoLink = feedItem.querySelector('a[href*="/video/"]');
        if (videoLink && videoLink.href) {
          return videoLink.href;
        }
      }
      return null;
    }

    // 5. Reddit (shreddit post or post container)
    if (host.includes("reddit.com")) {
      if (pathname.includes("/comments/")) {
        return window.location.href;
      }
      const post = video.closest("shreddit-post") || video.closest('[data-testid="post-container"]');
      if (post) {
        const postLink = post.querySelector('a[data-click-id="body"], a[href*="/comments/"]');
        if (postLink && postLink.href) {
          return postLink.href;
        }
      }
      return null;
    }

    // 6. YouTube
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      if (pathname.includes("/watch") || pathname.includes("/shorts/")) {
        return window.location.href;
      }
      const videoCard = video.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer");
      if (videoCard) {
        const link = videoCard.querySelector('a#thumbnail[href*="/watch"], a#video-title-link[href*="/watch"]');
        if (link && link.href) {
          return link.href;
        }
      }
      return null;
    }

    // 7. Generic Direct Video URL
    if (
      video.currentSrc &&
      !video.currentSrc.startsWith("blob:") &&
      !video.currentSrc.startsWith("data:")
    ) {
      return video.currentSrc;
    }

    // For generic websites, only return page URL if it's a specific page (not bare root domain)
    if (pathname && pathname !== "/" && pathname.length > 2) {
      return window.location.href;
    }

    return null;
  }

  /**
   * Updates panel position anchored directly on the top-right corner inside the video player (IDM Style)
   */
  function updatePanelPosition(video, panel) {
    if (!video || !panel || !video.isConnected || video.getAttribute("data-mdm-dismissed") === "true") {
      if (panel) {
        panel.style.display = "none";
        panel.remove();
      }
      activePanels.delete(video);
      return;
    }

    // Fullscreen handling
    if (document.fullscreenElement) {
      panel.style.top = "18px";
      panel.style.right = "18px";
      panel.style.left = "auto";
      panel.style.display = "inline-flex";
      return;
    }

    // Find the player's bounding rect
    let targetEl = video;
    if (window.location.hostname.includes("youtube.com")) {
      const ytPlayer = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
      if (ytPlayer && (ytPlayer.contains(video) || !document.contains(video))) targetEl = ytPlayer;
    }

    const rect = targetEl.getBoundingClientRect();

    // Hide if out of viewport, hidden, or too small
    if (
      rect.width < 140 ||
      rect.height < 90 ||
      rect.bottom <= 40 ||
      rect.top >= window.innerHeight - 20
    ) {
      panel.style.display = "none";
      return;
    }

    panel.style.display = "inline-flex";

    // Dock inside top-right corner of the video player (IDM standard)
    let top = rect.top + 8;
    // If player top scrolled offscreen, keep pinned inside visible portion
    if (top < 10) {
      top = 10;
    }

    const right = Math.max(8, window.innerWidth - rect.right + 8);

    panel.style.top = `${top}px`;
    panel.style.right = `${right}px`;
    panel.style.left = "auto";

    if (rect.width < 420) {
      panel.classList.add("is-compact");
    } else {
      panel.classList.remove("is-compact");
    }
  }

  /**
   * Creates the IDM-style floating panel element
   */
  function createGrabberPanel(video) {
    const panel = document.createElement("div");
    panel.className = "mdm-video-grabber-panel";
    panel.title = "Bu videoyu Mak Download Manager ile yüksek hızda indir";

    // Play icon badge
    const iconContainer = document.createElement("span");
    iconContainer.className = "mdm-grabber-icon";
    iconContainer.innerHTML = PLAY_ARROW_SVG;

    // Text Label
    const textLabel = document.createElement("span");
    textLabel.className = "mdm-grabber-label";
    textLabel.textContent = "Bu video dosyasını indir";

    // Quality Badge (e.g. MDM)
    const qualityBadge = document.createElement("span");
    qualityBadge.className = "mdm-grabber-quality-badge";
    qualityBadge.textContent = "MDM";

    // Close button
    const closeBtn = document.createElement("span");
    closeBtn.className = "mdm-grabber-close";
    closeBtn.title = "Kapat";
    closeBtn.textContent = "✕";

    panel.appendChild(iconContainer);
    panel.appendChild(textLabel);
    panel.appendChild(qualityBadge);
    panel.appendChild(closeBtn);

    // Dismiss handler (permanently dismisses button for this video)
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      video.setAttribute("data-mdm-dismissed", "true");
      panel.style.display = "none";
      panel.remove();
      activePanels.delete(video);
    });

    function extractVideoIdFromElementOrPage(v) {
      if (!v) return null;

      // 1. First priority: Check video container links (essential for reels feed and groups)
      const container =
        v.closest('div[role="article"], div[role="dialog"], [data-pagelet*="FeedUnit"], [data-pagelet*="Reels"], [data-pagelet*="Video"], div[role="feed"] > div') ||
        v.parentElement;

      if (container) {
        if (container.getAttribute("data-video-id")) {
          return container.getAttribute("data-video-id");
        }
        const links = container.querySelectorAll('a[href*="/reel/"], a[href*="/videos/"], a[href*="/posts/"], a[href*="watch"]');
        for (const a of links) {
          if (a.href && !a.href.endsWith("facebook.com/") && !a.href.includes("#")) {
            const m = a.href.match(/\/(?:reel|videos|posts|watch\/?\?v=)(\d+)/) || a.href.match(/(?:story_fbid|v)=(\d+)/);
            if (m && m[1]) return m[1];
          }
        }
      }

      // 2. Second priority: Single dedicated page URL
      const pageMatch = window.location.href.match(/\/(?:reel|videos|watch\/?\?v=)(\d+)/);
      if (pageMatch && pageMatch[1] && !window.location.href.includes("/groups/")) {
        return pageMatch[1];
      }

      return null;
    }

    // Prevent pointer/mouse interactions on the panel from toggling the underlying player
    for (const evtName of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
      panel.addEventListener(evtName, (e) => {
        e.stopPropagation();
      });
    }

    // Download handler
    panel.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();

      // Show analyzing animation immediately
      iconContainer.innerHTML = `<div class="mdm-grabber-spinner"></div>`;
      textLabel.textContent = "MDM Açılıyor...";
      panel.classList.add("is-analyzing");

      // Use strictly verified URL already attached to the panel, or fallback to canonical resolution
      let verifiedUrl = panel.getAttribute("data-mdm-verified-url") || resolveVideoTargetUrl(video);
      const targetVideoId = panel.getAttribute("data-mdm-video-id") || extractVideoIdFromElementOrPage(video);

      // Fallback: Direct video source or non-home page URL
      if (!verifiedUrl) {
        if (video.currentSrc && !video.currentSrc.startsWith("blob:") && !video.currentSrc.startsWith("data:")) {
          verifiedUrl = video.currentSrc;
        } else if (
          window.location.href &&
          !window.location.href.endsWith("facebook.com/") &&
          !window.location.href.endsWith("x.com/") &&
          !window.location.href.endsWith("/home")
        ) {
          verifiedUrl = window.location.href;
        }
      }

      if (!verifiedUrl) {
        textLabel.textContent = "Video Akışı Bekleniyor...";
        setTimeout(() => {
          iconContainer.innerHTML = PLAY_ARROW_SVG;
          textLabel.textContent = "Bu video dosyasını indir";
          panel.classList.remove("is-analyzing");
        }, 2000);
        return;
      }

      try {
        chrome.runtime.sendMessage(
          {
            action: "download_video_from_page",
            url: verifiedUrl,
            targetVideoId: targetVideoId,
            src: video.currentSrc || null,
            frameUrl: window.location.href || null,
            pageReferrer: document.referrer || null,
            pageTitle: document.title || null,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn("[MDM] SendMessage runtime error:", chrome.runtime.lastError.message);
              textLabel.textContent = "Sayfayı Yenileyin (F5)";
              setTimeout(() => {
                iconContainer.innerHTML = PLAY_ARROW_SVG;
                textLabel.textContent = "Bu video dosyasını indir";
                panel.classList.remove("is-analyzing");
              }, 3000);
              return;
            }

            setTimeout(() => {
              iconContainer.innerHTML = PLAY_ARROW_SVG;
              textLabel.textContent = "Bu video dosyasını indir";
              panel.classList.remove("is-analyzing");
            }, 2500);
          }
        );
      } catch (err) {
        console.warn("[MDM] SendMessage failed:", err);
        textLabel.textContent = "Sayfayı Yenileyin (F5)";
        setTimeout(() => {
          iconContainer.innerHTML = PLAY_ARROW_SVG;
          textLabel.textContent = "Bu video dosyasını indir";
          panel.classList.remove("is-analyzing");
        }, 3000);
      }
    });

    return panel;
  }

  /**
   * Attaches the grabber panel to a video element
   */
  function attachToVideo(video) {
    if (!video || video.getAttribute(ATTACHED_ATTR) || video.getAttribute("data-mdm-dismissed") === "true") return;

    // Mark as attached
    video.setAttribute(ATTACHED_ATTR, "true");

    const panel = createGrabberPanel(video);
    document.body.appendChild(panel);
    activePanels.set(video, panel);

    // Initial position
    updatePanelPosition(video, panel);

    const refresh = () => {
      updatePanelPosition(video, panel);
    };

    video.addEventListener("play", refresh);
    video.addEventListener("playing", refresh);
    video.addEventListener("pause", refresh);
    video.addEventListener("loadedmetadata", refresh);
    video.addEventListener("loadeddata", refresh);
    video.addEventListener("canplay", refresh);
    video.addEventListener("timeupdate", refresh);
    video.addEventListener("mouseenter", refresh);
    video.addEventListener("click", () => {
      setTimeout(refresh, 100);
      setTimeout(refresh, 500);
    });

    const container =
      video.closest('div[role="article"], div[role="dialog"], [data-pagelet*="FeedUnit"], [data-pagelet*="Reels"], [data-pagelet*="Video"], ytd-player, #player') ||
      video.parentElement;

    if (container) {
      container.addEventListener("mouseenter", refresh);
      container.addEventListener("mousemove", refresh, { passive: true });
      container.addEventListener("click", () => {
        setTimeout(refresh, 100);
        setTimeout(refresh, 500);
      });
    }
  }

  /**
   * Repositions all active panels (called on scroll, resize, layout shift)
   */
  function updateAllPanelPositions() {
    activePanels.forEach((panel, video) => {
      if (!video.isConnected) {
        panel.remove();
        activePanels.delete(video);
      } else {
        updatePanelPosition(video, panel);
      }
    });
  }

  /**
   * Scans current document for valid video elements
   */
  function scanVideos() {
    const videos = document.querySelectorAll("video");
    videos.forEach((v) => {
      if (v.getAttribute("data-mdm-dismissed") === "true") return;
      attachToVideo(v);
    });
  }

  // Initial scan
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanVideos);
  } else {
    scanVideos();
  }

  // Smooth position tracking on scroll and window resize (capture: true catches modal scrolls)
  window.addEventListener("scroll", updateAllPanelPositions, { capture: true, passive: true });
  window.addEventListener("resize", updateAllPanelPositions, { passive: true });
  document.addEventListener("fullscreenchange", updateAllPanelPositions);

  // Observe dynamically inserted video elements (scrolling on Twitter/Facebook, modals, etc.)
  const observer = new MutationObserver(() => {
    scanVideos();
    updateAllPanelPositions();
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });

  // Periodic safety scan (every 1 second) to catch dynamically rendered videos & layout updates
  setInterval(() => {
    scanVideos();
    updateAllPanelPositions();
  }, 1000);

  // YouTube / SPA navigation detection
  window.addEventListener("yt-navigate-finish", () => {
    activeUrl = window.location.href;
    activePanels.forEach((panel) => panel.remove());
    activePanels.clear();
    document.querySelectorAll("video").forEach((v) => {
      v.removeAttribute(ATTACHED_ATTR);
      v.removeAttribute("data-mdm-dismissed");
    });
    setTimeout(() => {
      scanVideos();
      updateAllPanelPositions();
    }, 400);
  });

  // General SPA URL watcher
  setInterval(() => {
    if (window.location.href !== activeUrl) {
      activeUrl = window.location.href;
      activePanels.forEach((panel) => panel.remove());
      activePanels.clear();
      document.querySelectorAll("video").forEach((v) => {
        v.removeAttribute(ATTACHED_ATTR);
        v.removeAttribute("data-mdm-dismissed");
      });
      setTimeout(() => {
        scanVideos();
        updateAllPanelPositions();
      }, 500);
    }
  }, 1000);
})();

