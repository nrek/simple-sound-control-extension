const STORAGE_KEY_TABS = "ssc_saved_tab_volumes";
const STORAGE_KEY_URLS = "ssc_saved_url_volumes";
const STORAGE_KEY_ACCENT = "ssc_accent";
const STORAGE_KEY_LIVE = "ssc_live_tab_volume";

const MSG_RESOLVE_FRAME = "SSC_RESOLVE_VOLUME";
const MSG_RESOLVE_TAB = "SSC_RESOLVE_VOLUME_FOR_TAB";
const MSG_REFRESH_TOOLBAR = "SSC_REFRESH_TOOLBAR";

const ICON_PATHS = {
  16: "icon-16.png",
  32: "icon-32.png",
  48: "icon-48.png",
  128: "icon-128.png",
};

/** Toolbar dot uses the same hues as the popup light accent. */
const ACCENT_HEX = {
  purple: "#6750a4",
  blue: "#1b6cbf",
  orange: "#b85c00",
  red: "#ba1a1a",
  green: "#246b3a",
  teal: "#006a60",
  seafoam: "#0d6f5c",
  yellow: "#6b5e00",
  gray: "#5d5d62",
};

let toolbarRefreshTimer = null;

function normalizeTabEntries(list) {
  if (!Array.isArray(list)) return { list: [], changed: false };
  let changed = false;
  const next = list.map((item) => {
    if (item == null || typeof item !== "object") return item;
    const copy = { ...item };
    if (copy.tabId === undefined && copy.id !== undefined && /^\d+$/.test(String(copy.id))) {
      copy.tabId = Number(copy.id);
      changed = true;
    }
    return copy;
  });
  return { list: next, changed };
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function clampVolume(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(400, Math.round(v)));
}

/**
 * @param {string} key
 */
function accentHexFromKey(key) {
  const k = typeof key === "string" ? key.toLowerCase() : "purple";
  return ACCENT_HEX[k] || ACCENT_HEX.purple;
}

/**
 * Tab-specific override beats origin; else origin; else 100.
 * @param {number} tabId
 * @param {string} frameOrigin
 */
function resolveVolumeFromLists(tabsList, urlsList, tabId, frameOrigin) {
  const tabs = Array.isArray(tabsList) ? tabsList : [];
  const urls = Array.isArray(urlsList) ? urlsList : [];

  const tabRow = tabs.find((row) => Number(row.tabId) === Number(tabId));
  const tabVol = clampVolume(tabRow?.volume);
  if (tabVol !== null) return tabVol;

  const origin = typeof frameOrigin === "string" ? frameOrigin : "";
  if (origin) {
    const urlRow = urls.find((row) => {
      if (row.origin === origin) return true;
      if (typeof row.url === "string" && row.url) {
        try {
          return new URL(row.url).origin === origin;
        } catch {
          return false;
        }
      }
      return false;
    });
    const urlVol = clampVolume(urlRow?.volume);
    if (urlVol !== null) return urlVol;
  }

  return 100;
}

/**
 * Live per-tab boost (last value applied from popup) wins over saved lists.
 * @param {Record<string, unknown>} result storage.get result
 * @param {number} tabId
 * @param {string} frameOrigin
 */
function resolveEffectiveVolume(result, tabId, frameOrigin) {
  const liveMap = result[STORAGE_KEY_LIVE];
  const lid = String(tabId);
  if (
    liveMap &&
    typeof liveMap === "object" &&
    !Array.isArray(liveMap) &&
    liveMap[lid] !== undefined
  ) {
    const lv = clampVolume(liveMap[lid]);
    if (lv !== null) return lv;
  }

  const { list: tabs } = normalizeTabEntries(result[STORAGE_KEY_TABS]);
  const urls = Array.isArray(result[STORAGE_KEY_URLS]) ? result[STORAGE_KEY_URLS] : [];
  return resolveVolumeFromLists(tabs, urls, tabId, frameOrigin);
}

function resolveVolumeFromStorage(tabId, frameOrigin, callback) {
  chrome.storage.local.get(
    [STORAGE_KEY_TABS, STORAGE_KEY_URLS, STORAGE_KEY_LIVE],
    (result) => {
      if (chrome.runtime.lastError) {
        callback(100);
        return;
      }
      callback(resolveEffectiveVolume(result, tabId, frameOrigin));
    }
  );
}

function getStoredAccentKey(callback) {
  chrome.storage.local.get([STORAGE_KEY_ACCENT], (r) => {
    void chrome.runtime?.lastError;
    const key = typeof r[STORAGE_KEY_ACCENT] === "string" ? r[STORAGE_KEY_ACCENT] : "purple";
    callback(key);
  });
}

/**
 * @param {number} size
 * @param {boolean} showDot
 * @param {string} accentKey
 * @returns {Promise<ImageData>}
 */
