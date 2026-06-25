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

  const routed = new WeakSet();
  const volumeFallback = new WeakSet();
  const volumeFallbackOriginal = new WeakMap();

  const trackedKeys = new WeakSet();
  /** @type {Set<WeakRef<HTMLMediaElement>>} */
  const tracked = new Set();

  let pendingPercent = DEFAULT_PERCENT;
  let audioUnlocked = false;
  /** Tab Capture owns gain; content script stays inert for volume. */
  let passthroughMode = false;
  /** Lazy fallback: observers and scans run only when capture is unavailable. */
  let fallbackActive = false;

  const observedRoots = new WeakSet();
  /** @type {MutationObserver | null} */
  let mo = null;
  let attachShadowPatched = false;
  /** @type {typeof Element.prototype.attachShadow | null} */
  let _origAttachShadow = null;

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

  function canRouteViaWebAudio(el) {
    if (el.crossOrigin !== null) return true;
    const src = el.currentSrc || el.src;
    if (!src) return false;
    if (src.startsWith("blob:") || src.startsWith("data:")) return false;
    try {
      return new URL(src, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function tryRoute(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (routed.has(el) || volumeFallback.has(el) || !audioUnlocked) return;
    if (el.srcObject || !canRouteViaWebAudio(el)) {
      enterVolumeFallback(el);
      return;
    }
    ensureGraph();
    if (!ctx || !masterGain) return;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(masterGain);
      routed.add(el);
    } catch {
      enterVolumeFallback(el);
    }
  }

  function enterVolumeFallback(el) {
    if (volumeFallback.has(el)) return;
    try {
      const initial = Number(el.volume);
      volumeFallbackOriginal.set(
        el,
        Number.isFinite(initial) ? Math.max(0, Math.min(1, initial)) : 1
      );
    } catch {
      volumeFallbackOriginal.set(el, 1);
    }
    volumeFallback.add(el);
    attachVolumeFallbackEnforcer(el);
    applyVolumeFallback(el);
  }

  function releaseVolumeFallback(el) {
    const orig = volumeFallbackOriginal.get(el);
    const v =
      orig !== undefined && Number.isFinite(orig)
        ? Math.max(0, Math.min(1, orig))
        : 1;
    try {
      el.volume = v;
    } catch {
      // locked setter
    }
  }

  function releaseVolumeFallbackAll() {
    for (const ref of tracked) {
      const el = ref.deref();
      if (!el || !el.isConnected) continue;
      if (volumeFallback.has(el)) releaseVolumeFallback(el);
    }
  }

  function applyVolumeFallback(el) {
    if (passthroughMode || !fallbackActive) return;
    if (Number(pendingPercent) === DEFAULT_PERCENT) return;
    const v = Math.max(0, Math.min(1, Number(pendingPercent) / 100));
    try {
      el.volume = v;
    } catch {
      // locked setter
    }
  }

  function enforceVolumeFallback(el) {
    if (!volumeFallback.has(el)) return;
    if (passthroughMode || Number(pendingPercent) === DEFAULT_PERCENT) {
      volumeFallbackOriginal.set(el, Number(el.volume));
      return;
    }
    const desired = Math.max(0, Math.min(1, Number(pendingPercent) / 100));
    if (Math.abs(el.volume - desired) <= 0.001) return;
    volumeFallbackOriginal.set(el, Number(el.volume));
    try {
      el.volume = desired;
    } catch {
      // locked setter
    }
  }

  function attachVolumeFallbackEnforcer(el) {
    el.addEventListener("volumechange", () => enforceVolumeFallback(el), {
      capture: true,
      passive: true,
    });
  }

  function applyVolumeFallbackAll() {
    for (const ref of tracked) {
      const el = ref.deref();
      if (!el || !el.isConnected) continue;
      if (volumeFallback.has(el)) applyVolumeFallback(el);
    }
  }

  function routeAll() {
    if (!audioUnlocked || !fallbackActive) return;
    for (const ref of tracked) {
      const el = ref.deref();
      if (!el || !el.isConnected) {
        tracked.delete(ref);
        continue;
      }
      tryRoute(el);
    }
  }

  function scan(root) {
    if (!root || !fallbackActive) return;
    root.querySelectorAll?.("video, audio").forEach((n) => attachMedia(n));
    root.querySelectorAll?.("*").forEach((el) => {
      if (el.shadowRoot) scanAndObserveShadow(el.shadowRoot);
    });
  }

  function scanAndObserveShadow(sr) {
    if (!sr || observedRoots.has(sr) || !mo) return;
    observedRoots.add(sr);
    scan(sr);
    mo.observe(sr, { childList: true, subtree: true });
  }

  function attachMedia(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    track(el);
    if (pendingPercent !== DEFAULT_PERCENT && audioUnlocked && fallbackActive) {
      tryRoute(el);
    }
  }

  function ensureFallbackInfrastructure() {
    if (mo) return;
    mo = new MutationObserver((mutations) => {
      if (!fallbackActive) return;
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return;
          if (n instanceof HTMLMediaElement) attachMedia(n);
          else scan(n);
          if (n.shadowRoot) scanAndObserveShadow(n.shadowRoot);
        });
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    if (!attachShadowPatched) {
      _origAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function attachShadowSSC(init) {
        const sr = _origAttachShadow.call(this, init);
        if (init.mode === "open") {
          setTimeout(() => scanAndObserveShadow(sr), 0);
        }
        return sr;
      };
      attachShadowPatched = true;
    }
  }

  function teardownFallbackInfrastructure() {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    if (attachShadowPatched && _origAttachShadow) {
      Element.prototype.attachShadow = _origAttachShadow;
      attachShadowPatched = false;
      _origAttachShadow = null;
    }
  }

  function activateFallback() {
    if (fallbackActive || passthroughMode) return;
    fallbackActive = true;
    ensureFallbackInfrastructure();
    if (audioUnlocked) {
      ensureGraph();
      scan(document);
      routeAll();
      applyGain();
      applyVolumeFallbackAll();
    }
  }

  function deactivateFallback() {
    if (!fallbackActive) return;
    releaseVolumeFallbackAll();
    fallbackActive = false;
    teardownFallbackInfrastructure();
  }

  function setVolumePercent(percent) {
    const prev = pendingPercent;
    pendingPercent = Number(percent);
    const goingToDefault = pendingPercent === DEFAULT_PERCENT;
    const wasNonDefault = prev !== DEFAULT_PERCENT;

    if (passthroughMode) {
      if (goingToDefault && wasNonDefault) {
        deactivateFallback();
      }
      return;
    }

    if (goingToDefault) {
      if (wasNonDefault) {
        releaseVolumeFallbackAll();
      }
      deactivateFallback();
      applyGain();
      return;
    }

    activateFallback();
    applyGain();
    applyVolumeFallbackAll();
    if (audioUnlocked) {
      routeAll();
      scan(document);
    }
  }

  function onFirstUserActivation() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (fallbackActive && pendingPercent !== DEFAULT_PERCENT && !passthroughMode) {
      ensureGraph();
      scan(document);
      routeAll();
      applyGain();
      applyVolumeFallbackAll();
    }
    for (const ev of ACTIVATION_EVENTS) {
      window.removeEventListener(ev, onFirstUserActivation, true);
    }
  }

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
      if (!wasOn && next) {
        releaseVolumeFallbackAll();
        deactivateFallback();
      } else if (wasOn && !next) {
        pullResolvedVolume();
      }
      sendResponse({ ok: true, passthroughMode });
      return true;
    }
    return false;
  });

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
