# Simple Sound Control

**Chrome** build (Manifest V3) in this `chrome/` folder. It **fine-tunes audio for the active tab**—from mute up to **400%** gain—with a small, Material-inspired popup. **Ad-free.** Settings and saved levels stay **on your device** in extension storage.

**Repository:** [github.com/nrek/simple-sound-control-extension](https://github.com/nrek/simple-sound-control-extension)

## Features

- **0–400%** volume slider with live preview on the page  
- **Quick actions**: Mute, 20%, 50%, 100% (optional highlight for last preset)  
- **Save** boosts **per tab** and/or **per site (origin)** when you enable those options  
- **Accent theming** (purple, blue, teal, and more)  
- **Toolbar icon** shows an accent dot when the effective level is not 100%  
- **Saved volume states** list in Settings (delete rows with trash icon); tab entries drop when the tab closes  

## Install

**From the Chrome Web Store** (recommended once published): search for *Simple Sound Control* or use your listing URL.

**From source (development)**

1. Clone this repository.  
2. Open `chrome://extensions`, enable **Developer mode**.  
3. Click **Load unpacked** and select the **`chrome`** folder in this repository (the directory that contains `manifest.json`).  

Icons `icon-16.png` … `icon-128.png` must be present beside `manifest.json` (see `manifest.json` `icons` / `action.default_icon`).

## Permissions (why they exist)

| Permission | Purpose |
|------------|---------|
| `storage` | Save preferences, per-tab/per-origin volumes, live tab boost map, etc. |
| `tabs` | Resolve the active tab when sending volume updates from the popup. |
| `webNavigation` | Enumerate frames so embedded players (iframes) receive the same level. |
| `host_permissions` `http://*/*`, `https://*/*` | Inject the content script on normal web pages. |

## How it works (short)

A **content script** attaches to `<audio>` / `<video>` elements and routes audio through a **Web Audio `GainNode`**. The **popup** and **service worker** coordinate level changes, persistence, and the toolbar icon.

This does **not** work on `chrome://`, the Chrome Web Store, PDF viewer, or pages without standard media elements. Very high gain can **clip or distort**—use your judgment.

## Privacy

No accounts, no telemetry in this codebase, and no third-party analytics. Data lives in extension **`storage.local`** on your machine. See **`SECURITY.md`** for reporting issues.

## Contributing

See **`CONTRIBUTING.md`**. Bug reports and PRs are welcome.

## License

**MIT** — see **`LICENSE`**.

## Repository documentation

| File | Purpose |
|------|---------|
| `LICENSE` | MIT license text |
| `SECURITY.md` | How to report vulnerabilities privately |
| `CONTRIBUTING.md` | Fork / PR workflow and expectations |
| `CODE_OF_CONDUCT.md` | Contributor Covenant (community standards) |
| `SUPPORT.md` | Quick FAQ and where to get more help |
| `CHANGELOG.md` | Version history |
| `.gitignore` | Files to exclude from git (zips, keys, OS cruft) |

## Credits

Thoughtfully built by **[Craft & Logic](https://craftxlogic.com/)**.
