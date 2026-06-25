(() => {
  const MSG_SET = "SSC_SET_VOLUME";
  const MSG_RESOLVE = "SSC_RESOLVE_VOLUME";
  const MSG_PASSTHROUGH = "SSC_PASSTHROUGH_MODE";
  const MSG_DEBUG_AUDIO = "SSC_DEBUG_AUDIO_STATE";
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
   * Elements controlled via direct `el.volume` writes instead of the
   * Web Audio gain chain. Three populations land here:
   *
   *   1. `srcObject` (WebRTC) elements — Meet, Zoom, Discord. These
   *      can't be routed through `createMediaElementSource` at all.
   *   2. Cross-origin media without `crossorigin="anonymous"` — Reddit,
   *      many CDN-backed players. `createMediaElementSource` would
   *      succeed but produce silence (Web Audio CORS taint), so we
   *      avoid the call and write `el.volume` directly.
   *   3. Elements where the page already owns the Web Audio source
   *      (our `createMediaElementSource` throws `InvalidStateError`),
   *      plus any other rare failure from that call — `el.volume` is
   *      a strictly safer fallback than going inert.
   *
   * For (2) and (3) we lose the "el.volume × SSC = effective" composition
   * the gain-node path gives us — SSC's slider value drives `el.volume`
   * directly and the page slider becomes a no-op while SSC is non-default.
   * The `volumechange` enforcer keeps SSC's level pinned against page
   * resets (Meet, YouTube on focus changes, etc).
   *
   * Boost > 100% is not available on the fallback path (`el.volume` is
   * clamped to 0–1 by the spec). Tab Capture mode covers boost for these
   * elements.
   */
  const volumeFallback = new WeakSet();

  /**
   * Last known page-driven `el.volume` for each fallback element. Seeded
   * at `enterVolumeFallback` and refreshed by the enforcer whenever the
   * page writes a value we then override. On release (SSC returns to
   * 100% or Tab Capture mode engages), we write this value back so the
   * page's last intent is preserved instead of leaving the element pinned
   * at whatever SSC last wrote.
   */
  const volumeFallbackOriginal = new WeakMap();

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

  function getDebugAudioState() {
    const state = {
      ok: true,
      pendingPercent,
      audioUnlocked,
      passthroughMode,
      hasAudioContext: Boolean(ctx),
      audioContextState: ctx?.state || null,
      hasMasterGain: Boolean(masterGain),
      masterGainValue: masterGain ? masterGain.gain.value : null,
      tracked: 0,
      routed: 0,
      volumeFallback: 0,
      srcObjectFallback: 0,
      disconnected: 0,
    };

    for (const ref of tracked) {
      const el = ref.deref();
      if (!el || !el.isConnected) {
        state.disconnected += 1;
        continue;
      }
      state.tracked += 1;
      if (routed.has(el)) state.routed += 1;
      if (volumeFallback.has(el)) {
        state.volumeFallback += 1;
        if (el.srcObject) state.srcObjectFallback += 1;
      }
    }

    return state;
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (trackedKeys.has(el)) return;
    trackedKeys.add(el);
    tracked.add(new WeakRef(el));
  }

  /**
   * Decide whether `createMediaElementSource(el)` can route this
   * element's audio through our gain chain without silencing it.
   *
   * Per the Web Audio spec, when the element's media data is cross-origin
   * and the element has not opted into CORS via the `crossorigin`
   * attribute, `createMediaElementSource` taints the source — the call
   * succeeds but the node outputs silence. We have to detect this
   * up front because the silencing is one-way: once tainted, the
   * element is silent for the rest of its life regardless of whether
   * we disconnect.
   */
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

  /**
   * Route an element through our Web Audio gain chain. After this call
   * the element's audio flows through: el → MediaElementSource → masterGain
   * → ctx.destination. `el.volume` still works as a pre-gain attenuator
   * controlled entirely by the page — we never write to it on this path.
   *
   * Elements that can't safely route (srcObject, cross-origin without
   * CORS opt-in, or already claimed by the page's own Web Audio graph)
   * are sent down the `volumeFallback` path instead.
   */
  function tryRoute(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (routed.has(el)) return;
    if (volumeFallback.has(el)) return;
    if (!audioUnlocked) return;
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
      // Most commonly `InvalidStateError` (page already has a
      // `MediaElementSource` on this element). The element's audio
      // graph is now owned by the page; we can still attenuate via
      // `el.volume`.
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

  /**
   * Write our gain percent into `el.volume` directly. Clamped to 0–1 —
   * boost (>100%) is unavailable on this path; Tab Capture mode handles
   * boost for elements that can't go through the Web Audio gain node.
   * Only fires when SSC is non-default; at 100% we leave the page alone.
   */
  function applyVolumeFallback(el) {
    if (passthroughMode) return;
    if (Number(pendingPercent) === DEFAULT_PERCENT) return;
    const v = Math.max(0, Math.min(1, Number(pendingPercent) / 100));
    try {
      el.volume = v;
    } catch {
      // locked setter
    }
  }

  /**
   * `volumechange` enforcer for fallback-path elements. Three jobs:
   *
   *   - Re-assert the SSC level when the page tries to override it
   *     (Meet's auto-reset, slider drags, ad boundaries, etc).
   *   - Track the page's most recent `el.volume` intent so we can
   *     restore it on release (SSC → 100% or Tab Capture engage).
   *   - Stay inert while passthrough is on or SSC is at default, but
   *     still update the intent snapshot so the next release uses the
   *     freshest page value.
   *
   * The `|el.volume - desired|` check is the loop guard: our own writes
   * always land at `desired`, so they short-circuit here and never
   * re-trigger.
   */
  function enforceVolumeFallback(el) {
    if (!volumeFallback.has(el)) return;
    // Inert regimes: capture page-driven writes as the new intent and bail.
    if (passthroughMode || Number(pendingPercent) === DEFAULT_PERCENT) {
      volumeFallbackOriginal.set(el, Number(el.volume));
      return;
    }
    const desired = Math.max(0, Math.min(1, Number(pendingPercent) / 100));
    if (Math.abs(el.volume - desired) <= 0.001) return;
    // Page wrote something different — record it as their current intent
    // (used on the next release), then re-assert SSC's level.
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
    if (!audioUnlocked) return;
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
    const prev = pendingPercent;
    pendingPercent = Number(percent);
    applyGain();
    const goingToDefault = pendingPercent === DEFAULT_PERCENT;
    const wasNonDefault = prev !== DEFAULT_PERCENT;
    if (goingToDefault) {
      // SSC returned to 100% — hand `el.volume` back to the page using
      // its most recent intent so fallback elements don't stay pinned at
      // SSC's last attenuation. Skipped during passthrough (we promised
      // to stay inert there; the release already ran on passthrough entry).
      if (wasNonDefault && !passthroughMode) {
        releaseVolumeFallbackAll();
      }
      return;
    }
    applyVolumeFallbackAll();
    if (audioUnlocked) {
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
      applyVolumeFallbackAll();
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
      if (!wasOn && next) {
        // Entering passthrough: release `el.volume` holds so the offscreen
        // gain in Tab Capture mode is the sole attenuator. Without this,
        // a residual SSC-written value (e.g. 0.2 on Reddit) would compose
        // with the offscreen gain and double-attenuate the captured tab.
        releaseVolumeFallbackAll();
      } else if (wasOn && !next) {
        pullResolvedVolume();
      }
      sendResponse({ ok: true, passthroughMode });
      return true;
    }
    if (msg?.type === MSG_DEBUG_AUDIO) {
      sendResponse(getDebugAudioState());
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
