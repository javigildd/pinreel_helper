// PinReel Helper — Pinterest content script.
//
// Runs on pinterest.com pages the user navigates to. Injects the page-context
// shim that exposes Pinterest's own XHR responses to us, then walks those
// responses for pin objects and extracts the URLs of any animated content
// Pinterest's public API hides. Captures are saved locally first via the
// background worker; relaying to a configured endpoint is optional.

(function () {
  const TAG = "pinreel-capture";

  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) {
    console.warn("[PinReel] could not inject hook", e);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG || !data.payload) return;
    try {
      const items = extractPins(data.payload);
      if (items.length > 0) sendBatch(items);
    } catch (e) {
      console.warn("[PinReel] extract failed", e);
    }
  });

  function scanInlineJson() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script#__PWS_DATA__, script#__PWS_INITIAL_PROPS__',
    );
    const out = [];
    for (const s of scripts) {
      const text = s.textContent || "";
      if (!text || text.length < 50) continue;
      try {
        out.push(...extractPins(JSON.parse(text)));
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  function scanRenderedVideos() {
    const out = [];
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      const candidates = [
        v.currentSrc,
        v.src,
        ...Array.from(v.querySelectorAll("source")).map((s) => s.src),
      ];
      const real = candidates.find(isUsableVideoUrl);
      if (!real) continue;
      const pinId = findEnclosingPinId(v);
      if (!pinId) continue;
      out.push({ pinId, videoUrl: real });
    }
    return out;
  }

  function findEnclosingPinId(el) {
    let node = el;
    while (node && node !== document.body) {
      const href = node.getAttribute?.("href") || node.dataset?.link;
      if (href) {
        const m = href.match(/\/pin\/(\d+)/);
        if (m) return m[1];
      }
      const dataPinId =
        node.dataset?.pinId || node.getAttribute?.("data-pin-id");
      if (dataPinId && /^\d+$/.test(dataPinId)) return dataPinId;
      node = node.parentElement;
    }
    const m = window.location.pathname.match(/\/pin\/(\d+)/);
    return m ? m[1] : null;
  }

  function runFullScan() {
    const items = [];
    items.push(...scanInlineJson());
    items.push(...scanRenderedVideos());
    window.postMessage({ source: "pinreel-scan-request" }, "*");
    return items;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      const items = runFullScan();
      if (items.length > 0) sendBatch(items);
    });
  } else {
    const items = runFullScan();
    if (items.length > 0) sendBatch(items);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.kind !== "PINREEL_SCAN_NOW") return;
    const items = runFullScan();
    if (items.length > 0) sendBatch(items);
    sendResponse({ ok: true, found: items.length });
  });

  function walk(obj, visit) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const v of obj) walk(v, visit);
      return;
    }
    visit(obj);
    for (const k of Object.keys(obj)) walk(obj[k], visit);
  }

  function isUsableVideoUrl(src) {
    if (!src || typeof src !== "string") return false;
    if (src.startsWith("blob:") || src.startsWith("data:")) return false;
    return /^https?:\/\//.test(src);
  }

  function extractPins(tree) {
    const seen = new Map();
    walk(tree, (node) => {
      if (!node || typeof node !== "object") return;
      const id = node.id;
      const idLooksLikePin =
        typeof id === "string" && /^\d{6,}$/.test(id);
      if (!idLooksLikePin) return;

      const hasMedia =
        node.videos ||
        node.carousel_data ||
        node.story_pin_data ||
        node.images;
      if (!hasMedia) return;

      const item = { pinId: String(id) };
      const videoUrl = bestVideoUrl(node.videos);
      if (videoUrl) item.videoUrl = videoUrl;

      if (node.carousel_data?.carousel_slots?.length) {
        item.slides = node.carousel_data.carousel_slots.map((slot) => {
          const slide = {};
          const imgUrl = bestImageUrl(slot.images);
          if (imgUrl) slide.imageUrl = imgUrl;
          const vUrl = bestVideoUrl(slot.videos);
          if (vUrl) slide.videoUrl = vUrl;
          return slide;
        });
      }

      if (!item.videoUrl && !item.slides) return;
      const prev = seen.get(item.pinId);
      if (
        !prev ||
        (item.slides && !prev.slides) ||
        (item.videoUrl && !prev.videoUrl)
      ) {
        seen.set(item.pinId, item);
      }
    });
    return Array.from(seen.values());
  }

  function bestVideoUrl(videos) {
    if (!videos || typeof videos !== "object") return null;
    const list = videos.video_list || videos;
    const preferred = [
      "V_720P",
      "V_EXP3",
      "V_EXP4",
      "V_EXP5",
      "V_EXP6",
      "V_1080P",
      "V_HLSV4",
    ];
    for (const key of preferred) {
      const v = list?.[key];
      if (v && isUsableVideoUrl(v.url)) return v.url;
    }
    for (const v of Object.values(list || {})) {
      if (v && isUsableVideoUrl(v.url) && /\.mp4(\?|$)/.test(v.url)) {
        return v.url;
      }
    }
    return null;
  }

  function bestImageUrl(images) {
    if (!images || typeof images !== "object") return null;
    const preferred = ["orig", "originals", "1200x", "736x", "600x"];
    for (const k of preferred) {
      const im = images[k];
      if (im && typeof im.url === "string") return im.url;
    }
    for (const im of Object.values(images)) {
      if (im && typeof im.url === "string") return im.url;
    }
    return null;
  }

  // Batched send to background — coalesce a couple of seconds so we don't
  // fire a request per intercepted XHR.
  const pending = new Map();
  let flushTimer = null;
  function sendBatch(items) {
    for (const it of items) pending.set(it.pinId, it);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = Array.from(pending.values());
      pending.clear();
      if (batch.length === 0) return;
      chrome.runtime.sendMessage({
        kind: "PINREEL_LOCAL_CAPTURES",
        items: batch,
      });
    }, 1500);
  }
})();
