# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-05-04

### Fixed

- **Meet volume no longer resets to 100% when switching tabs.** Meet's JavaScript resets `el.volume` to 1.0 on focus changes and internal timers. Added a `volumechange` enforcer that re-asserts the SSC level — but only for `srcObject` (WebRTC) elements. Regular media elements (YouTube, Reddit, etc.) still go through Web Audio only and have no `volumechange` listener. The enforcer uses `srcObjectExpected` to recognize its own writes and avoid loops.

## [0.2.1] - 2026-05-04

### Fixed

- **Google Meet (and other WebRTC apps) volume control restored.** 0.2.0 dropped *all* `el.volume` writes, which meant `srcObject`-backed elements (WebRTC) became uncontrollable — `createMediaElementSource` can't route them through Web Audio. Now there are two distinct paths:
  - **Regular media** (`<video src="...">`, `<audio>`, MSE, etc.): routed through Web Audio `GainNode`. `el.volume` is never written. Page controls (YouTube slider, Reddit player) work without interference.
  - **`srcObject` / WebRTC elements** (Meet, Zoom, Discord): `el.volume` is written directly as a fallback. This is safe because WebRTC elements don't have a user-facing volume slider tied to `el.volume` — per-participant controls in these apps work through the WebRTC mixer, not the DOM property.
- Boost >100% is not available via `el.volume` (clamped to 0–1); Tab Capture mode covers WebRTC boost.

## [0.2.0] - 2026-05-01

### Changed (BREAKING — architecture)

- **SSC no longer writes to `el.volume`. Ever.** The entire `writeVolume` / `enforceOnElement` / `enforceMeta` / `volumechange` listener path has been removed. The content script now works exclusively through Web Audio: every `<video>` / `<audio>` element is routed through a shared `GainNode` via `createMediaElementSource`. The page's own `el.volume` is never read or written by the extension — it flows into our gain stage as a pre-multiplier, so the composition is always `el.volume × (SSC% / 100) = effective volume`. YouTube at 50% with SSC at 50% = 25% effective. Reddit's player controls, YouTube's slider, Meet's participant volume — all work normally and are never interfered with.

- **`dataset.sscRouteFailed` replaced with a `WeakSet`.** No more mutations to page DOM.

### Trade-offs (known, accepted)

- **Elements that can't be routed** (`srcObject` / WebRTC, or elements where `createMediaElementSource` throws due to CORS) are unaffected by SSC in content-script mode. Tab Capture mode (Chrome, opt-in) covers these cases.
- **First volume change requires a prior user gesture on the page** (click, keypress, etc.) because `AudioContext` creation requires user activation. If the user opens the SSC popup before interacting with the page, the gain applies as soon as they click/type on the page. At SSC 100% (default) nothing needs to happen — gain = 1.0 is transparent.

## [0.1.13] - 2026-05-01

### Fixed

- **Volume control now works on Reddit and other sites using shadow DOM.** Reddit's video player (`<shreddit-player>`) wraps its `<video>` element inside a web component's shadow root. `querySelectorAll("video, audio")` and `MutationObserver` cannot pierce shadow DOM boundaries, so the content script never found the element. Three changes:
  1. `scan()` now recursively descends into open shadow roots on every element it encounters.
  2. The `MutationObserver` callback checks newly added nodes for shadow roots and attaches an observer to each.
  3. `Element.prototype.attachShadow` is intercepted (monkey-patched) so shadow roots created *after* the initial scan are automatically observed. This catches components that create their shadow root lazily (e.g. on `connectedCallback` or first interaction).
  - Same fix benefits any site using web components for media: Twitch clip embeds, some podcast players, modern SPA frameworks.

## [0.1.12] - 2026-05-01

### Fixed

- **Restored `host_permissions: ["http://*/*", "https://*/*"]`** on both Chrome and Firefox manifests. Reverts the removal in 0.1.10. The audit was right that no single code path strictly *required* host_permissions, but Chrome's actual install-time behavior without them is "site access restricted by default" — content scripts declared via `content_scripts.matches` get downgraded to a state where `chrome.tabs.sendMessage` returns "Receiving end does not exist" on many sites the user visits (Reddit observed in the wild), and `tab.url` from `chrome.tabs.query` can come back `undefined` for tabs the extension doesn't have host access to. The practical outcome of removing them was "extension silently broken on a chunk of real sites with no surfaced UX," not "same behavior with a cleaner permissions list." Trade-off restored: broad `host_permissions` triggers the Chrome Web Store in-depth review category but the extension actually works on the sites users open.

