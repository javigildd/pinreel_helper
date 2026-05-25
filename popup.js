import { getSettings, setSettings } from "./lib/settings.js";

const els = {
  endpointDot: document.getElementById("endpointDot"),
  endpointText: document.getElementById("endpointText"),
  canvasSelect: document.getElementById("canvasSelect"),
  screenshotBtn: document.getElementById("screenshotBtn"),

  queueDot: document.getElementById("queueDot"),
  queueText: document.getElementById("queueText"),
  refreshQueueBtn: document.getElementById("refreshQueueBtn"),
  processQueueBtn: document.getElementById("processQueueBtn"),
  batchStatus: document.getElementById("batchStatus"),

  endpointInput: document.getElementById("endpoint"),
  tokenInput: document.getElementById("token"),
  syncToggle: document.getElementById("syncToggle"),
  perPinDelay: document.getElementById("perPinDelay"),
  dailyCap: document.getElementById("dailyCap"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  settingsStatus: document.getElementById("settingsStatus"),
};

// --- tab nav ---
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document
      .querySelectorAll(".tab")
      .forEach((x) => x.classList.remove("active"));
    document
      .querySelectorAll(".panel")
      .forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("panel-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "queue") refreshQueue();
  });
});

// --- main panel ---
async function renderEndpointStatus() {
  const { endpoint, token } = await getSettings();
  if (!endpoint || !token) {
    els.endpointDot.className = "dot err";
    els.endpointText.textContent = "Endpoint not configured · open Settings";
    els.canvasSelect.disabled = true;
    els.screenshotBtn.disabled = true;
    return;
  }
  els.endpointDot.className = "dot ok";
  els.endpointText.textContent = `Connected to ${shortenHost(endpoint)}`;
  await loadCanvases();
  await setupScreenshotBtn();
}

function shortenHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

async function authedFetch(path, init = {}) {
  const { endpoint, token } = await getSettings();
  const url = endpoint.replace(/\/+$/, "") + path;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

async function loadCanvases() {
  try {
    const res = await authedFetch("/canvases");
    if (!res.ok) {
      els.canvasSelect.innerHTML = "<option>Endpoint did not return canvases</option>";
      els.canvasSelect.disabled = true;
      return;
    }
    const data = await res.json();
    const canvases = data.canvases || [];
    if (canvases.length === 0) {
      els.canvasSelect.innerHTML = "<option>No canvases yet</option>";
      els.canvasSelect.disabled = true;
      return;
    }
    const { lastCanvasId } = await chrome.storage.local.get(["lastCanvasId"]);
    els.canvasSelect.innerHTML = "";
    for (const c of canvases) {
      const opt = document.createElement("option");
      opt.value = c.boardId;
      opt.textContent = c.name;
      if (c.boardId === lastCanvasId) opt.selected = true;
      els.canvasSelect.appendChild(opt);
    }
    els.canvasSelect.disabled = false;
    els.canvasSelect.addEventListener("change", () => {
      chrome.storage.local.set({ lastCanvasId: els.canvasSelect.value });
    });
  } catch {
    els.canvasSelect.innerHTML = "<option>Could not reach endpoint</option>";
    els.canvasSelect.disabled = true;
  }
}

async function setupScreenshotBtn() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    els.screenshotBtn.textContent = "Open a webpage first";
    els.screenshotBtn.disabled = true;
    return;
  }
  els.screenshotBtn.disabled = !els.canvasSelect.value;
  els.screenshotBtn.onclick = async () => {
    els.screenshotBtn.disabled = true;
    const canvasId = els.canvasSelect.value;
    if (!canvasId) return;
    await chrome.storage.session.set({ captureTarget: { canvasId } });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["selector.js"],
    });
    window.close();
  };
}

// --- queue panel ---
async function refreshQueue() {
  els.queueDot.className = "dot";
  els.queueText.textContent = "Loading…";
  try {
    const res = await authedFetch("/queue");
    if (!res.ok) {
      els.queueDot.className = "dot err";
      els.queueText.textContent = `Queue HTTP ${res.status}`;
      els.processQueueBtn.disabled = true;
      return;
    }
    const data = await res.json();
    const total = (data.pending || []).length;
    if (total === 0) {
      els.queueDot.className = "dot ok";
      els.queueText.textContent = "Queue empty — nothing pending";
      els.processQueueBtn.disabled = true;
    } else {
      els.queueDot.className = "dot ok";
      els.queueText.textContent = `${total} pin${total === 1 ? "" : "s"} pending`;
      els.processQueueBtn.disabled = false;
    }
  } catch {
    els.queueDot.className = "dot err";
    els.queueText.textContent = "Could not reach endpoint";
    els.processQueueBtn.disabled = true;
  }
}

els.refreshQueueBtn.onclick = () => refreshQueue();
els.processQueueBtn.onclick = async () => {
  els.processQueueBtn.disabled = true;
  els.batchStatus.style.display = "block";
  els.batchStatus.textContent = "Starting…";
  chrome.runtime.sendMessage({ kind: "PINREEL_RUN_QUEUE" });
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind !== "PINREEL_BATCH_STATE") return;
  els.batchStatus.style.display = "block";
  if (msg.error) {
    els.batchStatus.textContent = msg.error;
    els.processQueueBtn.disabled = false;
    return;
  }
  if (msg.finished) {
    els.batchStatus.textContent = `Done. Processed ${msg.done}/${msg.total}.`;
    els.processQueueBtn.disabled = false;
    refreshQueue();
    return;
  }
  if (msg.paused) {
    els.batchStatus.textContent = `Paused between blocks · ${msg.done}/${msg.total} so far`;
    return;
  }
  if (msg.running) {
    els.batchStatus.textContent = `Processing… ${msg.done}/${msg.total}`;
    els.processQueueBtn.disabled = true;
  }
});

// --- settings panel ---
async function renderSettings() {
  const s = await getSettings();
  els.endpointInput.value = s.endpoint;
  els.tokenInput.value = s.token;
  els.perPinDelay.value = Math.round(s.perPinDelayMs / 1000);
  els.dailyCap.value = s.dailyCap;
  els.syncToggle.classList.toggle("on", s.syncEnabled);
}

els.syncToggle.addEventListener("click", async () => {
  const current = els.syncToggle.classList.contains("on");
  els.syncToggle.classList.toggle("on", !current);
});

els.saveSettingsBtn.addEventListener("click", async () => {
  const perPinSec = Math.max(5, Math.min(60, Number(els.perPinDelay.value) || 12));
  const dailyCap = Math.max(50, Math.min(2000, Number(els.dailyCap.value) || 500));
  await setSettings({
    endpoint: els.endpointInput.value.trim(),
    token: els.tokenInput.value.trim(),
    syncEnabled: els.syncToggle.classList.contains("on"),
    perPinDelayMs: perPinSec * 1000,
    dailyCap,
  });
  els.settingsStatus.style.display = "block";
  els.settingsStatus.textContent = "Saved.";
  renderEndpointStatus();
});

// --- bootstrap from web page request ---
// A website (e.g. Moodly) can offer "Connect to PinReel Helper" — it
// postMessages a config blob to the active tab; if the user authorises it
// the values arrive here as a runtime message and we save them.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind !== "PINREEL_PROVISION") return;
  if (msg.endpoint && msg.token) {
    setSettings({
      endpoint: msg.endpoint,
      token: msg.token,
      syncEnabled: true,
    }).then(() => {
      renderSettings();
      renderEndpointStatus();
    });
  }
});

renderEndpointStatus();
renderSettings();
