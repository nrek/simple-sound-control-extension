const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const captureLevelPolicy = require("../src/capture-level-policy.js");

const src = (name) =>
  fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("Chrome offscreen host declares capture and playback reasons", () => {
  const background = src("background.js");
  assert.match(
    background,
    /OFFSCREEN_REASONS\s*=\s*\["USER_MEDIA",\s*"AUDIO_PLAYBACK"\]/
  );
});

test("popup treats optional tabCapture as available before API exposure", () => {
  const popup = src("popup.js");
  assert.match(popup, /optional\.includes\("tabCapture"\)/);
  assert.match(popup, /optional\.includes\("offscreen"\)/);
  assert.doesNotMatch(
    popup,
    /HAS_TAB_CAPTURE\s*=\s*[\s\S]*Boolean\(chrome\.tabCapture\?\.getMediaStreamId\)\s*&&\s*Boolean\(chrome\.permissions\?\.request\)/
  );
});

test("popup initiates stream id before awaiting offscreen preparation", () => {
  const popup = src("popup.js");
  const prepare = popup.indexOf("MSG_TAB_CAPTURE_PREPARE });");
  const streamId = popup.indexOf("chrome.tabCapture.getMediaStreamId");
  assert.notEqual(prepare, -1);
  assert.notEqual(streamId, -1);
  assert.ok(streamId < prepare);
});

test("offscreen capture uses media-element playback as its sole output", () => {
  const offscreen = src("offscreen.js");
  assert.match(offscreen, /createMediaStreamDestination\(\)/);
  assert.match(offscreen, /output\.srcObject\s*=\s*destination\.stream/);
  assert.match(offscreen, /await output\.play\(\)/);
  assert.doesNotMatch(offscreen, /gain\.connect\(ac\.destination\)/);
});

test("captured output applies mute, attenuation, neutral, and boost levels", () => {
  assert.deepEqual(captureLevelPolicy.resolveCaptureLevel(0), {
    muted: true,
    outputVolume: 0,
    gain: 1,
  });
  assert.deepEqual(captureLevelPolicy.resolveCaptureLevel(20), {
    muted: false,
    outputVolume: 0.2,
    gain: 1,
  });
  assert.deepEqual(captureLevelPolicy.resolveCaptureLevel(23), {
    muted: false,
    outputVolume: 0.23,
    gain: 1,
  });
  assert.deepEqual(captureLevelPolicy.resolveCaptureLevel(100), {
    muted: false,
    outputVolume: 1,
    gain: 1,
  });
  assert.deepEqual(captureLevelPolicy.resolveCaptureLevel(200), {
    muted: false,
    outputVolume: 1,
    gain: 2,
  });
});

test("background does not mute the source tab separately from tab capture", () => {
  const background = src("background.js");
  assert.doesNotMatch(background, /chrome\.tabs\.update\([^)]*\{\s*muted:/);
});
