# Contributing

Thanks for helping improve **Simple Sound Control**.

## Getting started

1. **Fork** the repository and create a **branch** for your change (`fix/…`, `feat/…`, etc.).  
2. **Load unpacked** in Chrome (`chrome://extensions` → Developer mode → Load unpacked → the **`chrome`** directory in this repo).  
3. Make your change and **manually test** on a few real sites (e.g. a page with `<video>`).  
4. Open a **Pull Request** with a clear description of what changed and why.

There is no bundler or npm build for the extension today—edits land directly in the files listed in `manifest.json`.

## Guidelines

- **Small, focused PRs** are easier to review than large refactors mixed with fixes.  
- **Match existing style** (plain JS, naming, formatting) unless you are standardizing something across the whole project.  
- **Do not** add remote analytics, tracking pixels, or new third-party script CDNs without an explicit maintainer decision and manifest/CSP updates.  
- **Permissions:** new `permissions` / `host_permissions` need a clear user-facing justification in the PR and in `README.md`.

## Issues

- Use **GitHub Issues** for bugs and feature ideas (non-security).  
- Search existing issues first to avoid duplicates.  
- Include Chrome version, extension version, and steps to reproduce when reporting bugs.

## Code of conduct

All contributors are expected to follow **`CODE_OF_CONDUCT.md`**.
