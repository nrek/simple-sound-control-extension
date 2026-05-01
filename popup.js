(() => {
  const STORAGE_KEYS = {
    accent: "ssc_accent",
    saveToTab: "ssc_save_to_tab",
    saveToUrl: "ssc_save_to_url",
    lastQuickPreset: "ssc_last_quick_preset",
    savedTabVolumes: "ssc_saved_tab_volumes",
    savedUrlVolumes: "ssc_saved_url_volumes",
    liveTabVolume: "ssc_live_tab_volume",
  };

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

  const QUICK_PRESETS = new Set(["0", "20", "50", "100"]);

  const CONTENT_MSG_VOLUME = "SSC_SET_VOLUME";
  const MSG_RESOLVE_TAB = "SSC_RESOLVE_VOLUME_FOR_TAB";
  const MSG_REFRESH_TOOLBAR = "SSC_REFRESH_TOOLBAR";

  const screenMain = document.getElementById("screen-main");
  const screenSettings = document.getElementById("screen-settings");
  const slider = document.getElementById("volume-slider");
  const valueOut = document.getElementById("volume-value");
  const saveToTab = document.getElementById("save-to-tab");
  const saveToUrl = document.getElementById("save-to-url");
  const settingsOpen = document.getElementById("settings-open");
  const settingsClose = document.getElementById("settings-close");
  const accentSwatches = document.querySelectorAll(".accent-swatch");
  const chipButtons = document.querySelectorAll(".chip[data-preset]");
  const savedSubtabs = document.querySelectorAll(".subtab[data-saved-panel]");
  const panelTabs = document.getElementById("panel-saved-tabs");
  const panelUrls = document.getElementById("panel-saved-urls");
  const listTabs = document.getElementById("saved-list-tabs");
  const listUrls = document.getElementById("saved-list-urls");
  const emptyTabs = document.getElementById("saved-empty-tabs");
  const emptyUrls = document.getElementById("saved-empty-urls");

  let suppressQuickPresetClear = false;

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

  /**
   * Push gain to the current tab’s content script(s) on http/https.
   * @param {number} percent
   */
  async function pushVolumeToActiveTab(percent) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId === undefined) return;
      const payload = { type: CONTENT_MSG_VOLUME, percent: Number(percent) };

      let frames = null;
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId });
      } catch {
        frames = null;
      }

      if (frames?.length) {
        await Promise.allSettled(
          frames.map((f) => {
            const fid = f.frameId;
            if (typeof fid !== "number") return Promise.resolve();
            return chrome.tabs.sendMessage(tabId, payload, { frameId: fid }).catch(() => {});
          })
        );
      } else {
        await chrome.tabs.sendMessage(tabId, payload).catch(() => {});
      }
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
        '<i class="fa-solid fa-trash" aria-hidden="true"></i><span class="visually-hidden">Delete</span>';

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
    await persistScopedOverrides(Number(slider.value));
    await pushVolumeToActiveTab(Number(slider.value));
    await recordLiveVolumeForActiveTab(Number(slider.value));
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
      await persistScopedOverrides(Number(slider.value));
      await pushVolumeToActiveTab(Number(slider.value));
      await recordLiveVolumeForActiveTab(Number(slider.value));
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

  saveToTab.addEventListener("change", () => {
    storageSet({ [STORAGE_KEYS.saveToTab]: saveToTab.checked });
  });

  saveToUrl.addEventListener("change", () => {
    storageSet({ [STORAGE_KEYS.saveToUrl]: saveToUrl.checked });
  });

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
      STORAGE_KEYS.accent,
      STORAGE_KEYS.saveToTab,
      STORAGE_KEYS.saveToUrl,
      STORAGE_KEYS.lastQuickPreset,
      STORAGE_KEYS.savedTabVolumes,
      STORAGE_KEYS.savedUrlVolumes,
    ]);

    const accent = ACCENTS.has(data[STORAGE_KEYS.accent]) ? data[STORAGE_KEYS.accent] : "purple";
    applyAccent(accent);

    saveToTab.checked = Boolean(data[STORAGE_KEYS.saveToTab]);
    saveToUrl.checked = Boolean(data[STORAGE_KEYS.saveToUrl]);

    const tabsQ = await chrome.tabs.query({ active: true, currentWindow: true });
    const t0 = tabsQ[0];
    let effective = 100;
    if (t0?.id) {
      effective = await resolveVolumeForTab(t0.id, t0.url || "");
    }
    slider.value = String(effective);
    updateFromSlider();
    await pushVolumeToActiveTab(effective);
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
