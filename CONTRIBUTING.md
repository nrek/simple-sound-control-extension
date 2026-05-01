# Contributing

Thanks for helping improve **Simple Sound Control**.

## Getting started

1. **Fork** the repository and create a **branch** for your change (`fix/…`, `feat/…`, etc.).  
2. Edit **`src/`** (shared runtime) and/or **`manifests/manifest.chrome.json`** / **`manifests/manifest.firefox.json`** when manifest fields differ by browser.  
3. Run **`npm run build`** and load **`dist/chrome`** (Chrome) or **`dist/firefox/manifest.json`** (Firefox temporary add-on) to test.  
4. Open a **Pull Request** with a clear description of what changed and why.

There is no bundler—`scripts/build.mjs` copies `src/` into `dist/chrome` and `dist/firefox` and writes each `manifest.json` from the templates.

## Guidelines

- **Small, focused PRs** are easier to review than large refactors mixed with fixes.  
- **Match existing style** (plain JS, naming, formatting) unless you are standardizing something across the whole project.  
- **Do not** add remote analytics, tracking pixels, or new third-party script CDNs without an explicit maintainer decision and manifest/CSP updates.  
- **Permissions:** new `permissions` / `host_permissions` need a clear user-facing justification in the PR and in **`README.md`**.

## Issues

- Use **GitHub Issues** for bugs and feature ideas (non-security).  
- Search existing issues first to avoid duplicates.  
- Include browser name/version, extension version, and steps to reproduce when reporting bugs.

## Code of conduct

All contributors are expected to follow **`src/CODE_OF_CONDUCT.md`**.
