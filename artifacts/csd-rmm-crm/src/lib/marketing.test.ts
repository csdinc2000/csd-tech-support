import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttribution,
  buildUtmUrl,
  campaignPerformance,
  channelLabel,
  leadChannel,
  dailyTrend,
  fillTemplate,
  leadFunnel,
  since,
  smsSegments,
  weekKey,
  type MarketingLead,
} from "./marketing.ts";

const lead = (id: number, source: string | null, status: string, extra: Partial<MarketingLead> = {}): MarketingLead => ({
  id,
  source,
  campaign: null,
  status,
  estimatedValue: null,
  createdAt: "2026-10-20T12:00:00Z",
  ...extra,
});

test("channelLabel collapses source spellings into one channel", () => {
  assert.equal(channelLabel("website_intake"), "Website");
  assert.equal(channelLabel("Website Intake Form"), "Website");
  assert.equal(channelLabel("phone_call"), "Phone");
  assert.equal(channelLabel("Phone Link"), "Phone");
  assert.equal(channelLabel("Google PPC"), "Google Ads");
  assert.equal(channelLabel("Google Search"), "Google Search");
  assert.equal(channelLabel("Referral from Friend/Family"), "Referral");
  assert.equal(channelLabel("Flyer/Advertisement"), "Flyers & Ads");
  assert.equal(channelLabel("Social Media"), "Social Media");
  assert.equal(channelLabel("google_ads"), "Google Ads");
  assert.equal(channelLabel("Referral"), "Referral");
  assert.equal(channelLabel(null), "Unattributed");
  assert.equal(channelLabel("  "), "Unattributed");
  assert.equal(channelLabel("church_bulletin"), "Church Bulletin");
});

test("intake leads use the how-did-you-hear answer as their channel and inherit the intake's UTM campaign", () => {
  assert.equal(leadChannel({ source: "website_intake", campaign: "Google Search" }), "Google Search");
  assert.equal(leadChannel({ source: "website_intake", campaign: null }), "Website");
  assert.equal(leadChannel({ source: "google_ads", campaign: "Spring" }), "Google Ads");

  const rows = campaignPerformance({
    leads: [
      lead(1, "website_intake", "won", { campaign: "Social Media", intakeRecordId: 9 }),
      lead(2, "website_intake", "new", { campaign: "Google Search", intakeRecordId: 10 }),
    ],
    intakes: [
      { id: 9, source: "website_intake", howDidYouHear: "Social Media", campaign: "fall-promo", createdAt: null },
      { id: 10, source: "website_intake", howDidYouHear: "Google Search", campaign: "voice_intake", createdAt: null },
    ],
    numbers: [],
  });
  assert.equal(rows.length, 1, "how-heard answers and the voice marker are not campaigns");
  assert.equal(rows[0].campaign, "fall-promo");
  assert.equal(rows[0].leads, 1);
  const merged = campaignPerformance({
    leads: [],
    intakes: [{ id: 1, source: "web", campaign: "fall-promo", createdAt: null }],
    numbers: [{ campaignName: "Fall Promo", sourceChannel: null, phoneNumber: "+19545550000", totalCalls: 2, uniqueCallers: 2 }],
  });
  assert.equal(merged.length, 1, "tracking-number names match their UTM form");
  assert.equal(merged[0].campaign, "Fall Promo");
  assert.equal(merged[0].calls, 2);
  assert.equal(rows[0].won, 1);
  assert.equal(rows[0].intakes, 1);
  assert.deepEqual(rows[0].channels, ["Social Media"]);
});

test("buildAttribution merges leads, requests, calls and lead-linked revenue per channel", () => {
  const rows = buildAttribution({
    leads: [
      lead(1, "website_intake", "won"),
      lead(2, "web", "new", { estimatedValue: 200 }),
      lead(3, "phone_call", "lost", { estimatedValue: 999 }),
    ],
    intakes: [{ source: "Website Intake Form", campaign: null, createdAt: null }],
    calls: [{ sourceChannel: "Google PPC", totalCalls: 5, uniqueCallers: 4 }],
    jobs: [
      { leadId: 1, status: "completed", finalAmount: 350, estimatedAmount: 300 },
      { leadId: 1, status: "in_progress", finalAmount: null, estimatedAmount: 100 },
      { leadId: null, status: "completed", finalAmount: 50, estimatedAmount: null },
    ],
  });
  const website = rows.find((r) => r.channel === "Website")!;
  assert.equal(website.leads, 2);
  assert.equal(website.won, 1);
  assert.equal(website.winRate, 0.5);
  assert.equal(website.pipelineValue, 200);
  assert.equal(website.revenue, 350);
  assert.equal(website.intakes, 1);
  assert.equal(website.touches, 3);

  const phone = rows.find((r) => r.channel === "Phone")!;
  assert.equal(phone.pipelineValue, 0, "lost leads leave the pipeline");

  const ads = rows.find((r) => r.channel === "Google Ads")!;
  assert.equal(ads.calls, 5);
  assert.equal(ads.winRate, null);
  assert.equal(rows[0].channel, ads.channel, "most touches first");
});