## [0.1.11] - 2026-05-01

### Fixed (Firefox AMO submission warnings)

- **Manifest:**
  - Removed `background.service_worker` from the Firefox manifest. Firefox ignores this key and was warning about it on every upload; `background.scripts` (which Firefox does honor) is what we actually use. Chrome continues to use `background.service_worker` from its own manifest template.
  - Bumped `browser_specific_settings.gecko.strict_min_version` from `121.0` to `140.0`. The previous value was inconsistent with `data_collection_permissions` (added in Firefox 140 / Firefox for Android 142), which AMO flagged as a contradiction.

- **API references:** Added a small build-time preprocessor (`scripts/build.mjs`) that strips Chrome-only API call sites from the Firefox dist. Markers in source: `// SSC_FIREFOX_STRIP_BEGIN` / `// SSC_FIREFOX_STRIP_ELSE` / `// SSC_FIREFOX_STRIP_END`. The Chrome dist keeps the original code, the Firefox dist gets the ELSE replacement (or nothing, if no ELSE is present). Used to silence 15 "API not implemented in Firefox" warnings from `chrome.tabCapture.getMediaStreamId`, `chrome.offscreen.createDocument` / `closeDocument`, and `chrome.runtime.getContexts`. Tab Capture mode is now genuinely absent from the Firefox bundle (not just runtime-guarded), and the entire `offscreen.html` / `offscreen.js` pair is omitted from the Firefox dist via a `FIREFOX_OMIT_FILES` allowlist.

## [0.1.10] - 2026-05-01

### Removed

- **`host_permissions: ["http://*/*", "https://*/*"]`** dropped from both Chrome and Firefox manifests. It triggered the Chrome Web Store "broad host permissions" reviewer warning while doing nothing for us — every code path was already covered by either the declared `content_scripts.matches` (which handles content-script injection on every page, the actual reason the extension needs broad reach) or the `tabs` permission (which covers `tab.url`/`tab.title` access and `chrome.tabs.update({muted})`). We don't use `chrome.scripting`, cookies, `webRequest`, or any cross-origin fetch, so there was no remaining caller for host_permissions.

## [0.1.9] - 2026-05-01

### Fixed

- **YouTube's player slider could permanently override the SSC level until the popup was reopened.** The `volumechange` enforcer had a 16 ms throttle that was meant to bound the cost of a hot-loop fight with a misbehaving page. In practice it was unnecessary (the `expectedVolume` short-circuit already prevents loops on our own writes) and it broke the common case: dragging YouTube's slider produces a burst of `el.volume` writes within a few milliseconds, the first wakes the enforcer and we re-assert, every other write lands inside the throttle window and is silently ignored, the drag ends with `el.volume` at YouTube's value, and `volumechange` never fires again so we never re-correct. The throttle is gone; the enforcer now responds to every page-driven write.

## [0.1.8] - 2026-05-01

### Reverted

- **Reverted 0.1.7's `el.volume = 1` pinning in Tab Capture mode.** The right semantics for Tab Capture is **multiplier**, not authoritative override: the gain node naturally composes on top of whatever the page is outputting (post the page's own volume UI), so YouTube's player slider × SSC slider = effective volume in the obvious way. Pinning `el.volume = 1` was both unnecessary (the gain node was already doing the right math) and fragile (modifying page state to win a fight that doesn't need to be fought leaves us exposed to whatever those pages decide to do next). Passthrough is back to fully inert — the content script does nothing in Tab Capture mode.
- **Practical consequences:** YouTube's player slider works normally in Tab Capture mode; setting YouTube to 50% with SSC at 50% gives 25% effective output. Meet's per-participant volume control works again. Meet's auto-reset to `el.volume = 1` is benign because that's just the page restoring its own state — it composes with our gain at 1 × SSC = SSC.

