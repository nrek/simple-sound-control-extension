# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

