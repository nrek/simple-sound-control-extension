(function exposeAudioPolicy(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.SSCAudioPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const DEFAULT_PERCENT = 100;

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

  /**
   * Chrome whole-tab capture is the product path for any non-neutral level.
   * Capability + http(s) tab + percent !== 100 is sufficient; there is no
   * user opt-out because only tab-level gain can deliver 0–400% reliably.
   */
  function shouldUseTabCapture({ hasTabCapture, activeTabInfo, percent }) {
    if (!hasTabCapture) return false;
    if (!hasUsableTab(activeTabInfo)) return false;
    return normalizePercent(percent) !== DEFAULT_PERCENT;
  }

  /** Content-script fallback runs only when capture was attempted but failed, or at 100%. */
  function shouldPushContentVolume({ percent, captureAttempted, captureSucceeded }) {
    if (normalizePercent(percent) === DEFAULT_PERCENT) return true;
    if (captureAttempted && captureSucceeded) return false;
    return true;
  }

  return {
    DEFAULT_PERCENT,
    normalizePercent,
    isHttpxUrl,
    shouldUseTabCapture,
    shouldPushContentVolume,
  };
});
