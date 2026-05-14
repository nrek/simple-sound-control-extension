const test = require("node:test");
const assert = require("node:assert/strict");

const pinPolicy = require("../src/pin-policy.js");

test("normalizes a full URL to its parent origin for pinned volume", () => {
  assert.equal(
    pinPolicy.originFromUrl("https://adshflsadjfds.com/?yay-aiudhfsdkfjndsf"),
    "https://adshflsadjfds.com"
  );
  assert.equal(
    pinPolicy.originFromUrl("https://adshflsadjfds.com/path/child?x=1#hash"),
    "https://adshflsadjfds.com"
  );
});

test("uses exact origin scope and does not collapse sibling subdomains", () => {
  assert.equal(pinPolicy.originFromUrl("https://www.youtube.com/watch?v=abc"), "https://www.youtube.com");
  assert.notEqual(
    pinPolicy.originFromUrl("https://www.youtube.com/watch?v=abc"),
    pinPolicy.originFromUrl("https://music.youtube.com/watch?v=abc")
  );
});

test("upserts a pinned domain row by origin", () => {
  const first = pinPolicy.upsertPinnedLevel([], {
    origin: "https://www.youtube.com",
    tabUrl: "https://www.youtube.com/watch?v=abc",
    title: "Video A",
    volume: 50,
  });
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    id: "origin:https://www.youtube.com",
    origin: "https://www.youtube.com",
    url: "https://www.youtube.com/watch?v=abc",
    title: "www.youtube.com",
    volume: 50,
  });

  const second = pinPolicy.upsertPinnedLevel(first, {
    origin: "https://www.youtube.com",
    tabUrl: "https://www.youtube.com/watch?v=def",
    title: "Video B",
    volume: 25,
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].volume, 25);
  assert.equal(second[0].url, "https://www.youtube.com/watch?v=def");
});

test("filters and paginates pinned domains six per page", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `origin:https://site${i + 1}.example.com`,
    origin: `https://site${i + 1}.example.com`,
    volume: 10 + i,
  }));

  const page1 = pinPolicy.paginatePinnedRows(rows, "", 1);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.items.length, 6);
  assert.equal(page1.currentPage, 1);

  const page2 = pinPolicy.paginatePinnedRows(rows, "", 2);
  assert.equal(page2.items.length, 2);
  assert.equal(page2.currentPage, 2);

  const filtered = pinPolicy.paginatePinnedRows(rows, "site8", 1);
  assert.equal(filtered.totalPages, 1);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].origin, "https://site8.example.com");
});

test("removes a pinned level by origin or row id", () => {
  const rows = [
    { id: "origin:https://a.example.com", origin: "https://a.example.com", volume: 25 },
    { id: "origin:https://b.example.com", origin: "https://b.example.com", volume: 75 },
  ];

  assert.deepEqual(pinPolicy.removePinnedLevel(rows, "https://a.example.com"), [
    { id: "origin:https://b.example.com", origin: "https://b.example.com", title: "b.example.com", volume: 75 },
  ]);
  assert.deepEqual(pinPolicy.removePinnedLevel(rows, "origin:https://b.example.com"), [
    { id: "origin:https://a.example.com", origin: "https://a.example.com", title: "a.example.com", volume: 25 },
  ]);
});
