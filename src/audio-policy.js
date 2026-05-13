(function exposeAudioPolicy(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.SSCAudioPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const DEFAULT_TAB_CAPTURE_ENABLED = true;
  const DEFAULT_PERCENT = 100;

  function resolveTabCapturePreference(value) {
    return value === undefined ? DEFAULT_TAB_CAPTURE_ENABLED : Boolean(value);
  }

  function normalizePercent(percent) {
    const value = Number(percent);
    return Number.isFinite(value) ? Math.round(value) : DEFAULT_PERCENT;
  }

  function isHttpxUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }

  function hasUsableTab(activeTabInfo) {
    return Boolean(activeTabInfo?.id) && Boolean(activeTabInfo?.isHttpx);
  }

  function shouldUseTabCapture({
    hasTabCapture,
    tabCaptureEnabled,
    activeTabInfo,
    percent,
  }) {
    if (!hasTabCapture) return false;
    if (!resolveTabCapturePreference(tabCaptureEnabled)) return false;
    if (!hasUsableTab(activeTabInfo)) return false;
    return normalizePercent(percent) !== DEFAULT_PERCENT;
  }

  function shouldPushContentVolume({ percent, captureAttempted, captureSucceeded }) {
    if (normalizePercent(percent) === DEFAULT_PERCENT) return true;
    if (captureAttempted && captureSucceeded) return false;
    return true;
  }

  return {
    DEFAULT_TAB_CAPTURE_ENABLED,
    DEFAULT_PERCENT,
    resolveTabCapturePreference,
    normalizePercent,
    isHttpxUrl,
    shouldUseTabCapture,
    shouldPushContentVolume,
  };
});
