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

  // Pin id of the page the helper landed on, if we're on /pin/123/. Used by
  // the aggressive fallback extractor to attribute orphan video_list nodes.
  function currentPagePinId() {
    const m = window.location.pathname.match(/\/pin\/(\d+)/);
    return m ? m[1] : null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;
    // Forward diagnostic messages from injected page-context scripts to the
    // background service worker so they show up in chrome://extensions
    // service-worker DevTools (page console disappears with the tab).
    if (data.source === "pinreel-debug") {
      try {
        chrome.runtime.sendMessage({
          kind: "PINREEL_DEBUG",
          msg: data.msg,
          extra: data.extra,
        });
      } catch {
        /* ignore */
      }
      return;
    }
    if (data.source !== TAG || !data.payload) return;
    try {
      const items = extractWithFallback(data.payload);
      if (items.length > 0) sendBatch(items);
    } catch (e) {
      console.warn("[PinReel] extract failed", e);
    }
  });

  // When the helper is visiting a /pin/X page, Pinterest's response often
  // contains the parent pin's data with its story-pin "pages" nested as
  // sub-objects, each carrying its own numeric ID and its own video_list.
  // The naive walker treats every such sub-object as a separate pin —
  // resulting in N orphan captures saved under sub-IDs that Moodly doesn't
  // know about, and the actual parent pin getting only the first video.
  //
  // Here we collapse the parent pin's entire subtree into ONE consolidated
  // item with slides[], and drop the orphan sub-page items the walker
  // would otherwise produce.
  function extractWithFallback(tree) {
    const items = extractPins(tree);
    const targetId = currentPagePinId();
    if (!targetId) return items;

    const subtree = findSubtreeById(tree, targetId);
    if (!subtree) return items;

    const videoUrls = collectVideoUrls(subtree);
    if (videoUrls.length === 0) return items;

    const consolidated = { pinId: targetId };
    if (videoUrls.length === 1) {
      consolidated.videoUrl = videoUrls[0];
    } else {
      consolidated.slides = videoUrls.map((v) => ({ videoUrl: v }));
    }

    // Drop the target's own previous entry plus any orphan items whose IDs
    // are sub-objects of the target's subtree. Anything outside the subtree
    // (related pins from sidebars, etc.) stays — those captures are still
    // useful if the user happens to have those pins in their canvases.
    const subtreeIds = new Set();
    walk(subtree, (node) => {
      if (
        node &&
        typeof node === "object" &&
        typeof node.id === "string" &&
        /^\d{6,}$/.test(node.id)
      ) {
        subtreeIds.add(node.id);
      }
    });
    const kept = items.filter((it) => !subtreeIds.has(it.pinId));
    kept.push(consolidated);
    return kept;
  }

  // Walk a pin's subtree for every reachable video URL, in traversal order.
  // Handles both node.video_list and the nested node.videos.video_list shape.
  function collectVideoUrls(subtree) {
    const urls = [];
    const seen = new Set();
    walk(subtree, (node) => {
      if (!node || typeof node !== "object") return;
      let list = node.video_list;
      if (!list && node.videos && typeof node.videos === "object") {
        list = node.videos.video_list || node.videos;
      }
      if (!list || typeof list !== "object") return;
      const url = bestVideoUrl(list);
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    });
    return urls;
  }

  // DFS for the first object whose .id matches the given pin id.
  function findSubtreeById(node, id) {
    if (!node || typeof node !== "object") return null;
    if (node.id === id) return node;
    if (Array.isArray(node)) {
      for (const v of node) {
        const found = findSubtreeById(v, id);
        if (found) return found;
      }
      return null;
    }
    for (const k of Object.keys(node)) {
      const found = findSubtreeById(node[k], id);
      if (found) return found;
    }
    return null;
  }

  function scanInlineJson() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script#__PWS_DATA__, script#__PWS_INITIAL_PROPS__',
    );
    const out = [];
    for (const s of scripts) {
      const text = s.textContent || "";
      if (!text || text.length < 50) continue;
      try {
        out.push(...extractWithFallback(JSON.parse(text)));
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

      // Idea pins ("story pins") ship a different shape — pages with
      // either direct video/image fields or block arrays. We flatten
      // that into the same slides[] shape so the backend doesn't care
      // what kind of carousel it was.
      if (!item.slides && Array.isArray(node.story_pin_data?.pages)) {
        const slides = node.story_pin_data.pages
          .map((page) => storyPinPageToSlide(page))
          .filter((s) => s && (s.imageUrl || s.videoUrl));
        if (slides.length > 0) item.slides = slides;
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

  function storyPinPageToSlide(page) {
    if (!page || typeof page !== "object") return null;
    const slide = {};

    // Shape A: page has direct image / video properties.
    const directVideo = page.video || page.video_data;
    const directImage = page.image || page.image_data;
    if (directVideo) {
      const vUrl = bestVideoUrl(directVideo.video_list || directVideo.videos || directVideo);
      if (vUrl) slide.videoUrl = vUrl;
      const imgs = directVideo.image_signature_data?.images || directVideo.images;
      if (imgs && !slide.imageUrl) {
        const i = bestImageUrl(imgs);
        if (i) slide.imageUrl = i;
      }
    }
    if (directImage && !slide.imageUrl) {
      const imgs = directImage.images || directImage;
      const i = bestImageUrl(imgs);
      if (i) slide.imageUrl = i;
    }

    // Shape B: page has a blocks[] array; first video block wins for the
    // video URL, first image block wins as a fallback poster.
    if (Array.isArray(page.blocks)) {
      for (const b of page.blocks) {
        if (!b || typeof b !== "object") continue;
        if (!slide.videoUrl && b.video) {
          const vUrl = bestVideoUrl(
            b.video.video_list || b.video.videos || b.video,
          );
          if (vUrl) slide.videoUrl = vUrl;
        }
        if (!slide.imageUrl && b.image?.images) {
          const i = bestImageUrl(b.image.images);
          if (i) slide.imageUrl = i;
        }
      }
    }

    return slide;
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
