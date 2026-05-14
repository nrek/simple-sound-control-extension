(() => {
  const AUDIO_POLICY = window.SSCAudioPolicy;
  const PIN_POLICY = window.SSCPinPolicy;
  const STORAGE_KEYS = {
    theme: "ssc_theme",
    accent: "ssc_accent",
    lastQuickPreset: "ssc_last_quick_preset",
    savedUrlVolumes: "ssc_saved_url_volumes",
    liveTabVolume: "ssc_live_tab_volume",
    tabCaptureEnabled: "ssc_tab_capture_enabled",
  };

  /**
   * Tab Capture API + the `permissions` API are both Chrome-only. Defaults
   * to `false`; the assignment below is wrapped in `SSC_FIREFOX_STRIP_*`
   * markers honored by `scripts/build.mjs`. The Chrome dist keeps the real
   * feature-detection; the Firefox dist drops the assignment entirely so
   * no `chrome.tabCapture.*` reference reaches the AMO static analyzer.
   * `let` (vs. `const`) is a small price for never having two parallel
   * declarations of the same name visible to the IDE / TS service.
   */
  let HAS_TAB_CAPTURE = false;
  // SSC_FIREFOX_STRIP_BEGIN
  HAS_TAB_CAPTURE =
    typeof chrome !== "undefined" &&
    Boolean(chrome.tabCapture?.getMediaStreamId) &&
    Boolean(chrome.permissions?.request);
  // SSC_FIREFOX_STRIP_END

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
  const pinDomainToggle = document.getElementById("pin-domain-toggle");
  const pinDomainLabel = document.getElementById("pin-domain-label");
  const settingsOpen = document.getElementById("settings-open");
  const settingsClose = document.getElementById("settings-close");
  const accentSwatches = document.querySelectorAll(".accent-swatch");
  const themeButtons = document.querySelectorAll(".theme-option");
  const chipButtons = document.querySelectorAll(".chip[data-preset]");
  const pinnedFilter = document.getElementById("pinned-filter");
  const pinnedFilterToggle = document.getElementById("pinned-filter-toggle");
  const pinnedList = document.getElementById("pinned-list");
  const pinnedEmpty = document.getElementById("pinned-empty");
  const pinnedPagination = document.getElementById("pinned-pagination");
  const pinnedPrev = document.getElementById("pinned-prev");
  const pinnedNext = document.getElementById("pinned-next");
  const pinnedPageStatus = document.getElementById("pinned-page-status");
  const tabCaptureToggle = document.getElementById("tab-capture-toggle");
  const tabCaptureSection = document.getElementById("tab-capture-section");

  let suppressQuickPresetClear = false;
  /** Whether Tab Capture is currently engaged for the active tab in this popup session. */
  let activeTabCaptured = false;
  /** Resolved at init: { id, url, isHttpx } for the active tab, or null on chrome:// pages. */
  let activeTabInfo = null;
  let activeDomainOrigin = "";
  let pinnedPage = 1;
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

  async function getPinnedRows() {
    const data = await storageGet([STORAGE_KEYS.savedUrlVolumes]);
    return PIN_POLICY.normalizePinnedRows(data[STORAGE_KEYS.savedUrlVolumes]);
  }

  async function setPinnedRows(rows) {
    await storageSet({ [STORAGE_KEYS.savedUrlVolumes]: PIN_POLICY.normalizePinnedRows(rows) });
  }

  function updateActiveDomainPinLabel() {
    if (!pinDomainLabel) return;
    const domain = PIN_POLICY.domainLabelFromOrigin(activeDomainOrigin);
    pinDomainLabel.textContent = domain
      ? `Pin Settings: ${domain}`
      : "Pin Settings: this domain";
    if (pinDomainToggle) {
      pinDomainToggle.disabled = !domain;
    }
  }

  async function syncActiveDomainPinState(rowsOrNull) {
    if (!pinDomainToggle) return;
    const rows = rowsOrNull || (await getPinnedRows());
    pinDomainToggle.checked = Boolean(
      activeDomainOrigin && rows.some((row) => row.origin === activeDomainOrigin)
    );
  }

  async function persistPinnedLevelForActiveDomain(volume) {
    if (!pinDomainToggle?.checked || !activeDomainOrigin || !activeTabInfo?.isHttpx) return;
    const rows = await getPinnedRows();
    const next = PIN_POLICY.upsertPinnedLevel(rows, {
      origin: activeDomainOrigin,
      tabUrl: activeTabInfo.url || activeDomainOrigin,
      title: activeDomainOrigin,
      volume,
    });
    await setPinnedRows(next);
  }

  async function setActiveDomainPinned(enabled) {
    if (!activeDomainOrigin) return;
    const rows = await getPinnedRows();
    const next = enabled
      ? PIN_POLICY.upsertPinnedLevel(rows, {
          origin: activeDomainOrigin,
          tabUrl: activeTabInfo?.url || activeDomainOrigin,
          title: activeDomainOrigin,
          volume: Number(slider.value),
        })
      : PIN_POLICY.removePinnedLevel(rows, activeDomainOrigin);
    await setPinnedRows(next);
    pinnedPage = 1;
    await loadPinnedList(next);
    await syncActiveDomainPinState(next);
    try {
      await chrome.runtime.sendMessage({ type: MSG_REFRESH_TOOLBAR });
    } catch {
      /* ignore */
    }
  }

  /* --------------------------- Tab Capture helpers --------------------------- */

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

  async function ensureTabCapturePermission() {
    if (!HAS_TAB_CAPTURE) return false;
    try {
      if (await chrome.permissions.contains(TAB_CAPTURE_PERMISSIONS)) return true;
      const granted = await chrome.permissions.request(TAB_CAPTURE_PERMISSIONS);
      if (!granted) {
        tabCaptureEnabled = false;
        if (tabCaptureToggle) tabCaptureToggle.checked = false;
        await storageSet({ [STORAGE_KEYS.tabCaptureEnabled]: false });
      }
      return Boolean(granted);
    } catch {
      return false;
    }
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
    const permitted = await ensureTabCapturePermission();
    if (!permitted) return false;
    let streamId;
    // SSC_FIREFOX_STRIP_BEGIN
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch {
      return false;
    }
    // SSC_FIREFOX_STRIP_ELSE
    streamId = "";
    // SSC_FIREFOX_STRIP_END
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
    const wantsCapture = AUDIO_POLICY.shouldUseTabCapture({
      hasTabCapture: HAS_TAB_CAPTURE,
      tabCaptureEnabled,
      activeTabInfo,
      percent,
    });
    if (!HAS_TAB_CAPTURE || !activeTabInfo?.id || !activeTabInfo.isHttpx) {
      return { attempted: false, captured: false };
    }
    if (!tabCaptureEnabled) {
      if (activeTabCaptured) {
        await releaseActiveTabCapture(activeTabInfo.id);
      }
      return { attempted: false, captured: false };
    }
    const v = Number(percent);
    if (!wantsCapture) {
      if (activeTabCaptured) {
        await releaseActiveTabCapture(activeTabInfo.id);
      }
      return { attempted: false, captured: false };
    }
    const captured = await engageOrUpdateCapture(activeTabInfo.id, v);
    return { attempted: true, captured };
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
    await applyVolumeToActiveTab(vol);
  }

  async function applyVolumeToActiveTab(percent) {
    const capture = await reconcileCaptureForActiveTab(percent);
    await recordLiveVolumeForActiveTab(percent);
    await persistPinnedLevelForActiveDomain(percent);
    if (
      AUDIO_POLICY.shouldPushContentVolume({
        percent,
        captureAttempted: capture.attempted,
        captureSucceeded: capture.captured,
      })
    ) {
      await pushVolumeToActiveTab(percent);
    }
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

  function renderPinnedList(rowsOrNull) {
    const rows = PIN_POLICY.normalizePinnedRows(rowsOrNull || []);
    const query = pinnedFilter?.value || "";
    const page = PIN_POLICY.paginatePinnedRows(rows, query, pinnedPage);
    pinnedPage = page.currentPage;
    pinnedList.replaceChildren();
    page.items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "saved-row";
      li.dataset.id = item.id;

      const main = document.createElement("div");
      main.className = "saved-row-main";

      const title = document.createElement("div");
      title.className = "saved-row-title";
      title.textContent = PIN_POLICY.domainLabelFromOrigin(item.origin);

      const meta = document.createElement("div");
      meta.className = "saved-row-meta";
      meta.textContent = `${item.volume}% · ${item.origin}`;

      main.append(title, meta);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "saved-delete";
      del.title = `Remove ${PIN_POLICY.domainLabelFromOrigin(item.origin)}`;
      del.dataset.deleteId = item.id;
      del.innerHTML =
        '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M9 3v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3H9zm0 5h2v9H9V8zm4 0h2v9h-2V8z"/>' +
        '</svg><span class="visually-hidden">Delete</span>';

      li.append(main, del);
      pinnedList.append(li);
    });

    pinnedEmpty.hidden = page.totalItems > 0;
    pinnedPagination.hidden = page.totalPages <= 1;
    pinnedPrev.disabled = page.currentPage <= 1;
    pinnedNext.disabled = page.currentPage >= page.totalPages;
    pinnedPageStatus.textContent = `Page ${page.currentPage} of ${page.totalPages}`;
  }

  async function loadPinnedList(rowsOrNull) {
    const rows = rowsOrNull || (await getPinnedRows());
    renderPinnedList(rows);
  }

  async function deletePinned(id) {
    const rows = await getPinnedRows();
    const next = PIN_POLICY.removePinnedLevel(rows, id);
    await setPinnedRows(next);
    pinnedPage = 1;
    await loadPinnedList(next);
    await syncActiveDomainPinState(next);
    await refreshSliderFromResolvedVolume();
  }

  slider.addEventListener("input", async () => {
    updateFromSlider();
    const v = Number(slider.value);
    await applyVolumeToActiveTab(v);
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
      await applyVolumeToActiveTab(v);
      await setLastQuickPreset(QUICK_PRESETS.has(preset) ? preset : null);
      requestAnimationFrame(() => {
        suppressQuickPresetClear = false;
      });
    });
  });

  settingsOpen.addEventListener("click", () => {
    showSettingsScreen();
    loadPinnedList();
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

  pinDomainToggle.addEventListener("change", async () => {
    await setActiveDomainPinned(pinDomainToggle.checked);
  });

  function hideTabCaptureSection() {
    if (!tabCaptureSection) return;
    tabCaptureSection.hidden = true;
    if (tabCaptureToggle) {
      tabCaptureToggle.checked = false;
      tabCaptureToggle.disabled = true;
    }
  }

  if (!HAS_TAB_CAPTURE) {
    // No `chrome.tabCapture` (Firefox, or Chrome before MV3 offscreen support).
    // Hide the whole settings block — there's nothing actionable for the user.
    hideTabCaptureSection();
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

  pinnedFilter.addEventListener("input", async () => {
    pinnedPage = 1;
    await loadPinnedList();
  });

  pinnedFilterToggle.addEventListener("click", () => {
    pinnedFilter.hidden = !pinnedFilter.hidden;
    pinnedFilterToggle.setAttribute("aria-expanded", pinnedFilter.hidden ? "false" : "true");
    if (!pinnedFilter.hidden) {
      pinnedFilter.focus();
    }
  });

  pinnedPrev.addEventListener("click", async () => {
    pinnedPage -= 1;
    await loadPinnedList();
  });

  pinnedNext.addEventListener("click", async () => {
    pinnedPage += 1;
    await loadPinnedList();
  });

  document.body.addEventListener("click", (e) => {
    const del = e.target.closest(".saved-delete");
    if (!del) return;
    const id = del.dataset.deleteId;
    if (id) {
      deletePinned(id);
    }
  });

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEYS.savedUrlVolumes]) {
        loadPinnedList();
        syncActiveDomainPinState();
      }
    });
  }

  (async function init() {
    const data = await storageGet([
      STORAGE_KEYS.theme,
      STORAGE_KEYS.accent,
      STORAGE_KEYS.lastQuickPreset,
      STORAGE_KEYS.savedUrlVolumes,
      STORAGE_KEYS.tabCaptureEnabled,
    ]);

    const theme = THEMES.has(data[STORAGE_KEYS.theme]) ? data[STORAGE_KEYS.theme] : "dark";
    applyTheme(theme);

    const accent = ACCENTS.has(data[STORAGE_KEYS.accent]) ? data[STORAGE_KEYS.accent] : "purple";
    applyAccent(accent);

    if (HAS_TAB_CAPTURE && tabCaptureToggle) {
      // Default to tab-level gain on Chrome. If permission has not been granted
      // yet, Chrome will ask from the next user-gesture volume change.
      tabCaptureEnabled = AUDIO_POLICY.resolveTabCapturePreference(data[STORAGE_KEYS.tabCaptureEnabled]);
      tabCaptureToggle.checked = tabCaptureEnabled;
      if (data[STORAGE_KEYS.tabCaptureEnabled] === undefined) {
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
        isHttpx: AUDIO_POLICY.isHttpxUrl(t0.url || ""),
      };
      activeDomainOrigin = PIN_POLICY.originFromUrl(t0.url || "");
      activeTabCaptured = await queryActiveTabCaptured(t0.id);
    }
    updateActiveDomainPinLabel();
    const pinnedRows = PIN_POLICY.normalizePinnedRows(data[STORAGE_KEYS.savedUrlVolumes]);
    await syncActiveDomainPinState(pinnedRows);
    slider.value = String(effective);
    updateFromSlider();
    // Popup open is itself a user-gesture context, so this is a legal place to
    // call `getMediaStreamId` if Tab Capture mode is on and the resolved level
    // already differs from default — gives the seamless engage-on-open feel.
    const capture = await reconcileCaptureForActiveTab(effective);
    if (
      AUDIO_POLICY.shouldPushContentVolume({
        percent: effective,
        captureAttempted: capture.attempted,
        captureSucceeded: capture.captured,
      })
    ) {
      await pushVolumeToActiveTab(effective);
    }
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

    if (!Array.isArray(data[STORAGE_KEYS.savedUrlVolumes])) {
      await storageSet({ [STORAGE_KEYS.savedUrlVolumes]: [] });
    }
    const liveRaw = (await storageGet([STORAGE_KEYS.liveTabVolume]))[STORAGE_KEYS.liveTabVolume];
    if (liveRaw === undefined || liveRaw === null || typeof liveRaw !== "object" || Array.isArray(liveRaw)) {
      await storageSet({ [STORAGE_KEYS.liveTabVolume]: {} });
    }
    await loadPinnedList(pinnedRows);
  })();
})();
