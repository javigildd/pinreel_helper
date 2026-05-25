// PinReel Helper — background service worker.
//
// This worker is responsible for three things:
//   1. Receiving capture events from the Pinterest content script and saving
//      them to local IndexedDB; optionally relaying them to a user-configured
//      endpoint if sync is enabled.
//   2. Polling the configured endpoint's queue and processing it at a
//      conservative pace, opening pinterest.com tabs one at a time.
//   3. Handling screenshot captures (active-tab → drag-select → crop → POST).
//
// Nothing here ever talks to a hardcoded URL. Everything goes to whatever
// endpoint the user has configured in the popup. Nothing here ever runs
// without an explicit user action (popup click).

import {
  getSettings,
  setSettings,
  getDailyUsage,
  bumpDailyUsage,
} from "./lib/settings.js";
import {
  saveCapture,
  markSynced,
  listUnsynced,
  recordVisitAttempt,
} from "./lib/db.js";

const POST_LOAD_WAIT_MS = 7000;
const PER_PIN_TIMEOUT_MS = 15_000;

// Active batch state lives only in memory — if the worker dies we abort.
const batchState = {
  running: false,
  total: 0,
  done: 0,
  cancel: false,
};

function broadcastBatch(extra = {}) {
  chrome.runtime
    .sendMessage({
      kind: "PINREEL_BATCH_STATE",
      running: batchState.running,
      total: batchState.total,
      done: batchState.done,
      ...extra,
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.kind === "PINREEL_LOCAL_CAPTURES") {
    onLocalCaptures(msg.items, sender?.tab?.id).catch((e) => console.error(e));
    return;
  }
  if (msg.kind === "PINREEL_DEBUG") {
    console.log("[PinReel-injected]", msg.msg, msg.extra || "");
    return;
  }
  if (msg.kind === "PINREEL_GET_BATCH_STATE") {
    sendResponse({
      running: batchState.running,
      total: batchState.total,
      done: batchState.done,
    });
    return;
  }
  if (msg.kind === "PINREEL_RUN_QUEUE") {
    runQueueBatch().catch((e) => console.error("[PinReel] queue failed", e));
    return;
  }
  if (msg.kind === "PINREEL_CANCEL_BATCH") {
    batchState.cancel = true;
    return;
  }
  if (msg.kind === "PINREEL_CAPTURE_SCREENSHOT_START") {
    startScreenshotFlow(sender?.tab?.id).catch(() => {});
    return;
  }
  if (msg.kind === "PINREEL_CAPTURE_SCREENSHOT_RECT") {
    finishScreenshot(sender?.tab?.id, sender?.tab?.windowId, msg).catch(
      () => {},
    );
    return;
  }
});

// Tracks in-flight queue-runner visits. Pinterest's pin-page response often
// arrives across multiple XHRs, each with one slide-page's data under its
// own sub-ID. Accumulating per-tab here means we can emit a single
// consolidated capture for the parent pin once the tab is done, instead
// of saving N orphans under sub-IDs Moodly has no pins for.
const activeVisits = new Map(); // tabId -> { pinId, videoUrls: [], seenUrls: Set }

async function onLocalCaptures(items, senderTabId) {
  if (!Array.isArray(items) || items.length === 0) return;

  // If this batch came from a tab the queue runner is currently visiting,
  // fold its video URLs into the visit's accumulator and drop the per-item
  // pinId (sub-pages of story pins have their own IDs we can't use).
  if (senderTabId !== undefined && activeVisits.has(senderTabId)) {
    const state = activeVisits.get(senderTabId);
    for (const it of items) {
      if (!it) continue;
      const addUrl = (u, source) => {
        if (!u || state.seenUrls.has(u)) return;
        state.seenUrls.add(u);
        state.videoUrls.push(u);
        console.log("[PinReel] +video", state.pinId, source, it.pinId || "?", u);
      };
      addUrl(it.videoUrl, "top");
      if (Array.isArray(it.slides)) {
        for (let i = 0; i < it.slides.length; i++) {
          addUrl(it.slides[i]?.videoUrl, `slide${i}`);
        }
      }
    }
    return;
  }

  // Fallback: captures from a tab not driven by the queue runner (user
  // browsing feeds organically). Save each as-is, keyed by its own pinId.
  for (const it of items) {
    if (!it?.pinId) continue;
    console.log("[PinReel] captured", it.pinId, {
      hasVideoUrl: !!it.videoUrl,
      slideCount: Array.isArray(it.slides) ? it.slides.length : 0,
      slideVideos: Array.isArray(it.slides)
        ? it.slides.filter((s) => s?.videoUrl).length
        : 0,
    });
    await saveCapture(it);
  }
  await trySyncToEndpoint();
}

