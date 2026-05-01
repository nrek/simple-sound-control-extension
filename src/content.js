(() => {
  const MSG_SET = "SSC_SET_VOLUME";
  const MSG_RESOLVE = "SSC_RESOLVE_VOLUME";
  const MSG_PASSTHROUGH = "SSC_PASSTHROUGH_MODE";
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

  /**
   * Elements routed through our Web Audio gain chain via
   * `createMediaElementSource`. Once routed, the element's audio flows
   * through our GainNode permanently (there is no un-route). The page's
   * own `el.volume` still works — it attenuates *before* the signal
   * reaches our gain stage, so effective volume = el.volume × gain.
   */
  const routed = new WeakSet();

  /**
   * Elements where `createMediaElementSource` threw (CORS, srcObject /
   * WebRTC, or browser-internal restrictions). We skip these on future
   * route attempts. Tab Capture mode covers them instead.
   */
  const routeFailed = new WeakSet();

  const trackedKeys = new WeakSet();
  /** @type {Set<WeakRef<HTMLMediaElement>>} */
  const tracked = new Set();

  let pendingPercent = DEFAULT_PERCENT;
  let audioUnlocked = false;
  /**
   * When true, Tab Capture mode is active for this tab. The offscreen
   * gain node handles volume; the content script stays fully inert.
   */
  let passthroughMode = false;

  function ensureGraph() {
    if (ctx && masterGain) return;
    if (!audioUnlocked) return;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
      masterGain = ctx.createGain();
      masterGain.gain.value = Math.max(0, Math.min(4, Number(pendingPercent) / 100));
      masterGain.connect(ctx.destination);
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    } catch {
      ctx = null;
      masterGain = null;
    }
  }

  function applyGain() {
    if (!masterGain) return;
    masterGain.gain.value = Math.max(0, Math.min(4, Number(pendingPercent) / 100));
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (trackedKeys.has(el)) return;
    trackedKeys.add(el);
    tracked.add(new WeakRef(el));
  }

  /**
   * Route an element through our Web Audio gain chain. After this call
   * the element's audio flows through: el → MediaElementSource → masterGain
   * → ctx.destination. `el.volume` still works as a pre-gain attenuator
   * controlled entirely by the page — we never write to it.
   */
  function tryRoute(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (routed.has(el)) return;
    if (routeFailed.has(el)) return;
    if (!audioUnlocked) return;
    if (el.srcObject) {
      routeFailed.add(el);
      return;
    }
    ensureGraph();
    if (!ctx || !masterGain) return;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(masterGain);
      routed.add(el);
    } catch {
      routeFailed.add(el);
    }
  }

  function routeAll() {
    if (!audioUnlocked) return;
    ensureGraph();
    if (!ctx || !masterGain) return;
    for (const ref of tracked) {
      const el = ref.deref();
      if (!el || !el.isConnected) {
        tracked.delete(ref);
        continue;
      }
      tryRoute(el);
    }
  }

  function setVolumePercent(percent) {
    pendingPercent = Number(percent);
    applyGain();
    if (pendingPercent !== DEFAULT_PERCENT && audioUnlocked) {
      routeAll();
      scan(document);
    }
  }

  function onFirstUserActivation() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (pendingPercent !== DEFAULT_PERCENT) {
      ensureGraph();
      routeAll();
      scan(document);
      applyGain();
    }
    for (const ev of ACTIVATION_EVENTS) {
      window.removeEventListener(ev, onFirstUserActivation, true);
    }
  }

  function attachMedia(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    track(el);
    if (pendingPercent !== DEFAULT_PERCENT && audioUnlocked) {
      tryRoute(el);
    }
  }

  /* ---------------------- Shadow DOM traversal ---------------------- */

  const observedRoots = new WeakSet();

  function scan(root) {
    if (!root) return;
    root.querySelectorAll?.("video, audio").forEach((n) => attachMedia(n));
    root.querySelectorAll?.("*").forEach((el) => {
      if (el.shadowRoot) scanAndObserveShadow(el.shadowRoot);
    });
  }

  function scanAndObserveShadow(sr) {
    if (!sr || observedRoots.has(sr)) return;
    observedRoots.add(sr);
    scan(sr);
    mo.observe(sr, { childList: true, subtree: true });
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        if (n instanceof HTMLMediaElement) attachMedia(n);
        else scan(n);
        if (n.shadowRoot) scanAndObserveShadow(n.shadowRoot);
      });
    }
  });

  const _origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadowSSC(init) {
    const sr = _origAttachShadow.call(this, init);
    if (init.mode === "open") {
      setTimeout(() => scanAndObserveShadow(sr), 0);
    }
    return sr;
  };

  /* ---------------------- Message handling ---------------------- */

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
    if (msg?.type === MSG_SET) {
      setVolumePercent(msg.percent);
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === MSG_PASSTHROUGH) {
      const next = Boolean(msg.enabled);
      const wasOn = passthroughMode;
      passthroughMode = next;
      if (wasOn && !next) {
        pullResolvedVolume();
      }
      sendResponse({ ok: true, passthroughMode });
      return true;
    }
    return false;
  });

  /* ---------------------- Bootstrap ---------------------- */

  mo.observe(document.documentElement, { childList: true, subtree: true });

  scan(document);
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

  const ACTIVATION_EVENTS = ["pointerdown", "pointerup", "keydown"];
  for (const ev of ACTIVATION_EVENTS) {
    window.addEventListener(ev, onFirstUserActivation, { capture: true, passive: true });
  }
})();
