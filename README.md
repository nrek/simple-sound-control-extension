# Simple Sound Control

Browser extension (Manifest V3) that **fine-tunes audio for the active tab**—from mute up to **400%** gain—with a small, Material-inspired popup. **Ad-free.** Settings and saved levels stay **on your device** in extension storage.

**Repository:** [github.com/nrek/simple-sound-control-extension](https://github.com/nrek/simple-sound-control-extension)

## Layout

| Path | Role |
|------|------|
| **`src/`** | Shared extension source (JS, HTML, CSS, icons, license, changelog, etc.). Edit here. |
| **`manifests/manifest.chrome.json`** | Chrome `manifest.json` template (no Gecko block). |
| **`manifests/manifest.firefox.json`** | Firefox template (includes `browser_specific_settings.gecko`). |
| **`dist/chrome/`** | **Generated** Chrome load-out: copy of `src/` plus final `manifest.json`. |
| **`dist/firefox/`** | **Generated** Firefox load-out: same assets, Firefox manifest. |

`dist/` is gitignored. Run **`npm run build`** after changes so both folders stay in sync.

## Build

Requires **Node 18+** (no npm dependencies—only the script).

```bash
npm run build
```

This wipes `dist/` and recreates `dist/chrome` and `dist/firefox`.

## Install (development)

**Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** → choose **`dist/chrome`** (must run `npm run build` first).

**Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select **`dist/firefox/manifest.json`**.

Icons `icon-16.png` … `icon-128.png` live in **`src/`** and are copied into each `dist` tree.

## Features

- **0–400%** volume slider with live preview on the page  
- **Quick actions**: Mute, 20%, 50%, 100% (optional highlight for last preset)  
- **Save** boosts **per tab** and/or **per site (origin)** when you enable those options  
- **Light / Dark** popup theme (Settings); **accent** colors (purple, blue, teal, and more)  
- **Toolbar icon** shows an accent dot when the effective level is not 100%  
- **Saved volume states** list in Settings (delete rows with trash icon); tab entries drop when the tab closes  

## Permissions (why they exist)

| Permission | Purpose |
|------------|---------|
| `storage` | Save preferences, per-tab/per-origin volumes, live tab boost map, etc. |
| `tabs` | Resolve the active tab when sending volume updates from the popup. |
| `host_permissions` `http://*/*`, `https://*/*` | Inject the content script on normal web pages (the broadcast `tabs.sendMessage` covers all frames in the active tab). |

## How it works (short)

A **content script** attaches to `<audio>` / `<video>` elements and routes audio through a **Web Audio `GainNode`**. The **popup** and **service worker** coordinate level changes, persistence, and the toolbar icon.

This does **not** work on restricted pages (e.g. browser internal URLs, extension stores, PDF viewer, or pages without standard media). Very high gain can **clip or distort**—use your judgment.

## Privacy

No accounts, no telemetry in this codebase, and no third-party analytics. Data lives in extension **`storage.local`** on your machine. See **`src/SECURITY.md`** for reporting issues.

## Contributing

See **`CONTRIBUTING.md`**. Bug reports and PRs are welcome.

## License

**MIT** — see **`src/LICENSE`**.

## Repository documentation (in `src/`)

| File | Purpose |
|------|---------|
| `src/LICENSE` | MIT license text |
| `src/SECURITY.md` | How to report vulnerabilities privately |
| `src/CODE_OF_CONDUCT.md` | Contributor Covenant (community standards) |
| `src/SUPPORT.md` | Quick FAQ and where to get more help |
| `src/CHANGELOG.md` | Version history |

## Credits

Thoughtfully built by **[Craft & Logic](https://craftxlogic.com/)**.
