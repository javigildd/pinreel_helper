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
    onLocalCaptures(msg.items).catch((e) => console.error(e));
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

async function onLocalCaptures(items) {
  if (!Array.isArray(items) || items.length === 0) return;
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
      await visitPinPage(todo[i].pinUrl);
      // Always record an attempt — even if the page yielded no media. Without
      // this, image-only carousels (which Pinterest still flags as
      // multiple_images / animated) would re-enter the queue forever.
      // recordVisitAttempt only writes if no record exists, so real captures
      // posted by the content script during the visit are preserved.
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

function visitPinPage(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab || tab.id === undefined) return resolve();
      const tabId = tab.id;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        try {
          chrome.tabs.remove(tabId);
        } catch {
          /* ignore */
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
