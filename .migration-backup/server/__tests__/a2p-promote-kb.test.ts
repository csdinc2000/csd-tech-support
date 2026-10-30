import { test } from "node:test";
import assert from "node:assert/strict";

const {
  slugifyHintId,
  suggestPatternFromReason,
  buildA2pHintSnippet,
  buildA2pHintBatchSnippet,
  isA2pSuggestionExportEligible,
  matchA2pRejection,
} = await import("@/lib/a2p-rejections");

test("slugifyHintId produces kebab-case ids and caps length", () => {
  assert.equal(slugifyHintId("EIN doesn't match IRS records"), "ein-doesn-t-match-irs");
  assert.equal(slugifyHintId("Website Privacy Policy"), "website-privacy-policy");
  // Falls back when nothing usable remains.
  assert.equal(slugifyHintId("!!!"), "custom-rejection");
  // Cap at five segments.
  assert.equal(slugifyHintId("a b c d e f g"), "a-b-c-d-e");
});

test("suggestPatternFromReason picks distinctive words, escapes, and compiles", () => {
  const pattern = suggestPatternFromReason(
    "The EIN you provided does not match IRS records for this business",
  );
  // Stopwords like "the"/"you"/"does"/"not"/"this"/"for" are dropped; real
  // keywords survive as word-boundary tokens joined with wildcards.
  assert.match(pattern, /\\bein\\b/);
  assert.match(pattern, /\\bmatch\\b/);
  assert.doesNotMatch(pattern, /\\bthe\\b/);
  // It must compile and still match the original reason.
  const re = new RegExp(pattern, "i");
  assert.ok(re.test("The EIN you provided does not match IRS records for this business"));
});

test("suggestPatternFromReason falls back to .* when no keywords", () => {
  assert.equal(suggestPatternFromReason("a an"), ".*");
  assert.equal(suggestPatternFromReason(""), ".*");
});

test("buildA2pHintSnippet emits a valid, parseable hint block", () => {
  const snippet = buildA2pHintSnippet({
    id: "test-hint",
    pattern: "\\bfoo\\b.*\\bbar\\b",
    title: 'A "quoted" title',
    remediation: "Do the thing.",
    docUrl: "https://example.com/help",
  });
  assert.match(snippet, /id: "test-hint",/);
  assert.match(snippet, /pattern: \/\\bfoo\\b\.\*\\bbar\\b\/i,/);
  // Quotes in user text are escaped so the literal stays valid.
  assert.match(snippet, /title: "A \\"quoted\\" title",/);
  assert.match(snippet, /docUrl: "https:\/\/example\.com\/help",/);
});

test("buildA2pHintSnippet defaults blank pattern/id/docUrl", () => {
  const snippet = buildA2pHintSnippet({
    id: "",
    pattern: "",
    title: "T",
    remediation: "R",
    docUrl: "",
  });
  assert.match(snippet, /id: "custom-rejection",/);
  assert.match(snippet, /pattern: \/\.\*\/i,/);
  // Falls back to the Twilio troubleshooting doc when no URL is given.
  assert.match(snippet, /docUrl: "https:\/\/help\.twilio\.com\//);
});

test("buildA2pHintSnippet escapes newlines/tabs so multiline text stays valid", () => {
  const snippet = buildA2pHintSnippet({
    id: "multi",
    pattern: "\\bfoo\\b",
    title: "Line1\nLine2",
    remediation: "First line.\n\tSecond line.\r\nThird.",
    docUrl: "https://example.com",
  });
  // No raw newline/tab should survive inside the emitted string literals —
  // every emitted line stays a single source line.
  assert.match(snippet, /title: "Line1\\nLine2",/);
  assert.match(snippet, /"First line\.\\n\\tSecond line\.\\r\\nThird\.",/);
  // The snippet must be the expected 8 source lines (no stray wraps).
  assert.equal(snippet.split("\n").length, 8);
});

test("buildA2pHintSnippet escapes forward slashes in the regex literal", () => {
  const snippet = buildA2pHintSnippet({
    id: "slashy",
    pattern: "https?://example\\.com/path",
    title: "T",
    remediation: "R",
    docUrl: "https://example.com",
  });
  // Unescaped "/" would prematurely close the /.../ literal; it must be \/.
  assert.match(snippet, /pattern: \/https\?:\\\/\\\/example\\\.com\\\/path\/i,/);
  // Already-escaped slashes must not be double-escaped.
  const snippet2 = buildA2pHintSnippet({
    id: "x",
    pattern: "a\\/b",
    title: "T",
    remediation: "R",
    docUrl: "https://example.com",
  });
  assert.match(snippet2, /pattern: \/a\\\/b\/i,/);
});

test("buildA2pHintBatchSnippet combines copy-paste-ready blocks in order", () => {
  const snippet = buildA2pHintBatchSnippet([
    { id: "first", pattern: "\\bfirst\\b", title: "First", remediation: "Fix first.", docUrl: "" },
    { id: "second", pattern: "\\bsecond\\b", title: "Second", remediation: "Fix second.", docUrl: "https://example.com/second" },
  ]);
  assert.equal((snippet.match(/^  \{$/gm) || []).length, 2);
  assert.ok(snippet.indexOf('id: "first"') < snippet.indexOf('id: "second"'));
  assert.match(snippet, /\},\n  \{/);
});

test("buildA2pHintBatchSnippet returns an empty string for no selections", () => {
  assert.equal(buildA2pHintBatchSnippet([]), "");
});

test("buildA2pHintBatchSnippet makes duplicate generated ids unique", () => {
  const snippet = buildA2pHintBatchSnippet([
    { id: "same-title", pattern: "one", title: "Same title", remediation: "First.", docUrl: "" },
    { id: "same-title", pattern: "two", title: "Same title", remediation: "Second.", docUrl: "" },
  ]);
  assert.match(snippet, /id: "same-title",/);
  assert.match(snippet, /id: "same-title-2",/);
});

test("buildA2pHintBatchSnippet avoids collisions with naturally suffixed ids", () => {
  const snippet = buildA2pHintBatchSnippet([
    { id: "foo", pattern: "one", title: "One", remediation: "First.", docUrl: "" },
    { id: "foo", pattern: "two", title: "Two", remediation: "Second.", docUrl: "" },
    { id: "foo-2", pattern: "three", title: "Three", remediation: "Third.", docUrl: "" },
  ]);
  const ids = [...snippet.matchAll(/^\s+id: "([^"]+)",$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ["foo", "foo-3", "foo-2"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("only reviewed suggestions are eligible for batch export", () => {
  assert.equal(isA2pSuggestionExportEligible("reviewed"), true);
  assert.equal(isA2pSuggestionExportEligible("pending"), false);
  assert.equal(isA2pSuggestionExportEligible("merged"), false);
  assert.equal(isA2pSuggestionExportEligible("dismissed"), false);
});

test("duplicate detection: a reason covered by an existing pattern is matched", () => {
  // This mirrors the warning shown in the Promote dialog.
  const match = matchA2pRejection(
    "Your EIN does not match the IRS records for the legal business name",
  );
  assert.ok(match, "expected an existing hint to match");
  assert.equal(match?.hint.id, "ein-mismatch");
});
