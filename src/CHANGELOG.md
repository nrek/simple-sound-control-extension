# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **`webNavigation` permission.** The popup now uses `chrome.tabs.sendMessage(tabId, payload)` (no `frameId`), which broadcasts to **all frames** in the active tab on Chrome 75+ and Firefox 50+. The per-frame enumeration via `chrome.webNavigation.getAllFrames` is gone.
- **Font Awesome CDN dependency.** Three popup glyphs (settings, back, delete) are now **inline SVG**. The CDN `<link>` is removed and the manifest CSP no longer allows `cdnjs.cloudflare.com`.

### Fixed

- **Firefox AMO submission validation:** `manifests/manifest.firefox.json` now declares **`background.scripts: ["background.js"]`** as a Firefox-compatible fallback alongside `background.service_worker`, and **`browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`** to reflect that the extension performs no remote data collection (all storage is local). Chrome manifest unchanged.
- **Web Audio / autoplay policy:** `AudioContext` is no longer created at `document_idle`. The graph is created on the first **user gesture** (`pointerdown`, `keydown`, or `touchstart`) on the page, then `resume()` runs in that context—avoids console warnings and failed resumes on non-audio pages (e.g. `chrome://newtab/` if the script ever runs there). Non-`http:`/`https:` pages no-op with a minimal message listener.
- **Saved-tab orphans on browser restart:** background reconciles `ssc_saved_tab_volumes` and `ssc_live_tab_volume` against currently open tabs on `runtime.onStartup` and `runtime.onInstalled`, dropping rows whose tab IDs are no longer in this session.

### Changed

- **Build:** `scripts/build.mjs` now writes `manifest.json.version` from `package.json` (single source of truth) and uses `fs.cp` for copying. Fails fast if `src/manifest.json` exists.
- **CSP** (manifest `extension_pages`) tightened to `script-src 'self'; object-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'`.

### Added

- Settings **Theme**: **Dark** / **Light** toggle (default Dark). Light uses near-white `#efefef` surface with dark text and light-theme accent tokens; preference stored as **`ssc_theme`**.

### Changed

- Shared extension source lives in **`src/`**; **`npm run build`** copies assets to **`dist/chrome`** and **`dist/firefox`** and writes each **`manifest.json`** from **`manifests/manifest.chrome.json`** / **`manifests/manifest.firefox.json`**. Project **`README.md`** is at the repository root.

## [0.1.0] - 2026-04-30

### Added

- Initial Manifest V3 extension: popup UI (volume, quick actions, settings, saved states).  
- Content script Web Audio gain routing for `<audio>` / `<video>` on `http`/`https`.  
- Background service worker: tab close cleanup, volume resolution (tab / origin / default), toolbar icon indicator.  
- Per-tab “live” boost map, optional persistence per tab and per origin, accent themes.  
- Repository documentation: `README`, `LICENSE` (MIT), `SECURITY`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SUPPORT`.

