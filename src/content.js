(() => {
  const MSG_SET = "SSC_SET_VOLUME";
  const MSG_RESOLVE = "SSC_RESOLVE_VOLUME";
  const DEFAULT_PERCENT = 100;

  const proto = location.protocol;
  if (proto !== "http:" && proto !== "https:") {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== MSG_SET) return false;
      sendResponse({ ok: true, noop: true });
      return true;
    });
    return;
  }

  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {GainNode | null} */
  let masterGain = null;
  const attached = new WeakSet();

  /** Last requested level (0–400). Stored until BOTH user activation AND a non-default level apply. */
  let pendingPercent = DEFAULT_PERCENT;
  let audioUnlocked = false;

  /** Do we actually need to intercept this page's audio right now? */
  function shouldIntercept() {
    return Number(pendingPercent) !== DEFAULT_PERCENT;
  }

  /**
   * Build the AudioContext + master gain. Only legal once `audioUnlocked` is true
   * (sticky activation). Idempotent. Does nothing on pages with default volume
   * and no existing graph, so silent pages never construct a context.
   */
  function ensureGraph() {
    if (ctx && masterGain) return;
    if (!audioUnlocked) return;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
      masterGain = ctx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(ctx.destination);
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    } catch {
      ctx = null;
      masterGain = null;
    }
  }

  function applyGainFromPending() {
    if (!masterGain) return;
    const g = Math.max(0, Math.min(4, Number(pendingPercent) / 100));
    masterGain.gain.value = g;
  }

  /**
   * @param {number} percent UI 0–400 (100 = unity gain)
   */
  function setVolumePercent(percent) {
    pendingPercent = Number(percent);
    if (!audioUnlocked) return;
    if (!ctx && !shouldIntercept()) return;
    ensureGraph();
    if (!ctx) return;
    applyGainFromPending();
    scan(document);
  }

  function onFirstUserActivation() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (shouldIntercept()) {
      ensureGraph();
      applyGainFromPending();
      scan(document);
    }
    for (const ev of ACTIVATION_EVENTS) {
      window.removeEventListener(ev, onFirstUserActivation, true);
    }
  }

  /**
   * @param {HTMLMediaElement} el
   */
  function attachMedia(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (attached.has(el)) return;
    if (el.dataset.sscAttachFailed === "1") return;
    if (!audioUnlocked) return;
    if (!ctx && !shouldIntercept()) return;
    ensureGraph();
    if (!ctx || !masterGain) return;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(masterGain);
      attached.add(el);
      applyGainFromPending();
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
        const v = typeof resp?.volume === "number" ? resp.volume : DEFAULT_PERCENT;
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

  // Activation-triggering events per Chrome's user activation v2:
  // pointerdown counts for mouse, pointerup also catches touch, keydown covers most keys.
  // touchstart is intentionally omitted — it does NOT count as activation in modern Chrome.
  const ACTIVATION_EVENTS = ["pointerdown", "pointerup", "keydown"];
  for (const ev of ACTIVATION_EVENTS) {
    window.addEventListener(ev, onFirstUserActivation, { capture: true, passive: true });
  }
})();