// --- Endpoint sync ------------------------------------------------------

async function authedFetch(path, init = {}) {
  const { endpoint, token } = await getSettings();
  if (!endpoint || !token) throw new Error("Endpoint not configured");
  const url = endpoint.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  return res;
}

async function trySyncToEndpoint() {
  const { syncEnabled } = await getSettings();
  if (!syncEnabled) return;
  const unsynced = await listUnsynced(50);
  if (unsynced.length === 0) return;
  try {
    const res = await authedFetch("/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: unsynced.map((u) => ({
          pinId: u.pinId,
          videoUrl: u.videoUrl,
          imageUrl: u.imageUrl,
          slides: u.slides,
        })),
      }),
    });
    if (res.ok) await markSynced(unsynced.map((u) => u.pinId));
  } catch {
    // backoff handled by the popup's "Sync" button on demand; don't keep
    // retrying silently here.
  }
}

// --- Queue runner -------------------------------------------------------

async function runQueueBatch() {
  if (batchState.running) return;
  let res;
  try {
    res = await authedFetch("/queue");
  } catch (e) {
    broadcastBatch({ error: e.message });
    return;
  }
  if (!res.ok) {
    broadcastBatch({ error: `Queue HTTP ${res.status}` });
    return;
  }
  const data = await res.json().catch(() => ({}));
  const pending = Array.isArray(data.pending) ? data.pending : [];
  if (pending.length === 0) {
    broadcastBatch({ error: "Queue is empty" });
    return;
  }

  const settings = await getSettings();
  const daily = await getDailyUsage();
  const dailyRemaining = Math.max(0, settings.dailyCap - daily.count);
  if (dailyRemaining === 0) {
    broadcastBatch({ error: "Daily cap reached" });
    return;
  }
  const todo = pending.slice(0, Math.min(settings.sessionCap, dailyRemaining));

  batchState.running = true;
  batchState.cancel = false;
  batchState.total = todo.length;
  batchState.done = 0;
  broadcastBatch();

  for (let i = 0; i < todo.length; i++) {
    if (batchState.cancel) break;

    // Block pause every N pins.
    if (i > 0 && i % settings.blockSize === 0) {
      broadcastBatch({ paused: true });
      await sleep(settings.blockPauseMs);
      if (batchState.cancel) break;
    }

    try {
      // Same model the original in-tree extension used: open the pin's
      // page in a background tab, wait for Pinterest's JS to serve whatever
      // it serves, then close. content.js + injected.js intercept any
      // /resource/ JSON that fires and forward video URLs to the
      // visit-state accumulator below. We don't try to fetch Pinterest's
      // internal endpoints directly — they all return 403 outside the
      // page's own JS context regardless of CSRF / headers.
      await visitPinPage(todo[i].pinUrl, todo[i].pinId);
      // Always record an attempt — even if both paths yielded no media.
      // recordVisitAttempt only writes if no record exists.
      await recordVisitAttempt(todo[i].pinId);
    } catch {
      // Carry on; one bad pin shouldn't stall the whole queue.
    }
    batchState.done = i + 1;
    await bumpDailyUsage(1);
    broadcastBatch();

    // Per-pin delay with jitter.
    const jitter =
      (Math.random() * 2 - 1) * settings.perPinJitterMs;
    const wait = Math.max(0, settings.perPinDelayMs + jitter);
    await sleep(wait);
  }

  batchState.running = false;
  broadcastBatch({ finished: true });
  await trySyncToEndpoint();
}

