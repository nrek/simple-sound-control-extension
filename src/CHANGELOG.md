# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-05-01

### Fixed

- **WebRTC volume "auto-corrects" back to 100% (Google Meet, Zoom Web, Discord, etc.):** Meet and similar apps actively re-stamp `audio.volume = 1` on their own elements when participants join/leave or when the active speaker switches, undoing the slider value within seconds. The content script now attaches a `volumechange` listener to every tracked media element and re-asserts the desired level whenever the page tries to override it. Inert at the default 100% so pages that own their volume slider (YouTube, Twitch, Spotify Web, etc.) keep working normally; only engages once the user has explicitly moved the SSC slider away from 100%.
- **Bounded "fight" cost.** A 16 ms (≈60 Hz) per-element throttle plus an "expected value" short-circuit prevents runaway feedback loops with pages that loop their own resets, while still feeling instant to humans.

## [0.1.2] - 2026-05-01

### Fixed

- **WebRTC audio control (Google Meet, Zoom Web, Discord, etc.):** the content script now sets `el.volume` directly on every tracked `<audio>` / `<video>` element in addition to (or instead of) routing through Web Audio. Previously the gain-node-only approach silently no-op'd on `srcObject`-backed (`MediaStream`) elements, so Meet sliders did nothing. New behaviour:
  - **0–100%:** controlled via native `HTMLMediaElement.volume` — works on WebRTC and on every other media element, no `AudioContext` required.
  - **>100% (boost):** still requires the Web Audio gain chain. WebRTC elements are detected (presence of `srcObject`) and skipped — Chrome's WebRTC audio path silences them when routed through `createMediaElementSource`. Boost on Meet et al. silently caps at 100%.
  - All tracked elements are kept in a `Set<WeakRef<HTMLMediaElement>>` and re-applied on every `setVolumePercent` so live mid-call slider drags reach every per-participant audio element, not just the ones present at first activation.

## [0.1.1] - 2026-05-01

### Added

- Settings **Theme**: **Dark** / **Light** toggle (default Dark). Light uses near-white `#efefef` surface with dark text and light-theme accent tokens; preference stored as **`ssc_theme`**.

### Changed

- Shared extension source lives in **`src/`**; **`npm run build`** copies assets to **`dist/chrome`** and **`dist/firefox`** and writes each **`manifest.json`** from **`manifests/manifest.chrome.json`** / **`manifests/manifest.firefox.json`**. Project **`README.md`** is at the repository root.
- **Build:** `scripts/build.mjs` writes `manifest.json.version` from `package.json` (single source of truth) and uses `fs.cp` for copying. Fails fast if `src/manifest.json` exists.
- **CSP** (manifest `extension_pages`) tightened to `script-src 'self'; object-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'`.

### Removed

- **`webNavigation` permission.** The popup now uses `chrome.tabs.sendMessage(tabId, payload)` (no `frameId`), which broadcasts to **all frames** in the active tab on Chrome 75+ and Firefox 50+. The per-frame enumeration via `chrome.webNavigation.getAllFrames` is gone.
- **Font Awesome CDN dependency.** Three popup glyphs (settings, back, delete) are now **inline SVG**. The CDN `<link>` is removed and the manifest CSP no longer allows `cdnjs.cloudflare.com`.

### Fixed

- **Firefox AMO submission validation:** `manifests/manifest.firefox.json` declares **`background.scripts: ["background.js"]`** as a Firefox-compatible fallback alongside `background.service_worker`, and **`browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`** to reflect that the extension performs no remote data collection (all storage is local). Chrome manifest unchanged.
- **Web Audio / autoplay policy — second pass.** The audio graph is now lazy on _intent_, not just on activation. The content script never constructs an `AudioContext` on a page where the resolved volume is the default 100% — even after a user click. The graph is built only when (a) the user has activated the page (sticky activation) **and** (b) the resolved level is non-default. Eliminates "AudioContext was not allowed to start" warnings on audio-less SPAs (e.g. `chat.google.com`, `mail.google.com`, IDEs, dashboards). Activation-triggering events trimmed to `pointerdown`, `pointerup`, `keydown` per Chrome's user-activation v2 (dropped `touchstart`, which doesn't count as activation in modern Chrome).
- **Saved-tab orphans on browser restart:** background reconciles `ssc_saved_tab_volumes` and `ssc_live_tab_volume` against currently open tabs on `runtime.onStartup` and `runtime.onInstalled`, dropping rows whose tab IDs are no longer in this session.

## [0.1.0] - 2026-04-30

### Added

- Initial Manifest V3 extension: popup UI (volume, quick actions, settings, saved states).  
- Content script Web Audio gain routing for `<audio>` / `<video>` on `http`/`https`.  
- Background service worker: tab close cleanup, volume resolution (tab / origin / default), toolbar icon indicator.  
- Per-tab “live” boost map, optional persistence per tab and per origin, accent themes.  
- Repository documentation: `README`, `LICENSE` (MIT), `SECURITY`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SUPPORT`.

