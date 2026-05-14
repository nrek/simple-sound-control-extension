const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const popupHtml = fs.readFileSync(path.join(root, "src", "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "src", "popup.js"), "utf8");

test("main screen labels domain pinning as Pin Settings", () => {
  assert.match(popupHtml, /Pin Settings: this domain/);
  assert.doesNotMatch(popupHtml, /Pin Volume Level/);
});

test("settings pins header has a filter toggle and hidden search box", () => {
  assert.match(popupHtml, /<h3 id="pinned-label" class="settings-heading">Pins<\/h3>/);
  assert.match(popupHtml, /id="pinned-filter-toggle"/);
  assert.match(popupHtml, /aria-label="Toggle pin filter"/);
  assert.match(popupHtml, /id="pinned-filter"[\s\S]*placeholder="Search list\.\.\."[\s\S]*hidden/);
});

test("filter toggle reveals the pinned filter input", () => {
  assert.match(popupJs, /pinnedFilterToggle\.addEventListener\("click"/);
  assert.match(popupJs, /pinnedFilter\.hidden = !pinnedFilter\.hidden/);
});
