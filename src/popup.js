(() => {
  const STORAGE_KEYS = {
    theme: "ssc_theme",
    accent: "ssc_accent",
    saveToTab: "ssc_save_to_tab",
    saveToUrl: "ssc_save_to_url",
    lastQuickPreset: "ssc_last_quick_preset",
    savedTabVolumes: "ssc_saved_tab_volumes",
    savedUrlVolumes: "ssc_saved_url_volumes",
    liveTabVolume: "ssc_live_tab_volume",
    tabCaptureEnabled: "ssc_tab_capture_enabled",
  };

  /** Tab Capture API + the `permissions` API are both Chrome-only. */
  const HAS_TAB_CAPTURE =
    typeof chrome !== "undefined" &&
    Boolean(chrome.tabCapture?.getMediaStreamId) &&
    Boolean(chrome.permissions?.request);

  const TAB_CAPTURE_PERMISSIONS = { permissions: ["tabCapture", "offscreen"] };

  const ACCENTS = new Set([
    "purple",
    "blue",
    "orange",
    "red",
    "green",
    "teal",
    "seafoam",
    "yellow",
    "gray",
  ]);

  const THEMES = new Set(["dark", "light"]);

  const QUICK_PRESETS = new Set(["0", "20", "50", "100"]);

  const CONTENT_MSG_VOLUME = "SSC_SET_VOLUME";
  const MSG_RESOLVE_TAB = "SSC_RESOLVE_VOLUME_FOR_TAB";
  const MSG_REFRESH_TOOLBAR = "SSC_REFRESH_TOOLBAR";
  const MSG_TAB_CAPTURE_ENGAGE = "SSC_TAB_CAPTURE_ENGAGE";
  const MSG_TAB_CAPTURE_GAIN = "SSC_TAB_CAPTURE_GAIN";
  const MSG_TAB_CAPTURE_RELEASE = "SSC_TAB_CAPTURE_RELEASE";
  const MSG_TAB_CAPTURE_RELEASE_ALL = "SSC_TAB_CAPTURE_RELEASE_ALL";
  const MSG_TAB_CAPTURE_QUERY = "SSC_TAB_CAPTURE_QUERY";

  const screenMain = document.getElementById("screen-main");
  const screenSettings = document.getElementById("screen-settings");
  const slider = document.getElementById("volume-slider");
  const valueOut = document.getElementById("volume-value");
  const saveToTab = document.getElementById("save-to-tab");
  const saveToUrl = document.getElementById("save-to-url");
  const settingsOpen = document.getElementById("settings-open");
  const settingsClose = document.getElementById("settings-close");
  const accentSwatches = document.querySelectorAll(".accent-swatch");
  const themeButtons = document.querySelectorAll(".theme-option");
  const chipButtons = document.querySelectorAll(".chip[data-preset]");
  const savedSubtabs = document.querySelectorAll(".subtab[data-saved-panel]");
  const panelTabs = document.getElementById("panel-saved-tabs");
  const panelUrls = document.getElementById("panel-saved-urls");
  const listTabs = document.getElementById("saved-list-tabs");
  const listUrls = document.getElementById("saved-list-urls");
  const emptyTabs = document.getElementById("saved-empty-tabs");
  const emptyUrls = document.getElementById("saved-empty-urls");
  const tabCaptureToggle = document.getElementById("tab-capture-toggle");
  const tabCaptureSection = document.getElementById("tab-capture-section");
  const tabCaptureHint = document.getElementById("tab-capture-hint");

  let suppressQuickPresetClear = false;
  /** Whether Tab Capture is currently engaged for the active tab in this popup session. */
  let activeTabCaptured = false;
  /** Resolved at init: { id, url, isHttpx } for the active tab, or null on chrome:// pages. */
  let activeTabInfo = null;
  /** Mirror of `ssc_tab_capture_enabled` for cheap synchronous reads in event handlers. */
  let tabCaptureEnabled = false;

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!chrome.storage?.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get(keys, (result) => {
        void chrome.runtime?.lastError;
        resolve(result || {});
      });
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      if (!chrome.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set(obj, () => {
        void chrome.runtime?.lastError;
        resolve();
      });
    });
  }

  function setSliderVisualPercent(percent) {
    slider.style.setProperty("--track-fill", `${percent}%`);
  }

  function updateFromSlider() {
    const v = Number(slider.value);
    valueOut.textContent = `${v}%`;
    slider.setAttribute("aria-valuenow", String(v));
    slider.setAttribute("aria-valuetext", `${v} percent`);
    setSliderVisualPercent((v / 400) * 100);
  }

  function applyTheme(theme) {
    const t = THEMES.has(theme) ? theme : "dark";
    document.documentElement.setAttribute("data-theme", t);
    themeButtons.forEach((btn) => {
      const active = btn.getAttribute("data-theme") === t;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function applyAccent(accent) {
    const a = ACCENTS.has(accent) ? accent : "purple";
    document.documentElement.setAttribute("data-accent", a);
    accentSwatches.forEach((sw) => {
      sw.setAttribute("aria-selected", sw.getAttribute("data-accent") === a ? "true" : "false");
    });
  }

  function applyQuickPresetHighlight(presetOrNull) {
    chipButtons.forEach((chip) => {
      const p = chip.getAttribute("data-preset");
      chip.classList.toggle("chip--quick-selected", presetOrNull !== null && p === presetOrNull);
    });
  }

  async function setLastQuickPreset(presetOrNull) {
    applyQuickPresetHighlight(presetOrNull);
    await storageSet({
      [STORAGE_KEYS.lastQuickPreset]: presetOrNull,
    });
  }

  /**
   * @param {number} tabId
   * @param {string} topUrl
   * @returns {Promise<number>}
   */
  async function resolveVolumeForTab(tabId, topUrl) {
    try {
      const r = await chrome.runtime.sendMessage({
        type: MSG_RESOLVE_TAB,
        tabId,
        topUrl: topUrl || "",
      });
      if (typeof r?.volume === "number") return r.volume;
    } catch {
      /* service worker inactive or message failed */
    }
    return 100;
  }

  /**
   * Remember last applied boost for this tab (toolbar dot + resolve). Clears entry at 100%.
   * @param {number} percent
   */
  async function recordLiveVolumeForActiveTab(percent) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tabs[0]?.id;
    const url = tabs[0]?.url || "";
    if (id === undefined || !/^https?:/i.test(url)) return;

    const key = STORAGE_KEYS.liveTabVolume;
    const data = await storageGet([key]);
    const raw = data[key];
    const map =
      raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
    const v = Math.max(0, Math.min(400, Math.round(Number(percent))));
    if (v === 100) {
      delete map[String(id)];
    } else {
      map[String(id)] = v;
    }
    await storageSet({ [key]: map });
    try {
      await chrome.runtime.sendMessage({ type: MSG_REFRESH_TOOLBAR });
    } catch {
      /* SW may be asleep; storage listener still refreshes toolbar */
    }
  }

  /**
   * @param {number} volume
   */
  async function upsertTabRow(tabId, tabUrl, title, volume) {
    const key = STORAGE_KEYS.savedTabVolumes;
    const data = await storageGet([key]);
    const list = Array.isArray(data[key]) ? [...data[key]] : [];
    const id = String(tabId);
    const v = Math.max(0, Math.min(400, Math.round(Number(volume))));
    const idx = list.findIndex(
      (r) => Number(r.tabId) === Number(tabId) || String(r.id) === id
    );
    const row = {
      id,
      tabId: Number(tabId),
      title: title || `Tab ${tabId}`,
      tabUrl: tabUrl || "",
      volume: v,
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push(row);
    await storageSet({ [key]: list });
  }

  /**
   * @param {string} origin
   * @param {string} tabUrl
   * @param {string} title
   * @param {number} volume
   */
  async function upsertOriginRow(origin, tabUrl, title, volume) {
    if (!origin) return;
    const key = STORAGE_KEYS.savedUrlVolumes;
    const data = await storageGet([key]);
    const list = Array.isArray(data[key]) ? [...data[key]] : [];
    const id = `origin:${origin}`;
    const v = Math.max(0, Math.min(400, Math.round(Number(volume))));
    const idx = list.findIndex((r) => r.origin === origin || String(r.id) === id);
    const row = {
      id,
      origin,
      url: tabUrl || "",
      title: title || origin,
      volume: v,
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push(row);
    await storageSet({ [key]: list });
  }

  async function persistScopedOverrides(volume) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs[0];
    if (!t?.id) return;
    const topUrl = t.url || "";
    if (!/^https?:/i.test(topUrl)) return;

    let origin = "";
    try {
      origin = new URL(topUrl).origin;
    } catch {
      origin = "";
    }

    if (saveToTab.checked) {
      await upsertTabRow(t.id, topUrl, t.title || "", volume);
    }
    if (saveToUrl.checked && origin) {
      await upsertOriginRow(origin, topUrl, t.title || "", volume);
    }
  }

  /* --------------------------- Tab Capture helpers --------------------------- */

  function isHttpxUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }

  async function bgSend(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch {
      return null;
    }
  }

  async function queryActiveTabCaptured(tabId) {
    if (!HAS_TAB_CAPTURE || tabId == null) return false;
    const r = await bgSend({ type: MSG_TAB_CAPTURE_QUERY, tabId });
    return Boolean(r?.captured);
  }

  /**
   * Engage or update Tab Capture for the active tab. Must be invoked from a
   * user-gesture context (slider input, chip click, toggle change, popup open
   * from action click) so that `getMediaStreamId` is permitted.
   *
   * Idempotent: if the tab is already captured we just push the new gain.
   *
   * @param {number} tabId
   * @param {number} percent
   * @returns {Promise<boolean>} true on success
   */
  async function engageOrUpdateCapture(tabId, percent) {
    if (!HAS_TAB_CAPTURE || tabId == null) return false;
    if (activeTabCaptured) {
      const r = await bgSend({ type: MSG_TAB_CAPTURE_GAIN, tabId, percent });
      return Boolean(r?.ok);
    }
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch {
      return false;
    }
    if (!streamId) return false;
    const r = await bgSend({
      type: MSG_TAB_CAPTURE_ENGAGE,
      tabId,
      streamId,
      percent,
    });
    if (r?.ok) {
      activeTabCaptured = true;
      return true;
    }
    return false;
  }

  async function releaseActiveTabCapture(tabId) {
    if (!HAS_TAB_CAPTURE || tabId == null) return;
    if (!activeTabCaptured) return;
    await bgSend({ type: MSG_TAB_CAPTURE_RELEASE, tabId });
    activeTabCaptured = false;
  }

  /**
   * Reconcile capture state to the desired `percent` for the active tab,
   * given the current `tabCaptureEnabled` setting. Engages, gain-updates, or
   * releases as appropriate.
   * @param {number} percent
   */
  async function reconcileCaptureForActiveTab(percent) {
    if (!HAS_TAB_CAPTURE) return;
    if (!activeTabInfo?.id || !activeTabInfo.isHttpx) return;
    if (!tabCaptureEnabled) {
      if (activeTabCaptured) {
        await releaseActiveTabCapture(activeTabInfo.id);
      }
      return;
    }
    const v = Number(percent);
    if (v === 100) {
      if (activeTabCaptured) {
        await releaseActiveTabCapture(activeTabInfo.id);
      }
      return;
    }
    await engageOrUpdateCapture(activeTabInfo.id, v);
  }

  /**
   * Push gain to the current tab’s content script(s) on http/https.
   * `chrome.tabs.sendMessage(tabId, payload)` (no `frameId`) broadcasts to all
   * frames in the tab since Chrome 75 and Firefox 50, so per-frame enumeration
   * is unnecessary and `webNavigation` is not required.
   * @param {number} percent
   */
  async function pushVolumeToActiveTab(percent) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId === undefined) return;
      const payload = { type: CONTENT_MSG_VOLUME, percent: Number(percent) };
      await chrome.tabs.sendMessage(tabId, payload).catch(() => {});
    } catch {
      /* No receiver */
    }
  }

  async function refreshSliderFromResolvedVolume() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs[0];
    if (!t?.id) return;
    const vol = await resolveVolumeForTab(t.id, t.url || "");
    slider.value = String(vol);
    updateFromSlider();
    await pushVolumeToActiveTab(vol);
  }

  function showMainScreen() {
    screenMain.hidden = false;
    screenSettings.hidden = true;
    settingsOpen.setAttribute("aria-expanded", "false");
    settingsOpen.focus();
  }

  function showSettingsScreen() {
    screenMain.hidden = true;
    screenSettings.hidden = false;
    settingsOpen.setAttribute("aria-expanded", "true");
    settingsClose.focus();
  }

  function renderSavedList(ul, items, type) {
    ul.replaceChildren();
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "saved-row";
      li.dataset.id = item.id;

      const main = document.createElement("div");
      main.className = "saved-row-main";

      const title = document.createElement("div");
      title.className = "saved-row-title";
      title.textContent =
        item.title || (type === "tabs" ? "Saved tab" : item.origin || item.url || "Saved URL");

      const meta = document.createElement("div");
      meta.className = "saved-row-meta";
      meta.textContent =
        type === "urls" && item.url && item.title
          ? `${item.volume}% · ${item.url}`
          : `${item.volume}%`;

      main.append(title, meta);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "saved-delete";
      del.title = "Remove";
      del.dataset.deleteType = type;
      del.dataset.deleteId = item.id;
      del.innerHTML =
        '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M9 3v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3H9zm0 5h2v9H9V8zm4 0h2v9h-2V8z"/>' +
        '</svg><span class="visually-hidden">Delete</span>';

      li.append(main, del);
      ul.append(li);
    });
  }

  async function loadSavedLists() {
    const data = await storageGet([STORAGE_KEYS.savedTabVolumes, STORAGE_KEYS.savedUrlVolumes]);
    const tabs = Array.isArray(data[STORAGE_KEYS.savedTabVolumes])
      ? data[STORAGE_KEYS.savedTabVolumes]
      : [];
    const urls = Array.isArray(data[STORAGE_KEYS.savedUrlVolumes])
      ? data[STORAGE_KEYS.savedUrlVolumes]
      : [];

    renderSavedList(listTabs, tabs, "tabs");
    renderSavedList(listUrls, urls, "urls");

    emptyTabs.hidden = tabs.length > 0;
    emptyUrls.hidden = urls.length > 0;
  }

  async function deleteSaved(type, id) {
    const key =
      type === "tabs" ? STORAGE_KEYS.savedTabVolumes : STORAGE_KEYS.savedUrlVolumes;
    const data = await storageGet([key]);
    const list = Array.isArray(data[key]) ? data[key] : [];
    const next = list.filter((row) => row.id !== id);
    await storageSet({ [key]: next });
    await loadSavedLists();
    await refreshSliderFromResolvedVolume();
  }

  slider.addEventListener("input", async () => {
    updateFromSlider();
    const v = Number(slider.value);
    await persistScopedOverrides(v);
    await pushVolumeToActiveTab(v);
    await recordLiveVolumeForActiveTab(v);
    await reconcileCaptureForActiveTab(v);
    if (!suppressQuickPresetClear) {
      await setLastQuickPreset(null);
    }
  });

  chipButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const preset = btn.getAttribute("data-preset");
      suppressQuickPresetClear = true;
      slider.value = btn.getAttribute("data-volume");
      updateFromSlider();
      const v = Number(slider.value);
      await persistScopedOverrides(v);
      await pushVolumeToActiveTab(v);
      await recordLiveVolumeForActiveTab(v);
      await reconcileCaptureForActiveTab(v);
      await setLastQuickPreset(QUICK_PRESETS.has(preset) ? preset : null);
      requestAnimationFrame(() => {
        suppressQuickPresetClear = false;
      });
    });
  });

  settingsOpen.addEventListener("click", () => {
    showSettingsScreen();
    loadSavedLists();
  });

  settingsClose.addEventListener("click", () => {
    showMainScreen();
  });

  accentSwatches.forEach((sw) => {
    sw.addEventListener("click", async () => {
      const accent = sw.getAttribute("data-accent");
      if (!ACCENTS.has(accent)) return;
      applyAccent(accent);
      await storageSet({ [STORAGE_KEYS.accent]: accent });
    });
  });

  themeButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const theme = btn.getAttribute("data-theme");
      if (!THEMES.has(theme)) return;
      applyTheme(theme);
      await storageSet({ [STORAGE_KEYS.theme]: theme });
    });
  });

  saveToTab.addEventListener("change", () => {
    storageSet({ [STORAGE_KEYS.saveToTab]: saveToTab.checked });
  });

  saveToUrl.addEventListener("change", () => {
    storageSet({ [STORAGE_KEYS.saveToUrl]: saveToUrl.checked });
  });

  function setTabCaptureUnavailable(reason) {
    if (!tabCaptureToggle || !tabCaptureSection) return;
    tabCaptureToggle.checked = false;
    tabCaptureToggle.disabled = true;
    const row = tabCaptureSection.querySelector(".switch-row");
    if (row) row.classList.add("is-disabled");
    if (tabCaptureHint && reason) tabCaptureHint.textContent = reason;
  }

  if (!HAS_TAB_CAPTURE) {
    setTabCaptureUnavailable(
      "Tab Capture mode requires Chrome's tabCapture API and is not available in this browser."
    );
  } else if (tabCaptureToggle) {
    tabCaptureToggle.addEventListener("change", async () => {
      const wantOn = Boolean(tabCaptureToggle.checked);
      if (wantOn) {
        let granted = false;
        try {
          granted = await chrome.permissions.request(TAB_CAPTURE_PERMISSIONS);
        } catch {
          granted = false;
        }
        if (!granted) {
          tabCaptureToggle.checked = false;
          tabCaptureEnabled = false;
          await storageSet({ [STORAGE_KEYS.tabCaptureEnabled]: false });
          return;
        }
        tabCaptureEnabled = true;
        await storageSet({ [STORAGE_KEYS.tabCaptureEnabled]: true });
        await reconcileCaptureForActiveTab(Number(slider.value));
      } else {
        tabCaptureEnabled = false;
        await storageSet({ [STORAGE_KEYS.tabCaptureEnabled]: false });
        // Background's storage listener releases all captures globally;
        // mirror that locally so the popup state agrees immediately.
        activeTabCaptured = false;
        await bgSend({ type: MSG_TAB_CAPTURE_RELEASE_ALL });
      }
    });
  }

  savedSubtabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const panel = tab.getAttribute("data-saved-panel");
      savedSubtabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      const showTabs = panel === "tabs";
      panelTabs.hidden = !showTabs;
      panelUrls.hidden = showTabs;
    });
  });

  document.body.addEventListener("click", (e) => {
    const del = e.target.closest(".saved-delete");
    if (!del) return;
    const type = del.dataset.deleteType;
    const id = del.dataset.deleteId;
    if (type && id) {
      deleteSaved(type, id);
    }
  });

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (
        changes[STORAGE_KEYS.savedTabVolumes] ||
        changes[STORAGE_KEYS.savedUrlVolumes] ||
        changes[STORAGE_KEYS.liveTabVolume]
      ) {
        loadSavedLists();
        refreshSliderFromResolvedVolume();
      }
    });
  }

  (async function init() {
    const data = await storageGet([
      STORAGE_KEYS.theme,
      STORAGE_KEYS.accent,
      STORAGE_KEYS.saveToTab,
      STORAGE_KEYS.saveToUrl,
      STORAGE_KEYS.lastQuickPreset,
      STORAGE_KEYS.savedTabVolumes,
      STORAGE_KEYS.savedUrlVolumes,
      STORAGE_KEYS.tabCaptureEnabled,
    ]);

    const theme = THEMES.has(data[STORAGE_KEYS.theme]) ? data[STORAGE_KEYS.theme] : "dark";
    applyTheme(theme);

    const accent = ACCENTS.has(data[STORAGE_KEYS.accent]) ? data[STORAGE_KEYS.accent] : "purple";
    applyAccent(accent);

    saveToTab.checked = Boolean(data[STORAGE_KEYS.saveToTab]);
    saveToUrl.checked = Boolean(data[STORAGE_KEYS.saveToUrl]);

    if (HAS_TAB_CAPTURE && tabCaptureToggle) {
      // Reflect the saved preference but only if the optional permission is
      // actually granted right now — the user could have revoked it between
      // popup sessions via chrome://extensions.
      let permissionGranted = false;
      try {
        permissionGranted = await chrome.permissions.contains(TAB_CAPTURE_PERMISSIONS);
      } catch {
        permissionGranted = false;
      }
      tabCaptureEnabled = Boolean(data[STORAGE_KEYS.tabCaptureEnabled]) && permissionGranted;
      tabCaptureToggle.checked = tabCaptureEnabled;
      if (tabCaptureEnabled !== Boolean(data[STORAGE_KEYS.tabCaptureEnabled])) {
        // Storage drifted (permission was revoked); reconcile.
        await storageSet({ [STORAGE_KEYS.tabCaptureEnabled]: tabCaptureEnabled });
      }
    }

    const tabsQ = await chrome.tabs.query({ active: true, currentWindow: true });
    const t0 = tabsQ[0];
    let effective = 100;
    if (t0?.id) {
      effective = await resolveVolumeForTab(t0.id, t0.url || "");
      activeTabInfo = {
        id: t0.id,
        url: t0.url || "",
        isHttpx: isHttpxUrl(t0.url || ""),
      };
      activeTabCaptured = await queryActiveTabCaptured(t0.id);
    }
    slider.value = String(effective);
    updateFromSlider();
    await pushVolumeToActiveTab(effective);
    // Popup open is itself a user-gesture context, so this is a legal place to
    // call `getMediaStreamId` if Tab Capture mode is on and the resolved level
    // already differs from default — gives the seamless engage-on-open feel.
    await reconcileCaptureForActiveTab(effective);
    try {
      await chrome.runtime.sendMessage({ type: MSG_REFRESH_TOOLBAR });
    } catch {
      /* ignore */
    }

    const last = data[STORAGE_KEYS.lastQuickPreset];
    if (typeof last === "string" && QUICK_PRESETS.has(last)) {
      applyQuickPresetHighlight(last);
    } else {
      applyQuickPresetHighlight(null);
    }

    if (!Array.isArray(data[STORAGE_KEYS.savedTabVolumes])) {
      await storageSet({ [STORAGE_KEYS.savedTabVolumes]: [] });
    }
    if (!Array.isArray(data[STORAGE_KEYS.savedUrlVolumes])) {
      await storageSet({ [STORAGE_KEYS.savedUrlVolumes]: [] });
    }
    const liveRaw = (await storageGet([STORAGE_KEYS.liveTabVolume]))[STORAGE_KEYS.liveTabVolume];
    if (liveRaw === undefined || liveRaw === null || typeof liveRaw !== "object" || Array.isArray(liveRaw)) {
      await storageSet({ [STORAGE_KEYS.liveTabVolume]: {} });
    }
    await loadSavedLists();
  })();
})();
