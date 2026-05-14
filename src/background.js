const STORAGE_KEY_TABS = "ssc_saved_tab_volumes";
const STORAGE_KEY_URLS = "ssc_saved_url_volumes";
const STORAGE_KEY_ACCENT = "ssc_accent";
const STORAGE_KEY_LIVE = "ssc_live_tab_volume";
const STORAGE_KEY_TAB_CAPTURE = "ssc_tab_capture_enabled";

const MSG_RESOLVE_FRAME = "SSC_RESOLVE_VOLUME";
const MSG_RESOLVE_TAB = "SSC_RESOLVE_VOLUME_FOR_TAB";
const MSG_REFRESH_TOOLBAR = "SSC_REFRESH_TOOLBAR";
const MSG_TAB_CAPTURE_ENGAGE = "SSC_TAB_CAPTURE_ENGAGE";
const MSG_TAB_CAPTURE_GAIN = "SSC_TAB_CAPTURE_GAIN";
const MSG_TAB_CAPTURE_RELEASE = "SSC_TAB_CAPTURE_RELEASE";
const MSG_TAB_CAPTURE_RELEASE_ALL = "SSC_TAB_CAPTURE_RELEASE_ALL";
const MSG_TAB_CAPTURE_QUERY = "SSC_TAB_CAPTURE_QUERY";
const MSG_OFFSCREEN_START = "SSC_OFFSCREEN_START";
const MSG_OFFSCREEN_GAIN = "SSC_OFFSCREEN_GAIN";
const MSG_OFFSCREEN_STOP = "SSC_OFFSCREEN_STOP";
const MSG_PASSTHROUGH_MODE = "SSC_PASSTHROUGH_MODE";

const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_REASONS = ["AUDIO_PLAYBACK"];
const OFFSCREEN_JUSTIFICATION =
  "Apply per-tab volume gain to captured tab audio (Tab Capture mode).";

/**
 * In-memory record of every tab currently routed through Tab Capture mode.
 * Keys are tabIds. Values include the user's pre-capture mute state so we can
 * restore it cleanly on release without trampling a manual user mute.
 * @type {Map<number, { wasMuted: boolean, percent: number }>}
 */
const capturedTabs = new Map();

/**
 * Last known origin per tab. Lets `tabs.onUpdated` distinguish a real
 * cross-origin navigation (which should reset per-tab state) from an
 * in-app SPA route change (Google Meet's `pushState`, YouTube's history
 * navigation, etc., which should NOT reset state).
 *
 * @type {Map<number, string>}
 */
const lastOriginByTab = new Map();

function originOfUrl(url) {
  if (typeof url !== "string" || url === "") return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Seed `lastOriginByTab` from currently open tabs at SW startup/install. */
function seedLastOrigins(done) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) {
      done?.();
      return;
    }
    for (const t of Array.isArray(tabs) ? tabs : []) {
      if (t && t.id != null && typeof t.url === "string") {
        lastOriginByTab.set(Number(t.id), originOfUrl(t.url));
      }
    }
    done?.();
  });
}

/** Serialize concurrent offscreen-document creation attempts. */
let offscreenCreatingPromise = null;

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
 * Pinned origin beats default. Persistent tab-specific overrides are legacy
 * and intentionally ignored; live per-tab volume still wins in
 * `resolveEffectiveVolume` for the current browser session.
 *
 * @param {string} frameOrigin
 */
function resolveVolumeFromLists(_tabsList, urlsList, _tabId, frameOrigin) {
  const urls = Array.isArray(urlsList) ? urlsList : [];

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

  const urls = Array.isArray(result[STORAGE_KEY_URLS]) ? result[STORAGE_KEY_URLS] : [];
  return resolveVolumeFromLists([], urls, tabId, frameOrigin);
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
  lastOriginByTab.delete(Number(tabId));
  // The tab is gone, so no source-tab unmute needed; just clear our state and
  // the offscreen chain.
  if (capturedTabs.has(Number(tabId))) {
    capturedTabs.delete(Number(tabId));
    void sendOffscreenStop(tabId).then(() => {
      void maybeCloseOffscreen();
    });
    void notifyContentScript(tabId, false);
  }
});

/* ----------------------------- Tab Capture mode ----------------------------- */

/**
 * @returns {Promise<boolean>} true once an offscreen document hosting the
 * audio chain exists and is reachable. False if the API isn't available
 * (Firefox) or the user hasn't granted the optional permission.
 *
 * The `SSC_FIREFOX_STRIP_*` markers are honored by `scripts/build.mjs`: the
 * Chrome dist gets the real offscreen-document orchestration, the Firefox
 * dist gets a hard `false` stub (so no `chrome.offscreen.*` /
 * `chrome.runtime.getContexts` reference reaches the AMO static analyzer).
 * Tab Capture mode is then inert on Firefox — `engageCapture` short-circuits
 * on `if (!ready) return ...`.
 */