test("leadFunnel counts each lead toward its stage and every stage before it", () => {
  const { stages, lost } = leadFunnel([
    lead(1, null, "new"),
    lead(2, null, "contacted"),
    lead(3, null, "quoted"),
    lead(4, null, "won"),
    lead(5, null, "lost"),
  ]);
  assert.deepEqual(stages.map((s) => s.reached), [5, 3, 2, 2, 1]);
  assert.equal(stages[4].rate, 0.2);
  assert.equal(lost, 1);
  assert.deepEqual(leadFunnel([]).stages.map((s) => s.rate), [0, 0, 0, 0, 0]);
});

test("campaignPerformance groups by campaign name case-insensitively", () => {
  const rows = campaignPerformance({
    leads: [lead(1, "facebook", "won", { campaign: "Spring Tune-Up" }), lead(2, "web", "new", { campaign: "spring tune-up", estimatedValue: 80 })],
    intakes: [{ source: "web", campaign: "Spring Tune-Up", createdAt: null }, { source: "web", campaign: null, createdAt: null }],
    numbers: [{ campaignName: "Yard Signs", sourceChannel: "Direct Mail", phoneNumber: "+19545550000", totalCalls: 3, uniqueCallers: 3 }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].campaign, "Spring Tune-Up");
  assert.equal(rows[0].leads, 2);
  assert.equal(rows[0].won, 1);
  assert.equal(rows[0].intakes, 1);
  assert.equal(rows[0].pipelineValue, 80);
  assert.deepEqual(rows[0].channels, ["Social Media", "Website"]);
  assert.deepEqual(rows[1].trackingNumbers, ["+19545550000"]);
});

test("since and dailyTrend bucket by local day inside the window", () => {
  const now = new Date(2026, 9, 30, 15, 0);
  const items = [
    { createdAt: new Date(2026, 9, 30, 9, 0) },
    { createdAt: new Date(2026, 9, 28, 9, 0) },
    { createdAt: new Date(2026, 8, 1, 9, 0) },
    { createdAt: null },
  ];
  assert.equal(since(items, 7, now).length, 2);
  const trend = dailyTrend({ leads: items, intakes: [], callsByDay: [{ day: "2026-10-29", count: 4 }], days: 3, now });
  assert.deepEqual(trend.map((p) => p.day), ["2026-10-28", "2026-10-29", "2026-10-30"]);
  assert.deepEqual(trend.map((p) => p.leads), [1, 0, 1]);
  assert.equal(trend[1].calls, 4);
});

test("buildUtmUrl normalizes values and keeps existing query strings", () => {
  const { url, error } = buildUtmUrl({
    url: "support.computersystemsdepot.com/intake?ref=card#form",
    source: "Facebook",
    medium: "social",
    campaign: "Spring Tune Up",
  });
  assert.equal(error, null);
  assert.equal(url, "https://support.computersystemsdepot.com/intake?ref=card&utm_source=facebook&utm_medium=social&utm_campaign=spring-tune-up#form");
  assert.match(buildUtmUrl({ url: "", source: "a", medium: "b", campaign: "c" }).error!, /Enter the page URL/);
  assert.match(buildUtmUrl({ url: "https://x.com", source: "a", medium: "", campaign: "c" }).error!, /Medium is required/);
  assert.match(buildUtmUrl({ url: "http://exa mple", source: "a", medium: "b", campaign: "c" }).error!, /valid web address/);
});

test("fillTemplate fills placeholders and tidies blanks", () => {
  assert.equal(fillTemplate("Hi {{first}}, {{ business }} {{missing}}here.", { first: "Ana", business: "CSD" }), "Hi Ana, CSD here.");
});

test("smsSegments reports GSM-7 and UCS-2 segment counts", () => {
  assert.deepEqual(smsSegments(""), { encoding: "GSM-7", length: 0, segments: 0 });
  assert.equal(smsSegments("a".repeat(160)).segments, 1);
  assert.equal(smsSegments("a".repeat(161)).segments, 2);
  assert.equal(smsSegments("{").length, 2);
  const emoji = smsSegments("Thanks 🙂");
  assert.equal(emoji.encoding, "UCS-2");
  assert.equal(emoji.segments, 1);
});

test("weekKey uses ISO weeks", () => {
  assert.equal(weekKey(new Date(2026, 9, 30)), "2026-W44");
  assert.equal(weekKey(new Date(2027, 0, 1)), "2026-W53");
});
