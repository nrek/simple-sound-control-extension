(function exposeCaptureLevelPolicy(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.SSCCaptureLevelPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  function resolveCaptureLevel(percent) {
    const raw = Number(percent) / 100;
    const factor = Number.isFinite(raw) ? Math.max(0, Math.min(4, raw)) : 1;
    return {
      muted: factor === 0,
      outputVolume: Math.min(1, factor),
      gain: factor > 1 ? factor : 1,
    };
  }

  return { resolveCaptureLevel };
});
