const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../src/audio-policy.js");

const SITES = [
  { url: "https://www.reddit.com/r/videos/", label: "Reddit" },
  { url: "https://meet.google.com/abc-defg-hij", label: "Meet" },
  { url: "https://app.zoom.us/wc/join/123456789", label: "Zoom" },
  { url: "https://www.facebook.com/watch/?v=123", label: "Facebook" },
  { url: "https://www.instagram.com/reel/abc/", label: "Instagram" },
  { url: "https://www.youtube.com/watch?v=abc", label: "YouTube" },
];

test("requires tab capture on Chrome http tabs below 100% for major sites", () => {
  for (const site of SITES) {
    assert.equal(
      policy.shouldUseTabCapture({
        hasTabCapture: true,
        activeTabInfo: { id: 1, url: site.url, isHttpx: true },
        percent: 50,
      }),
      true,
      site.label
    );
    assert.equal(
      policy.shouldUseTabCapture({
        hasTabCapture: true,
        activeTabInfo: { id: 1, url: site.url, isHttpx: true },
        percent: 200,
      }),
      true,
      `${site.label} boost`
    );
  }
});

test("does not use tab capture at neutral 100%", () => {
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: true,
      activeTabInfo: { id: 123, url: "https://www.youtube.com/watch?v=abc", isHttpx: true },
      percent: 100,
    }),
    false
  );
});

test("does not use tab capture where the API or http tab is unavailable", () => {
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: false,
      activeTabInfo: { id: 123, url: "https://www.reddit.com/", isHttpx: true },
      percent: 20,
    }),
    false
  );
  assert.equal(
    policy.shouldUseTabCapture({
      hasTabCapture: true,
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