// SSC_FIREFOX_STRIP_BEGIN
async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  if (!chrome.runtime?.getContexts) {
    // Older Chrome without getContexts: try create + swallow "already exists".
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } catch (err) {
      if (!String(err?.message || err).includes("Only a single offscreen")) {
        return false;
      }
    }
    return true;
  }
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (Array.isArray(existing) && existing.length > 0) return true;
  if (offscreenCreatingPromise) {
    try {
      await offscreenCreatingPromise;
    } catch {
      // ignore
    }
    return true;
  }
  offscreenCreatingPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: OFFSCREEN_REASONS,
    justification: OFFSCREEN_JUSTIFICATION,
  });
  try {
    await offscreenCreatingPromise;
  } catch (err) {
    if (!String(err?.message || err).includes("Only a single offscreen")) {
      offscreenCreatingPromise = null;
      return false;
    }
  }
  offscreenCreatingPromise = null;
  return true;
}
// SSC_FIREFOX_STRIP_ELSE
async function ensureOffscreen() {
  return false;
}
// SSC_FIREFOX_STRIP_END

/** Close the offscreen document if no captures remain. Cheap to call often. */
// SSC_FIREFOX_STRIP_BEGIN
async function maybeCloseOffscreen() {
  if (!chrome.offscreen?.closeDocument) return;
  if (capturedTabs.size > 0) return;
  if (!chrome.runtime?.getContexts) return;
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (!Array.isArray(existing) || existing.length === 0) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // ignore
  }
}
// SSC_FIREFOX_STRIP_ELSE
async function maybeCloseOffscreen() {}
// SSC_FIREFOX_STRIP_END

async function sendOffscreenStart(tabId, streamId, percent) {
  try {
    return await chrome.runtime.sendMessage({
      type: MSG_OFFSCREEN_START,
      tabId: Number(tabId),
      streamId,
      percent: Number(percent),
    });
  } catch {
    return { ok: false };
  }
}

async function sendOffscreenGain(tabId, percent) {
  try {
    return await chrome.runtime.sendMessage({
      type: MSG_OFFSCREEN_GAIN,
      tabId: Number(tabId),
      percent: Number(percent),
    });
  } catch {
    return { ok: false };
  }
}

async function sendOffscreenStop(tabId) {
  try {
    return await chrome.runtime.sendMessage({
      type: MSG_OFFSCREEN_STOP,
      tabId: Number(tabId),
    });
  } catch {
    return { ok: false };
  }
}

async function notifyContentScript(tabId, enabled) {
  try {
    await chrome.tabs.sendMessage(Number(tabId), {
      type: MSG_PASSTHROUGH_MODE,
      enabled: Boolean(enabled),
    });
  } catch {
    // Content script may not be present (chrome:// page, etc.); harmless.
  }
}

/**
 * Mute the source tab so the user only hears the gain-modified copy coming
 * out of the offscreen AudioContext (avoid double playback). Snapshots the
 * tab's prior mute state so {@link releaseCapture} can restore it.
 */
async function muteSourceTab(tabId) {
  let wasMuted = false;
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    wasMuted = Boolean(tab?.mutedInfo?.muted);
  } catch {
    // ignore
  }
  try {
    await chrome.tabs.update(Number(tabId), { muted: true });
  } catch {
    // ignore
  }
  return wasMuted;
}

async function restoreSourceTabMute(tabId, wasMuted) {
  if (wasMuted) return;
  try {
    await chrome.tabs.update(Number(tabId), { muted: false });
  } catch {
    // ignore
  }
}

/**
 * Engage Tab Capture for `tabId` with the supplied media stream id (which
 * must have been freshly minted from a popup user gesture). Idempotent —
 * if the tab is already captured, just updates the gain.
 */
async function engageCapture(tabId, streamId, percent) {
  const tid = Number(tabId);
  if (Number.isNaN(tid)) return { ok: false, error: "bad tabId" };

  const existing = capturedTabs.get(tid);
  if (existing) {
    existing.percent = Number(percent);
    capturedTabs.set(tid, existing);
    await sendOffscreenGain(tid, percent);
    return { ok: true, alreadyCaptured: true };
  }

  const ready = await ensureOffscreen();
  if (!ready) return { ok: false, error: "offscreen unavailable" };

  const startResp = await sendOffscreenStart(tid, streamId, percent);
  if (!startResp?.ok) {
    return { ok: false, error: startResp?.error || "offscreen start failed" };
  }

  const wasMuted = await muteSourceTab(tid);
  capturedTabs.set(tid, { wasMuted, percent: Number(percent) });
  void notifyContentScript(tid, true);
  return { ok: true };
}

async function setCaptureGain(tabId, percent) {
  const tid = Number(tabId);
  const rec = capturedTabs.get(tid);
  if (!rec) return { ok: false, error: "not captured" };
  rec.percent = Number(percent);
  capturedTabs.set(tid, rec);
  await sendOffscreenGain(tid, percent);
  return { ok: true };
}

async function releaseCapture(tabId) {
  const tid = Number(tabId);
  const rec = capturedTabs.get(tid);
  if (!rec) return { ok: true, wasCaptured: false };
  capturedTabs.delete(tid);
  await sendOffscreenStop(tid);
  await restoreSourceTabMute(tid, rec.wasMuted);
  void notifyContentScript(tid, false);
  await maybeCloseOffscreen();
  return { ok: true, wasCaptured: true };
}

