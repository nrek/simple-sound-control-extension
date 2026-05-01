(() => {
  const MSG_SET = "SSC_SET_VOLUME";
  const MSG_RESOLVE = "SSC_RESOLVE_VOLUME";

  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {GainNode | null} */
  let masterGain = null;
  const attached = new WeakSet();

  function ensureGraph() {
    if (ctx && masterGain) return;
    ctx = new AudioContext({ latencyHint: "interactive" });
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
  }

  function resumeIfNeeded() {
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  /**
   * @param {number} percent UI 0–400 (100 = unity gain)
   */
  function setVolumePercent(percent) {
    ensureGraph();
    const g = Math.max(0, Math.min(4, Number(percent) / 100));
    masterGain.gain.value = g;
    resumeIfNeeded();
  }

  /**
   * @param {HTMLMediaElement} el
   */
  function attachMedia(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (attached.has(el)) return;
    if (el.dataset.sscAttachFailed === "1") return;
    try {
      ensureGraph();
      const src = ctx.createMediaElementSource(el);
      src.connect(masterGain);
      attached.add(el);
    } catch {
      el.dataset.sscAttachFailed = "1";
    }
  }

  function scan(root) {
    root.querySelectorAll?.("video, audio").forEach((n) => attachMedia(n));
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        if (n instanceof HTMLMediaElement) attachMedia(n);
        else scan(n);
      });
    }
  });

  function pullResolvedVolume() {
    chrome.runtime.sendMessage(
      { type: MSG_RESOLVE, origin: location.origin },
      (resp) => {
        void chrome.runtime?.lastError;
        const v = typeof resp?.volume === "number" ? resp.volume : 100;
        setVolumePercent(v);
      }
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== MSG_SET) return false;
    setVolumePercent(msg.percent);
    sendResponse({ ok: true });
    return true;
  });

  ensureGraph();
  scan(document);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  pullResolvedVolume();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      !changes.ssc_saved_tab_volumes &&
      !changes.ssc_saved_url_volumes &&
      !changes.ssc_live_tab_volume
    ) {
      return;
    }
    pullResolvedVolume();
  });

  for (const ev of ["click", "keydown", "touchstart"]) {
    window.addEventListener(
      ev,
      () => {
        resumeIfNeeded();
      },
      { capture: true, passive: true }
    );
  }
})();