async function buildCompositeIconImageData(size, showDot, accentKey) {
  const path = ICON_PATHS[size] || `icon-${size}.png`;
  const url = chrome.runtime.getURL(path);
  const res = await fetch(url);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context");
  ctx.drawImage(bmp, 0, 0, size, size);
  if (showDot) {
    const dotR = Math.max(2, size * 0.2);
    const cx = dotR + size * 0.1;
    const cy = size - dotR - size * 0.12;
    ctx.fillStyle = accentHexFromKey(accentKey);
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = Math.max(0.5, size / 20);
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  bmp.close();
  return ctx.getImageData(0, 0, size, size);
}

function resetToolbarIcon() {
  chrome.action.setIcon({ path: ICON_PATHS }, () => void chrome.runtime?.lastError);
  chrome.action.setTitle({ title: "Simple Sound Control" });
  chrome.action.setBadgeText({ text: "" });
}

async function refreshToolbarIcon() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || typeof tab.url !== "string") {
      resetToolbarIcon();
      return;
    }

    let origin = "";
    try {
      origin = new URL(tab.url).origin;
    } catch {
      origin = "";
    }

    const vol = await new Promise((resolve) => {
      resolveVolumeFromStorage(tab.id, origin, resolve);
    });

    if (vol === 100) {
      resetToolbarIcon();
      return;
    }

    const accentKey = await new Promise((resolve) => {
      getStoredAccentKey(resolve);
    });

    try {
      const [im16, im32] = await Promise.all([
        buildCompositeIconImageData(16, true, accentKey),
        buildCompositeIconImageData(32, true, accentKey),
      ]);
      chrome.action.setIcon({ imageData: { 16: im16, 32: im32 } }, () => void chrome.runtime?.lastError);
      chrome.action.setTitle({ title: `Simple Sound Control (${vol}%)` });
      chrome.action.setBadgeText({ text: "" });
    } catch {
      resetToolbarIcon();
    }
  } catch {
    resetToolbarIcon();
  }
}

function scheduleToolbarRefresh() {
  if (toolbarRefreshTimer != null) {
    clearTimeout(toolbarRefreshTimer);
  }
  toolbarRefreshTimer = setTimeout(() => {
    toolbarRefreshTimer = null;
    void refreshToolbarIcon();
  }, 120);
}

function removeLiveVolumeForTab(tabId, done) {
  chrome.storage.local.get([STORAGE_KEY_LIVE], (r) => {
    if (chrome.runtime.lastError) {
      done?.();
      return;
    }
    const prev = r[STORAGE_KEY_LIVE];
    const map =
      prev !== null && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
    delete map[String(tabId)];
    chrome.storage.local.set({ [STORAGE_KEY_LIVE]: map }, () => {
      void chrome.runtime?.lastError;
      done?.();
    });
  });
}

function pruneClosedTab(tabId) {
  chrome.storage.local.get([STORAGE_KEY_TABS, STORAGE_KEY_LIVE], (result) => {
    if (chrome.runtime.lastError) return;
    const raw = result[STORAGE_KEY_TABS];
    const { list, changed: normalized } = normalizeTabEntries(raw);
    const tid = Number(tabId);
    const next = list.filter((row) => {
      if (row == null || typeof row !== "object") return true;
      if (row.tabId !== undefined && !Number.isNaN(Number(row.tabId))) {
        return Number(row.tabId) !== tid;
      }
      if (row.id !== undefined && /^\d+$/.test(String(row.id))) {
        return Number(row.id) !== tid;
      }
      return true;
    });

    const prevLive = result[STORAGE_KEY_LIVE];
    const liveMap =
      prevLive !== null && typeof prevLive === "object" && !Array.isArray(prevLive)
        ? { ...prevLive }
        : {};
    delete liveMap[String(tid)];

    chrome.storage.local.set(
      { [STORAGE_KEY_TABS]: next, [STORAGE_KEY_LIVE]: liveMap },
      () => void chrome.runtime?.lastError
    );
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  pruneClosedTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_KEY_TABS], (result) => {
    if (chrome.runtime.lastError) return;
    const { list, changed } = normalizeTabEntries(result[STORAGE_KEY_TABS]);
    if (changed) {
      chrome.storage.local.set({ [STORAGE_KEY_TABS]: list });
    }
    scheduleToolbarRefresh();
  });
});

chrome.runtime.onStartup.addListener(() => {
  scheduleToolbarRefresh();
});

chrome.tabs.onActivated.addListener(() => {
  scheduleToolbarRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === "string") {
    removeLiveVolumeForTab(tabId, () => scheduleToolbarRefresh());
    return;
  }
  if (changeInfo.status === "complete") {
    chrome.tabs.query({ active: true, currentWindow: true }, (active) => {
      if (chrome.runtime.lastError) return;
      if (active[0]?.id === tabId) {
        scheduleToolbarRefresh();
      }
    });
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  scheduleToolbarRefresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes[STORAGE_KEY_TABS] ||
    changes[STORAGE_KEY_URLS] ||
    changes[STORAGE_KEY_ACCENT] ||
    changes[STORAGE_KEY_LIVE]
  ) {
    scheduleToolbarRefresh();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG_REFRESH_TOOLBAR) {
    scheduleToolbarRefresh();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === MSG_RESOLVE_FRAME && sender.tab?.id != null) {
    const frameOrigin = typeof msg.origin === "string" ? msg.origin : "";
    resolveVolumeFromStorage(sender.tab.id, frameOrigin, (volume) => {
      sendResponse({ volume });
    });
    return true;
  }

  if (msg?.type === MSG_RESOLVE_TAB && msg.tabId != null && !Number.isNaN(Number(msg.tabId))) {
    const tabId = Number(msg.tabId);
    let origin = "";
    try {
      origin = new URL(msg.topUrl || "").origin;
    } catch {
      origin = "";
    }
    resolveVolumeFromStorage(tabId, origin, (volume) => {
      sendResponse({ volume });
    });
    return true;
  }

  return false;
});