## [0.1.7] - 2026-05-01

### Changed

- **SSC is now authoritative over page volume sliders in Tab Capture mode.** Previously the content script sat fully inert in passthrough; the page's `el.volume` (YouTube's player slider, Twitch's, Spotify Web's) silently pre-multiplied the captured stream feeding the offscreen gain — so a user-set 50% on YouTube while SSC was at 50% effectively gave 25%. The content script now pins `el.volume = 1` on every tracked element while passthrough is active so SSC's gain node is the sole attenuator. Result: SSC slider value === actual tab output, regardless of what the page's own volume UI is doing.
- **Page-driven mute (`el.volume = 0`) is still respected** — explicit silence is treated as user intent and not overridden.
- **Trade-off:** Meet's per-participant volume control (which works by writing `el.volume` on individual `<audio>` elements) becomes a no-op while Tab Capture mode is engaged. Use the SSC slider to control the tab as a whole; Meet's per-participant slider doesn't take effect during capture. Disable Tab Capture mode if you need the per-participant control back.

## [0.1.6] - 2026-05-01

### Fixed

- **Tab Capture mode "auto-correcting" Google Meet (and any SPA) back to 100% after ~60 s.** Background's `tabs.onUpdated` listener was treating every URL change as a real navigation — including SPA `history.pushState` calls that Meet, YouTube, Slack, GitHub, etc. fire several times per minute as users move through their UIs. Each one cleared the tab's live volume override AND released the active Tab Capture chain (which unmuted the source tab, hence the jump back to 100%).
- The listener now compares the new URL's **origin** against the last known origin per tab (`lastOriginByTab`):
  - **Same-origin URL update** (SPA route change, hash update, query-param change within the same site) → keep state intact, just refresh the toolbar.
  - **Cross-origin** (real navigation away from the site) → clear the per-tab live override and release any active capture, as before.
- `lastOriginByTab` is seeded from existing tabs at `runtime.onStartup` / `runtime.onInstalled`, kept current as URL changes arrive, and pruned on tab close. First navigation in any tab without a stored origin is treated as same-origin (conservative — never resets state speculatively).

## [0.1.5] - 2026-05-01

### Changed

- **Tab Capture mode is hidden in Firefox** (and any other browser without `chrome.tabCapture`) instead of rendering as a disabled control with explanatory copy. Users on browsers where the feature isn't actionable shouldn't see it at all.

## [0.1.4] - 2026-05-01

### Added

- **Tab Capture mode (Chrome only, opt-in).** New top-of-Settings toggle that routes the entire active tab's audio through the extension instead of fighting individual `<audio>` / `<video>` elements. When engaged:
  - The popup calls `chrome.tabCapture.getMediaStreamId({ targetTabId })` from a user-gesture context (slider drag, chip click, toggle change, popup open) and hands the stream id off to the background service worker.
  - An MV3 **offscreen document** (`offscreen.html` / `offscreen.js`) hosts a single `AudioContext`; each captured tab gets its own `MediaStreamSource → GainNode → destination` chain. Per-tab gain is updated live as the slider moves.
  - The source tab is muted via `chrome.tabs.update({ muted: true })` to prevent double-playback. The pre-capture mute state is snapshotted and restored on release so a manual user mute is preserved.
  - Background broadcasts `SSC_PASSTHROUGH_MODE` to the content script of any captured tab, which then stops touching `el.volume` entirely — no more fights with Meet's auto-resets, because the extension owns the entire audio path downstream of the page.
  - Capture is released automatically when: the slider returns to 100%, the tab navigates to a new URL, the tab closes, or the user disables the global toggle (which also tears down every active capture).
- **`tabCapture` and `offscreen` are declared as `optional_permissions`** in the Chrome manifest so install-time permissions are unchanged. The toggle in Settings is the consent surface — Chrome shows the standard "this extension can capture the contents of your tabs" prompt the first time the user enables it. Firefox doesn't ship the `tabCapture` API; the toggle there auto-disables with explanatory copy.
- **Persistent preference** stored as `ssc_tab_capture_enabled`. Popup re-checks `chrome.permissions.contains` on every open and self-corrects if the user revoked the permission via `chrome://extensions` between sessions.

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

