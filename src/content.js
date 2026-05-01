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

  /** Elements routed through our Web Audio gain chain. Once routed, can't unroute. */
  const routed = new WeakSet();
  /** Dedupe set for `tracked` membership. */
  const trackedKeys = new WeakSet();
  /**
   * Live registry of media elements we've seen, kept as WeakRefs so the GC can
   * reclaim them when the page removes them. We iterate this on every volume
   * change to push the new level out, pruning dead refs as we go.
   * @type {Set<WeakRef<HTMLMediaElement>>}
   */
  const tracked = new Set();

  let pendingPercent = DEFAULT_PERCENT;
  let audioUnlocked = false;

  /** Boost is the only situation that requires a Web Audio graph. */
  function isBoost() {
    return Number(pendingPercent) > 100;
  }

  /**
   * Build the AudioContext + master gain. Only legal once `audioUnlocked` is true
   * (sticky activation). Idempotent. Only invoked when boost > 100% is actually
   * requested, so silent / non-audio pages never construct a context.
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

  /**
   * Push the current `pendingPercent` to a single element.
   *  - Routed elements have their `.volume` forced to 1; the gain node carries the
   *    full level (and any boost) for them.
   *  - Unrouted elements get `.volume` set directly in the [0..1] range. This is
   *    the path that handles WebRTC streams (Google Meet, Zoom Web, etc.) and
   *    silently caps any boost > 100% at 100% on those elements.
   */
  function applyToElement(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    try {
      if (routed.has(el)) {
        if (el.volume !== 1) el.volume = 1;
      } else {
        const v = Math.max(0, Math.min(1, Number(pendingPercent) / 100));
        if (Math.abs(el.volume - v) > 0.001) el.volume = v;
      }
    } catch {
      // Some sites lock down setters via Object.defineProperty; nothing we can do.
    }
  }

  function applyGainFromPending() {
    if (!masterGain) return;
    const g = Math.max(0, Math.min(4, Number(pendingPercent) / 100));
    masterGain.gain.value = g;
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (trackedKeys.has(el)) return;
    trackedKeys.add(el);
    tracked.add(new WeakRef(el));
  }

  /**
   * Try to route an element through the Web Audio gain chain so that we can
   * apply boost > 100%. WebRTC (`srcObject`-backed) elements are skipped because
   * `createMediaElementSource` either silences them or no-ops on Chrome's
   * WebRTC audio path.
   */
  function tryRoute(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (routed.has(el)) return;
    if (el.dataset.sscRouteFailed === "1") return;
    if (!audioUnlocked) return;
    if (el.srcObject) {
      el.dataset.sscRouteFailed = "1";
      return;
    }
    ensureGraph();
    if (!ctx || !masterGain) return;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(masterGain);
      routed.add(el);
      applyToElement(el);
    } catch {
      el.dataset.sscRouteFailed = "1";
    }
  }

  function applyToAll() {
    for (const ref of tracked) {
      const el = ref.deref();
      if (!el || !el.isConnected) {
        tracked.delete(ref);
        continue;
      }
      applyToElement(el);
    }
  }

  function routeAllForBoost() {
    if (!isBoost()) return;
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

  /**
   * @param {number} percent UI 0–400 (100 = unity gain)
   */
  function setVolumePercent(percent) {
    pendingPercent = Number(percent);

    // Native `el.volume` works pre-activation, works on WebRTC, and doesn't
    // trigger any autoplay-policy warnings. Always do this.
    applyToAll();

    if (audioUnlocked && isBoost()) {
      ensureGraph();
      routeAllForBoost();
    }

    if (masterGain) {
      applyGainFromPending();
    }

    scan(document);
  }

  function onFirstUserActivation() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (isBoost()) {
      ensureGraph();
      scan(document);
      routeAllForBoost();
      applyGainFromPending();
    }
    applyToAll();
    for (const ev of ACTIVATION_EVENTS) {
      window.removeEventListener(ev, onFirstUserActivation, true);
    }
  }

  function attachMedia(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    track(el);
    applyToElement(el);
    if (audioUnlocked && isBoost()) {
      tryRoute(el);
      applyGainFromPending();
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

  // Activation-triggering events per Chrome's user activation v2:
  // pointerdown counts for mouse, pointerup also catches touch, keydown covers most keys.
  // touchstart is intentionally omitted — it does NOT count as activation in modern Chrome.
  const ACTIVATION_EVENTS = ["pointerdown", "pointerup", "keydown"];
  for (const ev of ACTIVATION_EVENTS) {
    window.addEventListener(ev, onFirstUserActivation, { capture: true, passive: true });
  }
})();
