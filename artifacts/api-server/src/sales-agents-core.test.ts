import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTO_TEXT_TEMPLATE,
  bucketTask,
  clampScore,
  firstNameOf,
  isWithinBusinessHours,
  leadQualifiesForSpeedToLead,
  normalizeProspectPhone,
  normalizeWebsite,
  parseBusinessDays,
  prospectDedupeKey,
  renderAutoText,
  shouldEscalate,
  summarizeSpeedToLead,
  validateAutoTextTemplate,
} from "./sales-agents-core";
import { extractJsonObject } from "./sales-ai";

test("first names are capitalised and company-looking names are ignored", () => {
  assert.equal(firstNameOf("maria alvarez"), "Maria");
  assert.equal(firstNameOf("  Jean-Luc Picard "), "Jean-Luc");
  assert.equal(firstNameOf("ACME123 Corp"), "");
  assert.equal(firstNameOf(null), "");
});

test("auto-text rendering fills tokens with friendly fallbacks", () => {
  assert.equal(renderAutoText("Hi {firstName}, about {service}.", { firstName: "Maria", service: "Laptop Repair" }), "Hi Maria, about Laptop Repair.");
  assert.equal(renderAutoText("Hi {firstName}, thanks!", {}), "Hi there, thanks!");
  assert.equal(renderAutoText("Thanks {company} team", { company: "" }), "Thanks team");
  assert.equal(renderAutoText("Hi {nope}", {}), "Hi {nope}");
});

test("the default template is valid and templates must allow opting out", () => {
  assert.equal(validateAutoTextTemplate(DEFAULT_AUTO_TEXT_TEMPLATE), null);
  assert.match(validateAutoTextTemplate("Hi {firstName}, we got your request!") ?? "", /STOP/);
  assert.match(validateAutoTextTemplate("Hi {name}, reply STOP to opt out") ?? "", /Unknown placeholder/);
  assert.match(validateAutoTextTemplate("x".repeat(500) + " STOP") ?? "", /480/);
});

test("business hours respect the configured time zone and days", () => {
  const hours = { businessHoursOnly: true, startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5], timezone: "America/New_York" };
  // Tue 2026-11-10 14:00 UTC = 09:00 New York (EST).
  assert.equal(isWithinBusinessHours(new Date("2026-11-10T14:00:00Z"), hours), true);
  assert.equal(isWithinBusinessHours(new Date("2026-11-10T13:59:00Z"), hours), false);
  assert.equal(isWithinBusinessHours(new Date("2026-11-10T23:00:00Z"), hours), false); // 18:00 local, exclusive
  assert.equal(isWithinBusinessHours(new Date("2026-11-08T15:00:00Z"), hours), false); // Sunday
  assert.equal(isWithinBusinessHours(new Date("2026-11-08T15:00:00Z"), { ...hours, businessHoursOnly: false }), true);
  assert.deepEqual(parseBusinessDays("5, 1,1,9,x,0"), [0, 1, 5]);
});

test("only inbound leads created after switch-on qualify; cold sources never do", () => {
  const enabledAt = new Date("2026-11-10T12:00:00Z");
  const settings = { enabled: true, enabledAt, excludedSources: ["lead_gen_agent"] };
  const after = new Date("2026-11-10T12:05:00Z");
  assert.equal(leadQualifiesForSpeedToLead({ source: "website_intake", createdAt: after }, settings), true);
  assert.equal(leadQualifiesForSpeedToLead({ source: "LEAD_GEN_AGENT", createdAt: after }, settings), false);
  assert.equal(leadQualifiesForSpeedToLead({ source: "website_intake", createdAt: new Date("2026-11-10T11:00:00Z") }, settings), false);
  assert.equal(leadQualifiesForSpeedToLead({ source: "website_intake", createdAt: after }, { ...settings, enabled: false }), false);
});

test("escalation fires once, only after the target and only without a contact", () => {
  const leadCreatedAt = new Date("2026-11-10T14:00:00Z");
  const at = (min: number) => new Date(leadCreatedAt.getTime() + min * 60_000);
  assert.equal(shouldEscalate({ leadCreatedAt, firstContactAt: null, escalatedAt: null }, 5, at(4)), false);
  assert.equal(shouldEscalate({ leadCreatedAt, firstContactAt: null, escalatedAt: null }, 5, at(5)), true);
  assert.equal(shouldEscalate({ leadCreatedAt, firstContactAt: at(3), escalatedAt: null }, 5, at(9)), false);
  assert.equal(shouldEscalate({ leadCreatedAt, firstContactAt: null, escalatedAt: at(6) }, 5, at(9)), false);
});

test("speed-to-lead metrics report median and share within target", () => {
  const base = new Date("2026-11-10T14:00:00Z");
  const ev = (contactMin: number | null, text = "sent", escalated = false) => ({
    leadCreatedAt: base,
    firstContactAt: contactMin == null ? null : new Date(base.getTime() + contactMin * 60_000),
    autoTextStatus: text,
    escalatedAt: escalated ? base : null,
  });
  const m = summarizeSpeedToLead([ev(2), ev(4), ev(12, "skipped", true), ev(null), ev(6)], 5);
  assert.deepEqual(m, { total: 5, contacted: 4, waiting: 1, medianMinutes: 5, withinTargetPct: 50, autoTextsSent: 4, escalations: 1 });
  assert.deepEqual(summarizeSpeedToLead([], 5), { total: 0, contacted: 0, waiting: 0, medianMinutes: null, withinTargetPct: null, autoTextsSent: 0, escalations: 0 });
});

test("prospect websites, phones, scores and dedupe keys are normalised", () => {
  assert.equal(normalizeWebsite("WWW.Example.com/"), "https://www.example.com");
  assert.equal(normalizeWebsite("http://shop.example.com/about"), "http://shop.example.com/about");
  assert.equal(normalizeWebsite("javascript:alert(1)"), null);
  assert.equal(normalizeWebsite("http://localhost:3000"), null);
  assert.equal(normalizeWebsite("not a url"), null);
  assert.equal(prospectDedupeKey("Anything", "https://www.example.com/x"), "web:example.com");
  assert.equal(prospectDedupeKey("Smith & Sons, LLC", null), prospectDedupeKey("smith and sons llc", null));
  assert.equal(prospectDedupeKey("Smith & Sons, LLC", null), "name:smith and sons");
  assert.equal(clampScore("87.6"), 88);
  assert.equal(clampScore(140), 100);
  assert.equal(clampScore("n/a"), 0);
  assert.equal(normalizeProspectPhone("(954) 637-7300"), "+19546377300");
  assert.equal(normalizeProspectPhone("1-954-637-7300"), "+19546377300");
  assert.equal(normalizeProspectPhone("637-7300"), null);
});

test("tasks are bucketed by the business-day calendar", () => {
  const now = new Date("2026-11-10T15:00:00Z"); // 10:00 New York
  assert.equal(bucketTask(null, now), "someday");
  assert.equal(bucketTask(new Date("2026-11-10T14:00:00Z"), now), "overdue");
  assert.equal(bucketTask(new Date("2026-11-11T04:30:00Z"), now), "today"); // 23:30 local same day
  assert.equal(bucketTask(new Date("2026-11-11T05:30:00Z"), now), "upcoming"); // 00:30 local next day
});

test("model JSON is pulled out of surrounding prose", () => {
  assert.deepEqual(extractJsonObject('Here you go:\n{"a":1,"b":{"c":2}}\nThanks'), { a: 1, b: { c: 2 } });
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject("{broken"), null);
});
