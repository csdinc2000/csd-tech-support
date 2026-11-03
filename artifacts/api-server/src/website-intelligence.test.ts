import assert from "node:assert/strict";
import test from "node:test";
import { assessWebsite, draftProposal } from "./website-intelligence.ts";

test("CMS observation suggests maintenance without alleging a vulnerability", () => {
  const assessment = assessWebsite({ domain: "Example.COM", technologies: [{ name: "WordPress", category: "cms", source: "provider", observedAt: "2026-11-02", confidence: "probable" }] });
  assert.equal(assessment.domain, "example.com");
  assert.deepEqual(assessment.opportunities.map(o => o.kind), ["maintenance"]);
});

test("uncertain software versions do not trigger an outdated security claim", () => {
  const assessment = assessWebsite({ domain: "example.com", technologies: [{ name: "PHP", category: "language", version: "8.0", source: "provider", observedAt: "2026-11-02", confidence: "probable", supportedStatus: "outdated", advisoryUrl: "https://www.php.net/supported-versions.php" }] });
  assert.equal(assessment.opportunities.some(o => o.kind === "security-review"), false);
});

test("confirmed outdated software with evidence is flagged only for an authorized review", () => {
  const assessment = assessWebsite({ domain: "example.com", technologies: [{ name: "PHP", category: "language", version: "8.0", source: "authorized-audit", observedAt: "2026-11-02", confidence: "confirmed", supportedStatus: "outdated", advisoryUrl: "https://www.php.net/supported-versions.php" }] });
  assert.equal(assessment.opportunities.find(o => o.kind === "security-review")?.assessmentRequired, true);
});

test("proposal remains a draft with explicit prices only", () => {
  const quote = draftProposal([{ label: "Consulting", unitPriceCents: 7500, quantity: 2 }]);
  assert.equal(quote.subtotalCents, 15000);
  assert.equal(quote.status, "draft-needs-review");
});

test("rejects arbitrary URLs and invalid quote values", () => {
  assert.throws(() => assessWebsite({ domain: "http://127.0.0.1", technologies: [] }));
  assert.throws(() => draftProposal([{ label: "Bad price", unitPriceCents: -1, quantity: 1 }]));
});
