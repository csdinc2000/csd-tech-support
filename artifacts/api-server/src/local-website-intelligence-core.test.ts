import assert from "node:assert/strict";
import test from "node:test";
import {
  boundingBox,
  collectTechnologyNames,
  isRetryableOverpassFailure,
  mapWhatCmsResponse,
  osmSearchCacheKey,
  overpassBusinessQuery,
  publicWebsite,
  validPublicWebsite,
} from "./local-website-intelligence-core.ts";

test("website validation accepts public HTTPS hosts and rejects local or ambiguous addresses", () => {
  assert.equal(validPublicWebsite("https://example.com")?.hostname, "example.com");
  assert.equal(validPublicWebsite("http://example.com", true), null);
  assert.equal(validPublicWebsite("https://127.0.0.1"), null);
  assert.equal(validPublicWebsite("https://localhost"), null);
  assert.equal(validPublicWebsite("https://host.local"), null);
  assert.equal(validPublicWebsite("https://user:pass@example.com"), null);
  assert.equal(validPublicWebsite("https://example.com/?token=secret"), null);
  assert.equal(validPublicWebsite("file:///etc/passwd"), null);
});

test("discovered public websites are normalized without credentials or tracking query strings", () => {
  assert.equal(publicWebsite(" example.com/path/?utm_source=listing#top "), "https://example.com/path");
  assert.equal(publicWebsite("javascript:alert(1)"), null);
});

test("WhatCMS technology extraction deduplicates and caps provider results", () => {
  assert.deepEqual(
    collectTechnologyNames({ results: [{ name: "PHP" }, { technology: "WordPress" }, { name: "PHP" }] }),
    ["PHP", "WordPress"],
  );
  assert.equal(collectTechnologyNames({ technologies: Array.from({ length: 70 }, (_, i) => `Tech ${i}`) }).length, 50);
});

test("WhatCMS result codes distinguish WordPress, no detection, unavailable, and limits", () => {
  assert.deepEqual(
    mapWhatCmsResponse({ result: { code: 200, name: "WordPress" }, technologies: [{ name: "PHP" }] }),
    {
      status: "success",
      cms: "WordPress",
      language: null,
      technologies: ["PHP"],
      isWordPressOpportunity: true,
      message: null,
    },
  );
  assert.equal(mapWhatCmsResponse({ result: { code: 201 } }).status, "not_detected");
  assert.equal(mapWhatCmsResponse({ result: { code: 202 } }).status, "unavailable");
  assert.equal(mapWhatCmsResponse({ result: { code: 120 } }).status, "rate_limited");
});

test("OpenStreetMap search uses one cheap bounding-box query around the center", () => {
  const [south, west, north, east] = boundingBox(26.1664, -80.2134, 5).split(",").map(Number);
  assert.ok(south < 26.1664 && north > 26.1664 && west < -80.2134 && east > -80.2134);
  assert.ok(Math.abs((north - south) / 2 - 5 / 69) < 0.0001);
  const query = overpassBusinessQuery(26.1664, -80.2134, 5);
  assert.match(query, /\[bbox:[-\d.,]+\]/);
  assert.doesNotMatch(query, /around:/);
});

test("overloaded or unreachable Overpass servers are retried on the next server; bad requests are not", () => {
  for (const status of [429, 502, 503, 504]) {
    assert.equal(isRetryableOverpassFailure({ response: { status } }), true, String(status));
  }
  assert.equal(isRetryableOverpassFailure({ code: "ECONNABORTED" }), true);
  assert.equal(isRetryableOverpassFailure({ code: "ECONNREFUSED" }), true);
  assert.equal(isRetryableOverpassFailure({ response: { status: 400 } }), false);
});

test("search cache keys group nearby searches with the same radius", () => {
  assert.equal(osmSearchCacheKey(26.16641, -80.21339, 5), osmSearchCacheKey(26.16639, -80.21341, 5));
  assert.notEqual(osmSearchCacheKey(26.1664, -80.2134, 5), osmSearchCacheKey(26.1664, -80.2134, 10));
});