async function releaseAllCaptures() {
  const ids = Array.from(capturedTabs.keys());
  for (const id of ids) {
    await releaseCapture(id);
  }
  return { ok: true, released: ids.length };
}

// If the user disables Tab Capture mode globally via storage, drop everything.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const change = changes[STORAGE_KEY_TAB_CAPTURE];
  if (!change) return;
  if (change.newValue === false || change.newValue === undefined) {
    void releaseAllCaptures();
  }
});

/**
 * Drops saved-tab + live-volume rows whose tabIds don't exist in the current
 * window session. Tab IDs aren't stable across browser restarts, so without
 * this every restart leaves dead rows in the Saved Tabs list.
 */
function reconcileSavedTabsWithOpenWindows(done) {
  chrome.tabs.query({}, (openTabs) => {
    if (chrome.runtime.lastError) {
      done?.();
      return;
    }
    const live = new Set(
      (Array.isArray(openTabs) ? openTabs : [])
        .map((t) => Number(t?.id))
        .filter((n) => !Number.isNaN(n))
    );

    chrome.storage.local.get([STORAGE_KEY_TABS, STORAGE_KEY_LIVE], (result) => {
      if (chrome.runtime.lastError) {
        done?.();
        return;
      }
      const { list: normalized, changed: didNormalize } = normalizeTabEntries(
        result[STORAGE_KEY_TABS]
      );
      const filteredTabs = normalized.filter((row) => {
        if (row == null || typeof row !== "object") return true;
        const tid = Number(row.tabId);
        if (Number.isNaN(tid)) return true;
        return live.has(tid);
      });
      const tabsChanged = didNormalize || filteredTabs.length !== normalized.length;

      const prevLive = result[STORAGE_KEY_LIVE];
      const liveMap =
        prevLive !== null && typeof prevLive === "object" && !Array.isArray(prevLive)
          ? { ...prevLive }
          : {};
      let liveChanged = false;
      for (const key of Object.keys(liveMap)) {
        if (!live.has(Number(key))) {
          delete liveMap[key];
          liveChanged = true;
        }
      }

      const updates = {};
      if (tabsChanged) updates[STORAGE_KEY_TABS] = filteredTabs;
      if (liveChanged) updates[STORAGE_KEY_LIVE] = liveMap;
      if (Object.keys(updates).length === 0) {
        done?.();
        return;
      }
      chrome.storage.local.set(updates, () => {
        void chrome.runtime?.lastError;
        done?.();
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  seedLastOrigins(() => {
    reconcileSavedTabsWithOpenWindows(() => scheduleToolbarRefresh());
  });
});

chrome.runtime.onStartup.addListener(() => {
  seedLastOrigins(() => {
    reconcileSavedTabsWithOpenWindows(() => scheduleToolbarRefresh());
  });
});

chrome.tabs.onActivated.addListener(() => {
  scheduleToolbarRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === "string") {
    const newOrigin = originOfUrl(changeInfo.url);
    const prevOrigin = lastOriginByTab.get(Number(tabId)) || "";
    lastOriginByTab.set(Number(tabId), newOrigin);

    // SPA route changes (Google Meet pushState, YouTube watch-page transitions,
    // any history.pushState within the same site) fire `tabs.onUpdated` with
    // `changeInfo.url` even though no real navigation occurred. Treating them
    // as navigation wipes the user's per-tab volume and tears down any active
    // Tab Capture chain — that's what was causing volume to "auto-correct" back
    // to 100% on Meet after ~60s. Only react when the origin actually changed.
    const isCrossOrigin = prevOrigin !== "" && prevOrigin !== newOrigin;
    if (isCrossOrigin) {
      removeLiveVolumeForTab(tabId, () => scheduleToolbarRefresh());
      if (capturedTabs.has(Number(tabId))) {
        void releaseCapture(tabId);
      }
    } else {
      // Same-origin URL update: keep state intact, just nudge the toolbar.
      scheduleToolbarRefresh();
    }
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

  if (msg?.type === MSG_TAB_CAPTURE_ENGAGE) {
    engageCapture(msg.tabId, msg.streamId, msg.percent).then(sendResponse);
    return true;
  }

  if (msg?.type === MSG_TAB_CAPTURE_GAIN) {
    setCaptureGain(msg.tabId, msg.percent).then(sendResponse);
    return true;
  }

  if (msg?.type === MSG_TAB_CAPTURE_RELEASE) {
    releaseCapture(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg?.type === MSG_TAB_CAPTURE_RELEASE_ALL) {
    releaseAllCaptures().then(sendResponse);
    return true;
  }

  if (msg?.type === MSG_TAB_CAPTURE_QUERY) {
    const tid = Number(msg.tabId);
    const rec = capturedTabs.get(tid);
    sendResponse({ ok: true, captured: Boolean(rec), percent: rec?.percent });
    return false;
  }

  return false;
});
