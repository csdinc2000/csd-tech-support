import assert from "node:assert/strict";
import test from "node:test";
import {
  collectTechnologyNames,
  mapWhatCmsResponse,
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
