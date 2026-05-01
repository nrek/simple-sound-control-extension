/**
 * Offscreen audio host. Runs in an MV3 offscreen document because service
 * workers can't host an `AudioContext`. One AudioContext is shared across
 * captured tabs; each captured tab gets its own MediaStream → GainNode →
 * destination chain. Captures are keyed by `tabId`.
 *
 * Lifecycle is driven entirely by the background service worker via
 * `chrome.runtime.sendMessage`. We never originate state changes here.
 */
(() => {
  const MSG_START = "SSC_OFFSCREEN_START";
  const MSG_GAIN = "SSC_OFFSCREEN_GAIN";
  const MSG_STOP = "SSC_OFFSCREEN_STOP";
  const MSG_LIST = "SSC_OFFSCREEN_LIST";

  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {Map<number, { stream: MediaStream, source: MediaStreamAudioSourceNode, gain: GainNode }>} */
  const captures = new Map();

  function ensureContext() {
    if (ctx) return ctx;
    ctx = new AudioContext({ latencyHint: "interactive" });
    return ctx;
  }

  function clampGain(percent) {
    const g = Number(percent) / 100;
    if (!Number.isFinite(g)) return 1;
    return Math.max(0, Math.min(4, g));
  }

  async function startCapture(tabId, streamId, percent) {
    const tid = Number(tabId);
    if (Number.isNaN(tid) || !streamId) {
      throw new Error("invalid tabId or streamId");
    }
    if (captures.has(tid)) {
      setGain(tid, percent);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    const ac = ensureContext();
    if (ac.state === "suspended") {
      try {
        await ac.resume();
      } catch {
        // ignore
      }
    }
    const source = ac.createMediaStreamSource(stream);
    const gain = ac.createGain();
    gain.gain.value = clampGain(percent);
    source.connect(gain);
    gain.connect(ac.destination);
    captures.set(tid, { stream, source, gain });
  }

  function setGain(tabId, percent) {
    const cap = captures.get(Number(tabId));
    if (!cap) return false;
    cap.gain.gain.value = clampGain(percent);
    return true;
  }

  function stopCapture(tabId) {
    const tid = Number(tabId);
    const cap = captures.get(tid);
    if (!cap) return false;
    try {
      cap.source.disconnect();
    } catch {
      // ignore
    }
    try {
      cap.gain.disconnect();
    } catch {
      // ignore
    }
    for (const t of cap.stream.getTracks()) {
      try {
        t.stop();
      } catch {
        // ignore
      }
    }
    captures.delete(tid);
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === MSG_START) {
      (async () => {
        try {
          await startCapture(msg.tabId, msg.streamId, msg.percent);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    if (msg?.type === MSG_GAIN) {
      const ok = setGain(msg.tabId, msg.percent);
      sendResponse({ ok });
      return false;
    }
    if (msg?.type === MSG_STOP) {
      const ok = stopCapture(msg.tabId);
      sendResponse({ ok, remaining: captures.size });
      return false;
    }
    if (msg?.type === MSG_LIST) {
      sendResponse({ ok: true, tabs: Array.from(captures.keys()) });
      return false;
    }
    return false;
  });
})();
