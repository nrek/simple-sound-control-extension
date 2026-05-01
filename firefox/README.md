# Simple Sound Control (Firefox)

**Firefox** WebExtensions build (Manifest V3) in this `firefox/` folder—same behavior as the Chrome build in `../chrome/`. **Ad-free.** Settings and saved levels stay **on your device** in extension storage.

**Repository:** [github.com/nrek/simple-sound-control-extension](https://github.com/nrek/simple-sound-control-extension)

## Features

Same as the Chrome build: **0–400%** gain, quick presets, save per tab / per origin, accent theming, toolbar dot when level ≠ 100%, saved lists in Settings.

## Install

**From Firefox Add-ons (AMO)** once published: search for *Simple Sound Control* or use the listing URL.

**From source (development)**

1. Clone this repository.  
2. Open Firefox to **`about:debugging#/runtime/this-firefox`**.  
3. Under **Temporary Extensions**, click **Load Temporary Add-on…** and choose **`firefox/manifest.json`** in this repo.

Icons `icon-16.png` … `icon-128.png` must sit beside `manifest.json` (see `manifest.json` `icons` / `action.default_icon`).

Requires **Firefox 121+** (see `manifest.json` → `browser_specific_settings.gecko.strict_min_version`) for Manifest V3 parity with this codebase.

## Permissions (why they exist)

| Permission | Purpose |
|------------|---------|
| `storage` | Save preferences, per-tab/per-origin volumes, live tab boost map, etc. |
| `tabs` | Resolve the active tab when sending volume updates from the popup. |
| `webNavigation` | Enumerate frames so embedded players (iframes) receive the same level. |
| `host_permissions` `http://*/*`, `https://*/*` | Inject the content script on normal web pages. |

## How it works (short)

Same architecture as Chrome: a **content script** uses Web Audio on `<audio>` / `<video>`; the **popup** and **service worker** coordinate updates and the toolbar icon.

Does **not** apply on restricted pages (e.g. `about:`, AMO, PDF viewer, or pages without standard media). Very high gain can **clip or distort**.

## Privacy

No accounts, no telemetry in this codebase. Data lives in **`browser.storage.local`** (same keys as the Chrome build). See **`SECURITY.md`**.

## Contributing / license / docs

See **`../chrome/README.md`** for the full documentation table, **`CONTRIBUTING.md`**, **`LICENSE`** (MIT), and the rest of the repo docs in this folder.

## Credits

Thoughtfully built by **[Craft & Logic](https://craftxlogic.com/)**.
