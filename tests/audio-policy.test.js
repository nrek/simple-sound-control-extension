const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../src/audio-policy.js");

test("prefers tab capture by default on Chrome http tabs below 100%", () => {
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: true,
      tabCaptureEnabled: undefined,
      activeTabInfo: { id: 123, url: "https://www.reddit.com/r/videos/", isHttpx: true },
      percent: 50,
    }),
    true
  );
});

test("prefers tab capture for Zoom WebRTC calls at non-neutral levels", () => {
  for (const percent of [50, 200]) {
    assert.equal(
      policy.shouldUseTabCapture({
        hasTabCapture: true,
        tabCaptureEnabled: undefined,
        activeTabInfo: { id: 456, url: "https://app.zoom.us/wc/join/123456789", isHttpx: true },
        percent,
      }),
      true
    );
  }
});

test("does not use tab capture at neutral 100%", () => {
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: true,
      tabCaptureEnabled: undefined,
      activeTabInfo: { id: 123, url: "https://www.youtube.com/watch?v=abc", isHttpx: true },
      percent: 100,
    }),
    false
  );
});

test("respects explicit tab capture opt-out", () => {
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: true,
      tabCaptureEnabled: false,
      activeTabInfo: { id: 123, url: "https://www.youtube.com/watch?v=abc", isHttpx: true },
      percent: 20,
    }),
    false
  );
});

test("does not use tab capture where the API or http tab is unavailable", () => {
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: false,
      tabCaptureEnabled: undefined,
      activeTabInfo: { id: 123, url: "https://www.reddit.com/", isHttpx: true },
      percent: 20,
    }),
    false
  );
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: true,
      tabCaptureEnabled: undefined,
      activeTabInfo: { id: 123, url: "chrome://extensions", isHttpx: false },
      percent: 20,
    }),
    false
  );
});

test("skips content-script volume when tab capture succeeds", () => {
  assert.equal(
    policy.shouldPushContentVolume({
      percent: 50,
      captureAttempted: true,
      captureSucceeded: true,
    }),
    false
  );
});

test("falls back to content-script volume when capture is unavailable or released", () => {
  assert.equal(
    policy.shouldPushContentVolume({
      percent: 50,
      captureAttempted: true,
      captureSucceeded: false,
    }),
    true
  );
  assert.equal(
    policy.shouldPushContentVolume({
      percent: 100,
      captureAttempted: true,
      captureSucceeded: false,
    }),
    true
  );
});