// Hit Pinterest's internal PinResource endpoint to get the full pin object,
// which (when the user is signed into Pinterest) includes per-slide videos
// that aren't in the public OAuth API or in pin-page initial HTML. Runs
// under the user's own pinterest.com session cookies via host_permissions.
async function fetchPinResource(pinId) {
  try {
    const data = encodeURIComponent(
      JSON.stringify({
        options: { id: String(pinId), field_set_key: "detailed" },
      }),
    );
    const url =
      `https://www.pinterest.com/resource/PinResource/get/` +
      `?source_url=${encodeURIComponent(`/pin/${pinId}/`)}&data=${data}`;
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.log(
        "[PinReel] PinResource HTTP",
        res.status,
        "for",
        pinId,
        "- falling back to tab visit",
      );
      return null;
    }
    const json = await res.json();
    const node = json?.resource_response?.data;
    if (!node || typeof node !== "object") return null;
    const item = nodeToItem(node, String(pinId));
    if (!item || (!item.videoUrl && !item.slides)) return null;
    console.log("[PinReel] PinResource captured", pinId, {
      hasVideoUrl: !!item.videoUrl,
      slideCount: Array.isArray(item.slides) ? item.slides.length : 0,
      slideVideos: Array.isArray(item.slides)
        ? item.slides.filter((s) => s?.videoUrl).length
        : 0,
    });
    return item;
  } catch (e) {
    console.log("[PinReel] PinResource error", e.message);
    return null;
  }
}

// Mini-extractor mirroring content.js logic but inlined here so the
// background worker can use it without a content script. Handles
// carousels, story pins, single videos, and falls back to walking the
// subtree for any video_list.
function nodeToItem(node, pinId) {
  const item = { pinId };
  // Top-level single video.
  if (node.videos) {
    const v = bestVideoUrlFromAny(node.videos);
    if (v) item.videoUrl = v;
  }
  // Classic multi-image / multi-video carousel.
  if (Array.isArray(node.carousel_data?.carousel_slots)) {
    item.slides = node.carousel_data.carousel_slots.map((slot) => {
      const slide = {};
      const i = bestImageUrlFromAny(slot.images);
      if (i) slide.imageUrl = i;
      const v = bestVideoUrlFromAny(slot.videos);
      if (v) slide.videoUrl = v;
      return slide;
    });
  }
  // Story pin pages.
  if (!item.slides && Array.isArray(node.story_pin_data?.pages)) {
    const slides = node.story_pin_data.pages
      .map((page) => {
        const slide = {};
        const direct = page.video || page.video_data;
        const directImg = page.image || page.image_data;
        if (direct) {
          const v = bestVideoUrlFromAny(
            direct.video_list || direct.videos || direct,
          );
          if (v) slide.videoUrl = v;
          const imgs =
            direct.image_signature_data?.images || direct.images;
          if (imgs && !slide.imageUrl) {
            const i = bestImageUrlFromAny(imgs);
            if (i) slide.imageUrl = i;
          }
        }
        if (directImg && !slide.imageUrl) {
          const imgs = directImg.images || directImg;
          const i = bestImageUrlFromAny(imgs);
          if (i) slide.imageUrl = i;
        }
        if (Array.isArray(page.blocks)) {
          for (const b of page.blocks) {
            if (!slide.videoUrl && b?.video) {
              const v = bestVideoUrlFromAny(
                b.video.video_list || b.video.videos || b.video,
              );
              if (v) slide.videoUrl = v;
            }
            if (!slide.imageUrl && b?.image?.images) {
              const i = bestImageUrlFromAny(b.image.images);
              if (i) slide.imageUrl = i;
            }
          }
        }
        return slide;
      })
      .filter((s) => s && (s.imageUrl || s.videoUrl));
    if (slides.length > 0) item.slides = slides;
  }
  return item;
}

