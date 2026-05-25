// Tiny IndexedDB wrapper. Stores every captured pin locally so the helper
// is useful by itself even when no remote endpoint is configured.

const DB_NAME = "pinreel";
const DB_VERSION = 1;
const STORE = "captures";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "pinId" });
        store.createIndex("capturedAt", "capturedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveCapture(item) {
  const record = {
    pinId: String(item.pinId),
    videoUrl: item.videoUrl || null,
    imageUrl: item.imageUrl || null,
    slides: Array.isArray(item.slides) ? item.slides : null,
    sourceUrl: item.sourceUrl || null,
    capturedAt: new Date().toISOString(),
    synced: false,
  };
  await withStore("readwrite", (store) => {
    return new Promise((ok, ko) => {
      const req = store.put(record);
      req.onsuccess = () => ok();
      req.onerror = () => ko(req.error);
    });
  });
  return record;
}

export async function markSynced(pinIds) {
  await withStore("readwrite", (store) => {
    return new Promise((ok) => {
      let remaining = pinIds.length;
      if (remaining === 0) return ok();
      for (const id of pinIds) {
        const getReq = store.get(String(id));
        getReq.onsuccess = () => {
          const rec = getReq.result;
          if (rec) {
            rec.synced = true;
            store.put(rec);
          }
          remaining--;
          if (remaining === 0) ok();
        };
        getReq.onerror = () => {
          remaining--;
          if (remaining === 0) ok();
        };
      }
    });
  });
}

export async function listCaptures(limit = 500) {
  return withStore("readonly", (store) => {
    return new Promise((ok, ko) => {
      const out = [];
      const index = store.index("capturedAt");
      const req = index.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return ok(out);
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => ko(req.error);
    });
  });
}

export async function listUnsynced(limit = 100) {
  const all = await listCaptures(2000);
  return all.filter((r) => !r.synced).slice(0, limit);
}

// Inserts an empty "we tried, found nothing" marker only if no record
// for this pinId exists yet. Used after a queue visit so image-only
// carousels (which Pinterest still tags as multiple_images / animated)
// don't loop forever in the queue. Never overwrites a real capture.
export async function recordVisitAttempt(pinId) {
  await withStore("readwrite", (store) => {
    return new Promise((ok) => {
      const getReq = store.get(String(pinId));
      getReq.onsuccess = () => {
        if (getReq.result) {
          ok();
          return;
        }
        const putReq = store.put({
          pinId: String(pinId),
          videoUrl: null,
          imageUrl: null,
          slides: null,
          sourceUrl: null,
          capturedAt: new Date().toISOString(),
          synced: false,
        });
        putReq.onsuccess = () => ok();
        putReq.onerror = () => ok();
      };
      getReq.onerror = () => ok();
    });
  });
}

export async function clearAllCaptures() {
  await withStore("readwrite", (store) => {
    return new Promise((ok, ko) => {
      const req = store.clear();
      req.onsuccess = () => ok();
      req.onerror = () => ko(req.error);
    });
  });
}

export async function countCaptures() {
  return withStore("readonly", (store) => {
    return new Promise((ok, ko) => {
      const req = store.count();
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  });
}
