/**
 * Offscreen audio host. Runs in an MV3 offscreen document because service
 * workers can't host an `AudioContext`. One AudioContext is shared across
 * captured tabs; each captured tab gets its own MediaStream → GainNode →
 * destination chain. Captures are keyed by `tabId`.
 */
(() => {
  const CAPTURE_LEVEL_POLICY = globalThis.SSCCaptureLevelPolicy;
  const MSG_START = "SSC_OFFSCREEN_START";
  const MSG_GAIN = "SSC_OFFSCREEN_GAIN";
  const MSG_STOP = "SSC_OFFSCREEN_STOP";

  /** @type {AudioContext | null} */
  let ctx = null;
  /**
   * The HTMLAudioElement is the sole output for each processed stream. Using
   * real media-element playback keeps Chrome's AUDIO_PLAYBACK offscreen
   * lifetime active; a Web Audio destination alone is not reliable for that
   * lifecycle signal in newer Chrome builds.
   * @type {Map<number, {
   *   stream: MediaStream,
   *   source: MediaStreamAudioSourceNode,
   *   gain: GainNode,
   *   destination: MediaStreamAudioDestinationNode,
   *   output: HTMLAudioElement
   * }>}
   */
  const captures = new Map();

  function ensureContext() {
    if (ctx) return ctx;
    ctx = new AudioContext({ latencyHint: "interactive" });
    return ctx;
  }

  function applyLevel(capture, percent) {
    const level = CAPTURE_LEVEL_POLICY.resolveCaptureLevel(percent);
    // Native media-element output is the most reliable attenuation/mute path
    // for captured WebRTC audio. Web Audio gain is reserved for boosts.
    capture.output.muted = level.muted;
    capture.output.volume = level.outputVolume;
    capture.gain.gain.value = level.gain;
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
    const destination = ac.createMediaStreamDestination();
    const output = new Audio();
    source.connect(gain);
    gain.connect(destination);
    output.autoplay = true;
    output.srcObject = destination.stream;
    const capture = { stream, source, gain, destination, output };
    applyLevel(capture, percent);
    try {
      await output.play();
    } catch (err) {
      source.disconnect();
      gain.disconnect();
      for (const track of stream.getTracks()) track.stop();
      output.srcObject = null;
      throw err;
    }
    captures.set(tid, capture);
  }

  function setGain(tabId, percent) {
    const cap = captures.get(Number(tabId));
    if (!cap) return false;
    applyLevel(cap, percent);
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
    try {
      cap.output.pause();
      cap.output.srcObject = null;
    } catch {
      // ignore
    }
    try {
      cap.destination.disconnect();
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
    return false;
  });
})();
