(() => {
  const MSG_SET = "SSC_SET_VOLUME";
  const MSG_RESOLVE = "SSC_RESOLVE_VOLUME";
  const MSG_PASSTHROUGH = "SSC_PASSTHROUGH_MODE";
  const DEFAULT_PERCENT = 100;
  /**
   * Floor in milliseconds between successive page-driven volume corrections we'll
   * apply to the same element. Bounds the cost of a "fight" with a page that
   * resets `el.volume` in a tight loop. 60 Hz is plenty for human-perceptible
   * volume control.
   */
  const ENFORCE_THROTTLE_MS = 16;

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
  /** Dedupe set for `tracked` membership and watcher attachment. */
  const trackedKeys = new WeakSet();
  /**
   * Live registry of media elements we've seen, kept as WeakRefs so the GC can
   * reclaim them when the page removes them. We iterate this on every volume
   * change to push the new level out, pruning dead refs as we go.
   * @type {Set<WeakRef<HTMLMediaElement>>}
   */
  const tracked = new Set();

  /**
   * Per-element bookkeeping for the volumechange enforcer:
   *  - `lastEnforceAt`: monotonic ms of our last self-write, used to throttle.
   *  - `expectedVolume`: the value we just wrote, so we can short-circuit the
   *    `volumechange` event we know we caused.
   * @type {WeakMap<HTMLMediaElement, { lastEnforceAt: number, expectedVolume: number }>}
   */
  const enforceMeta = new WeakMap();

  let pendingPercent = DEFAULT_PERCENT;
  let audioUnlocked = false;
  /**
   * When true, the background service worker is routing this tab's audio
   * through an offscreen `tabCapture` chain. The source tab is muted at the
   * tab level, so `el.volume` writes from us do nothing useful and just pick
   * fights with the page (e.g. Meet auto-resets). Stay out of the way until
   * the background tells us to resume.
   */
  let passthroughMode = false;

  /** Boost is the only situation that requires a Web Audio graph. */
  function isBoost() {
    return Number(pendingPercent) > 100;
  }

  /** Desired native `el.volume` for an element given current pendingPercent + routing. */
  function desiredVolumeFor(el) {
    if (routed.has(el)) return 1;
    return Math.max(0, Math.min(1, Number(pendingPercent) / 100));
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
   * Write `el.volume` and record the value so the upcoming `volumechange` event
   * is recognized as ours and ignored by `enforceOnElement`.
   */
  function writeVolume(el, v) {
    try {
      const meta = enforceMeta.get(el) || { lastEnforceAt: 0, expectedVolume: -1 };
      meta.expectedVolume = v;
      meta.lastEnforceAt = performance.now();
      enforceMeta.set(el, meta);
      el.volume = v;
    } catch {
      // Some sites lock down setters via Object.defineProperty; nothing we can do.
    }
  }

  /**
   * Push the current `pendingPercent` to a single element. Active write — used
   * when the slider moves or when we first track an element. Skipped at default
   * 100% on unrouted elements so we don't override the page's natural volume.
   */
  function applyToElement(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (passthroughMode) return;
    if (routed.has(el)) {
      if (el.volume !== 1) writeVolume(el, 1);
      return;
    }
    if (Number(pendingPercent) === DEFAULT_PERCENT) return;
    const v = desiredVolumeFor(el);
    if (Math.abs(el.volume - v) > 0.001) writeVolume(el, v);
  }

  /**
   * `volumechange` handler. If the page changed the element's volume away from
   * what we want and we're currently asserting (non-default), put it back.
   * Inert at default 100% so non-extension volume control on the page works.
   */
  function enforceOnElement(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (passthroughMode) return;
    if (Number(pendingPercent) === DEFAULT_PERCENT && !routed.has(el)) return;

    const desired = desiredVolumeFor(el);
    if (Math.abs(el.volume - desired) <= 0.001) return;

    const meta = enforceMeta.get(el);
    if (meta) {
      // The event is for our own write — Math.abs check above already covered the
      // happy path; this guards a race where two writes interleave.
      if (Math.abs(el.volume - meta.expectedVolume) <= 0.001) return;
      // Throttle: never re-correct more often than once per ENFORCE_THROTTLE_MS.
      const now = performance.now();
      if (now - meta.lastEnforceAt < ENFORCE_THROTTLE_MS) return;
    }

    writeVolume(el, desired);
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
    el.addEventListener("volumechange", () => enforceOnElement(el), {
      capture: true,
      passive: true,
    });
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
        // Capture released. Pull the resolved level and re-apply via el.volume.
        pullResolvedVolume();
      }
      sendResponse({ ok: true, passthroughMode });
      return true;
    }
    return false;
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