const PREFERRED_VIDEO_KEYS = [
  "V_720P",
  "V_EXP3",
  "V_EXP4",
  "V_EXP5",
  "V_EXP6",
  "V_1080P",
  "V_HLSV4",
];
function bestVideoUrlFromAny(videos) {
  if (!videos || typeof videos !== "object") return null;
  const list = videos.video_list || videos;
  for (const k of PREFERRED_VIDEO_KEYS) {
    const v = list?.[k];
    if (v?.url && /^https?:\/\//.test(v.url)) return v.url;
  }
  for (const v of Object.values(list || {})) {
    if (v?.url && /^https?:\/\//.test(v.url) && /\.mp4(\?|$)/.test(v.url)) {
      return v.url;
    }
  }
  return null;
}
function bestImageUrlFromAny(images) {
  if (!images || typeof images !== "object") return null;
  const preferred = ["orig", "originals", "1200x", "736x", "600x"];
  for (const k of preferred) {
    const im = images[k];
    if (im?.url) return im.url;
  }
  for (const im of Object.values(images)) {
    if (im?.url) return im.url;
  }
  return null;
}

function visitPinPage(url, pinId) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab || tab.id === undefined) return resolve();
      const tabId = tab.id;
      // Register the visit so onLocalCaptures folds every video URL the
      // content script forwards into one slides[] for this pinId.
      if (pinId) {
        activeVisits.set(tabId, {
          pinId: String(pinId),
          videoUrls: [],
          seenUrls: new Set(),
        });
      }
      let settled = false;
      const cleanup = async () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        try {
          chrome.tabs.remove(tabId);
        } catch {
          /* ignore */
        }
        // Emit one consolidated capture for the visited pin using every
        // video URL we accumulated during the visit.
        const state = activeVisits.get(tabId);
        if (state) {
          activeVisits.delete(tabId);
          if (state.videoUrls.length > 0) {
            const item = { pinId: state.pinId };
            if (state.videoUrls.length === 1) {
              item.videoUrl = state.videoUrls[0];
            } else {
              item.slides = state.videoUrls.map((v) => ({ videoUrl: v }));
            }
            console.log("[PinReel] visit consolidated", state.pinId, {
              videoCount: state.videoUrls.length,
            });
            await saveCapture(item);
            await trySyncToEndpoint();
          } else {
            console.log("[PinReel] visit consolidated", state.pinId, {
              videoCount: 0,
            });
          }
        }
        resolve();
      };
      const onUpdated = (id, info) => {
        if (id !== tabId) return;
        if (info.status === "complete") {
          setTimeout(cleanup, POST_LOAD_WAIT_MS);
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(cleanup, PER_PIN_TIMEOUT_MS);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Screenshot flow ----------------------------------------------------

async function startScreenshotFlow(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["selector.js"],
    });
  } catch {
    /* ignore */
  }
}

async function finishScreenshot(tabId, windowId, msg) {
  if (!tabId || !windowId || !msg?.rect) return;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    return;
  }
  const cropped = await cropDataUrl(dataUrl, msg.rect);
  if (!cropped) return;

  const { captureTarget } = await chrome.storage.session.get(["captureTarget"]);
  if (!captureTarget?.canvasId) {
    await chrome.storage.session.remove(["captureTarget"]);
    return;
  }

  try {
    const res = await authedFetch("/screenshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvasId: captureTarget.canvasId,
        imageDataUrl: cropped.dataUrl,
        width: cropped.width,
        height: cropped.height,
        title: msg.title || null,
        sourceUrl: msg.sourceUrl || null,
      }),
    });
    if (!res.ok) {
      console.warn("[PinReel] screenshot POST", res.status);
    }
  } catch (e) {
    console.warn("[PinReel] screenshot send failed", e);
  } finally {
    await chrome.storage.session.remove(["captureTarget"]);
  }
}

async function cropDataUrl(dataUrl, rect) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const dpr = rect.dpr || 1;
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
    if (sw <= 0 || sh <= 0) return null;
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const reader = new FileReader();
    return new Promise((ok) => {
      reader.onload = () => ok({ dataUrl: reader.result, width: sw, height: sh });
      reader.onerror = () => ok(null);
      reader.readAsDataURL(out);
    });
  } catch {
    return null;
  }
}

// --- Helper that other contexts call directly via dynamic import (popup) ---
export { setSettings };
