// Shared settings helpers — read/write the user-configurable endpoint and
// auth token, plus the daily and per-session usage counters.

const DEFAULT_SETTINGS = {
  endpoint: "",
  token: "",
  syncEnabled: false,
  // Conservative throttle defaults; tunable in settings UI.
  perPinDelayMs: 12_000,
  perPinJitterMs: 3_000,
  blockSize: 15,
  blockPauseMs: 75_000,
  sessionCap: 100,
  dailyCap: 100,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getDailyUsage() {
  const stored = await chrome.storage.local.get("dailyUsage");
  const today = new Date().toISOString().slice(0, 10);
  if (!stored.dailyUsage || stored.dailyUsage.date !== today) {
    return { date: today, count: 0 };
  }
  return stored.dailyUsage;
}

export async function bumpDailyUsage(amount = 1) {
  const cur = await getDailyUsage();
  const next = { date: cur.date, count: cur.count + amount };
  await chrome.storage.local.set({ dailyUsage: next });
  return next;
}

export async function resetDailyUsage() {
  await chrome.storage.local.remove("dailyUsage");
}
