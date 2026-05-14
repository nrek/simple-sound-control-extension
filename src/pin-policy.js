(function exposePinPolicy(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.SSCPinPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const PIN_PAGE_SIZE = 6;

  function originFromUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "";
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  function domainLabelFromOrigin(origin) {
    try {
      return new URL(origin).host;
    } catch {
      return origin || "";
    }
  }

  function pinIdForOrigin(origin) {
    return origin ? `origin:${origin}` : "";
  }

  function clampVolume(volume) {
    const v = Math.round(Number(volume));
    if (!Number.isFinite(v)) return 100;
    return Math.max(0, Math.min(400, v));
  }

  function normalizePinRow(row) {
    if (row == null || typeof row !== "object") return null;
    const origin =
      typeof row.origin === "string" && row.origin
        ? row.origin
        : originFromUrl(row.url || "");
    if (!origin) return null;
    const domain = domainLabelFromOrigin(origin);
    return {
      ...row,
      id: typeof row.id === "string" && row.id ? row.id : pinIdForOrigin(origin),
      origin,
      title: domain,
      volume: clampVolume(row.volume),
    };
  }

  function normalizePinnedRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .map(normalizePinRow)
      .filter(Boolean)
      .sort((a, b) => domainLabelFromOrigin(a.origin).localeCompare(domainLabelFromOrigin(b.origin)));
  }

  function upsertPinnedLevel(rows, { origin, tabUrl, title: _title, volume }) {
    const normalizedOrigin = origin || originFromUrl(tabUrl || "");
    if (!normalizedOrigin) return normalizePinnedRows(rows);
    const id = pinIdForOrigin(normalizedOrigin);
    const list = normalizePinnedRows(rows);
    const nextRow = {
      id,
      origin: normalizedOrigin,
      url: tabUrl || normalizedOrigin,
      title: domainLabelFromOrigin(normalizedOrigin),
      volume: clampVolume(volume),
    };
    const idx = list.findIndex((row) => row.origin === normalizedOrigin || row.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...nextRow };
      return list;
    }
    return normalizePinnedRows([...list, nextRow]);
  }

  function removePinnedLevel(rows, idOrOrigin) {
    const target = String(idOrOrigin || "");
    return normalizePinnedRows(rows).filter(
      (row) => row.id !== target && row.origin !== target && pinIdForOrigin(row.origin) !== target
    );
  }

  function filterPinnedRows(rows, query) {
    const q = String(query || "").trim().toLowerCase();
    const list = normalizePinnedRows(rows);
    if (!q) return list;
    return list.filter((row) => {
      const domain = domainLabelFromOrigin(row.origin).toLowerCase();
      const origin = String(row.origin || "").toLowerCase();
      const title = String(row.title || "").toLowerCase();
      return domain.includes(q) || origin.includes(q) || title.includes(q);
    });
  }

  function paginatePinnedRows(rows, query, page, perPage = PIN_PAGE_SIZE) {
    const filtered = filterPinnedRows(rows, query);
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
    const requested = Math.round(Number(page));
    const currentPage = Math.max(1, Math.min(totalPages, Number.isFinite(requested) ? requested : 1));
    const start = (currentPage - 1) * perPage;
    return {
      items: filtered.slice(start, start + perPage),
      currentPage,
      totalPages,
      totalItems: filtered.length,
      perPage,
    };
  }

  return {
    PIN_PAGE_SIZE,
    originFromUrl,
    domainLabelFromOrigin,
    pinIdForOrigin,
    clampVolume,
    normalizePinRow,
    normalizePinnedRows,
    upsertPinnedLevel,
    removePinnedLevel,
    filterPinnedRows,
    paginatePinnedRows,
  };
});
