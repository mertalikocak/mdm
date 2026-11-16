/**
 * Mak Download Manager (MDM) - Video Grabber Content Script (IDM Style)
 * Automatically detects HTML5 videos across YouTube, Twitter/X, Facebook,
 * Instagram, TikTok, Reddit, and all web platforms.
 * Docks the download button directly onto the top-right OUTER edge of the video player.
 */

(function () {
  "use strict";

  const ATTACHED_ATTR = "data-mdm-grabber-attached";
  const DEFAULT_LABEL = "MDM İndir";
  const VIDEO_DWELL_MS = 1000;
  const FEED_SCROLL_SETTLE_MS = 1200;
  const HOVER_REVEAL_MS = 250;

  let activeUrl = window.location.href;
  const activePanels = new Map(); // video -> panel element
  const panelStates = new WeakMap(); // video -> { visibleSince, isHovered, hoverSince }
  let lastScrollAt = 0;
  let dwellRefreshTimer = null;

  function isFeedPlatform() {
    const h = window.location.hostname.toLowerCase();
    return (
      h.includes("facebook.com") ||
      h.includes("instagram.com") ||
      h.includes("twitter.com") ||
      h.includes("x.com") ||
      h.includes("tiktok.com") ||
      h.includes("reddit.com")
    );
  }

  function scheduleDwellRefresh(delayMs) {
    const clamped = Math.max(80, Math.min(2000, delayMs));
    if (dwellRefreshTimer) {
      clearTimeout(dwellRefreshTimer);
    }
    dwellRefreshTimer = setTimeout(() => {
      dwellRefreshTimer = null;
      updateAllPanelPositions();
    }, clamped);
  }

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

  function getTargetRect(video) {
    let targetEl = video;
    if (window.location.hostname.includes("youtube.com")) {
      const ytPlayer = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
      if (ytPlayer && (ytPlayer.contains(video) || !document.contains(video))) targetEl = ytPlayer;
    }
    return targetEl.getBoundingClientRect();
  }

  function isRectSubstantiallyVisible(rect) {
    if (rect.width < 200 || rect.height < 120) return false;
    if (rect.right <= 40 || rect.left >= window.innerWidth - 20) return false;
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, window.innerHeight);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const minRequired = Math.min(rect.height * 0.45, 110);
    return visibleHeight >= minRequired;
  }

  /**
   * Updates panel position anchored directly on the top-right corner inside the video player
   */
  function updatePanelPosition(video, panel, allowDisplay = true) {
    if (!video || !panel || !video.isConnected || video.getAttribute("data-mdm-dismissed") === "true") {
      if (panel) {
        panel.classList.remove("is-visible");
        panel.style.display = "none";
        panel.remove();
      }
      activePanels.delete(video);
      return;
    }

    let state = panelStates.get(video);
    if (!state) {
      state = { visibleSince: 0, isHovered: false, hoverSince: 0 };
      panelStates.set(video, state);
    }

    // Fullscreen handling
    if (document.fullscreenElement) {
      panel.style.top = "18px";
      panel.style.right = "18px";
      panel.style.left = "auto";
      panel.style.display = "inline-flex";
      panel.classList.add("is-visible");
      return;
    }

    const rect = getTargetRect(video);

    // Hide if out of viewport, hidden, too small, or suppressed on multi-video feed
    if (!allowDisplay || !isRectSubstantiallyVisible(rect)) {
      state.visibleSince = 0;
      panel.classList.remove("is-visible");
      panel.style.display = "none";
      return;
    }

    const now = Date.now();
    const isAnalyzing = panel.classList.contains("is-analyzing");
    const panelHovered = panel.matches(":hover");

    if (!isAnalyzing && !panelHovered) {
      const feedMode = isFeedPlatform();
      if (feedMode && !state.isHovered && now - lastScrollAt < 350) {
        panel.classList.remove("is-visible");
        panel.style.display = "none";
        scheduleDwellRefresh(FEED_SCROLL_SETTLE_MS);
        return;
      }

      if (!state.visibleSince) {
        state.visibleSince = now;
      }

      const dwellElapsed = now - state.visibleSince;
      const scrollElapsed = now - lastScrollAt;
      const requiredScrollWait = feedMode ? FEED_SCROLL_SETTLE_MS : 350;
      const hoverReady = state.isHovered && state.hoverSince > 0 && now - state.hoverSince >= HOVER_REVEAL_MS;
      const dwellReady = dwellElapsed >= VIDEO_DWELL_MS && scrollElapsed >= requiredScrollWait;

      if (!hoverReady && !dwellReady) {
        panel.style.display = "inline-flex";
        panel.classList.remove("is-visible");
        const remainingDwell = Math.max(0, VIDEO_DWELL_MS - dwellElapsed);
        const remainingScroll = Math.max(0, requiredScrollWait - scrollElapsed);
        const remainingHover = state.isHovered && state.hoverSince > 0 ? Math.max(0, HOVER_REVEAL_MS - (now - state.hoverSince)) : Infinity;
        const nextWait = Math.min(Math.max(remainingDwell, remainingScroll), remainingHover);
        scheduleDwellRefresh(nextWait + 25);
        return;
      }
    }

    // Dock inside top-right corner of the video player
    let top = rect.top + 8;
    if (top < 10) {
      top = 10;
    }
    const right = Math.max(8, window.innerWidth - rect.right + 8);

    panel.style.top = `${top}px`;
    panel.style.right = `${right}px`;
    panel.style.left = "auto";
    panel.style.display = "inline-flex";
    panel.classList.add("is-visible");

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
    textLabel.textContent = DEFAULT_LABEL;

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
        textLabel.textContent = "Akış Bekleniyor...";
        setTimeout(() => {
          iconContainer.innerHTML = PLAY_ARROW_SVG;
          textLabel.textContent = DEFAULT_LABEL;
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
              textLabel.textContent = "Yenileyin (F5)";
              setTimeout(() => {
                iconContainer.innerHTML = PLAY_ARROW_SVG;
                textLabel.textContent = DEFAULT_LABEL;
                panel.classList.remove("is-analyzing");
              }, 3000);
              return;
            }

            setTimeout(() => {
              iconContainer.innerHTML = PLAY_ARROW_SVG;
              textLabel.textContent = DEFAULT_LABEL;
              panel.classList.remove("is-analyzing");
            }, 2500);
          }
        );
      } catch (err) {
        console.warn("[MDM] SendMessage failed:", err);
        textLabel.textContent = "Yenileyin (F5)";
        setTimeout(() => {
          iconContainer.innerHTML = PLAY_ARROW_SVG;
          textLabel.textContent = DEFAULT_LABEL;
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
    panelStates.set(video, { visibleSince: 0, isHovered: false, hoverSince: 0 });

    // Initial evaluation (respects dwell / scroll settle delay)
    updateAllPanelPositions();

    const refresh = () => {
      updateAllPanelPositions();
    };

    const setHover = (hovered) => {
      const st = panelStates.get(video);
      if (st) {
        st.isHovered = hovered;
        st.hoverSince = hovered ? st.hoverSince || Date.now() : 0;
      }
      updateAllPanelPositions();
    };

    video.addEventListener("play", refresh);
    video.addEventListener("playing", refresh);
    video.addEventListener("pause", refresh);
    video.addEventListener("loadedmetadata", refresh);
    video.addEventListener("loadeddata", refresh);
    video.addEventListener("canplay", refresh);
    video.addEventListener("timeupdate", refresh);
    video.addEventListener("mouseenter", () => setHover(true));
    video.addEventListener("mouseleave", () => setHover(false));
    video.addEventListener("click", () => {
      setTimeout(refresh, 150);
      setTimeout(refresh, 550);
    });

    const container =
      video.closest('div[role="article"], div[role="dialog"], [data-pagelet*="FeedUnit"], [data-pagelet*="Reels"], [data-pagelet*="Video"], ytd-player, #player') ||
      video.parentElement;

    if (container) {
      container.addEventListener("mouseenter", () => setHover(true));
      container.addEventListener("mouseleave", () => setHover(false));
      container.addEventListener("click", () => {
        setTimeout(refresh, 150);
        setTimeout(refresh, 550);
      });
    }
  }

  /**
   * Repositions all active panels (called on scroll, resize, layout shift)
   */
  function updateAllPanelPositions() {
    let primaryFeedVideo = null;
    const feedMode = isFeedPlatform() && !document.fullscreenElement;

    if (feedMode) {
      const viewportMid = window.innerHeight / 2;
      let bestScore = Infinity;

      activePanels.forEach((panel, video) => {
        if (!video.isConnected || video.getAttribute("data-mdm-dismissed") === "true") return;
        const rect = getTargetRect(video);
        if (!isRectSubstantiallyVisible(rect)) return;

        const st = panelStates.get(video);
        const hovered = (st && st.isHovered) || panel.matches(":hover");
        if (hovered) {
          primaryFeedVideo = video;
          bestScore = -1;
          return;
        }

        const mid = (rect.top + rect.bottom) / 2;
        const dist = Math.abs(mid - viewportMid);
        if (dist < bestScore) {
          bestScore = dist;
          primaryFeedVideo = video;
        }
      });
    }

    activePanels.forEach((panel, video) => {
      if (!video.isConnected) {
        panel.remove();
        activePanels.delete(video);
      } else {
        const allowDisplay = !feedMode || video === primaryFeedVideo;
        updatePanelPosition(video, panel, allowDisplay);
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
  window.addEventListener(
    "scroll",
    () => {
      lastScrollAt = Date.now();
      updateAllPanelPositions();
      scheduleDwellRefresh(FEED_SCROLL_SETTLE_MS + 30);
    },
    { capture: true, passive: true }
  );
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

