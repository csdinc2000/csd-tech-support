import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyPortalAdsMigration } from "./migrations/2026-11-11-portal-ads";
import { registerPortalAdRoutes } from "./portal-ads";
import { isAdLive, safeAdLink } from "./portal-ad-core";

const marker = `portal-ad-${process.pid}-${Date.now()}`;
const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]).toString("base64");
let server: Server | undefined;
let baseUrl = "";

before(async () => {
  await applyPortalAdsMigration();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.dbUser = { id: `${marker}-staff` } as any;
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });
  registerPortalAdRoutes(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await pool.query("DELETE FROM portal_ads WHERE title LIKE $1", [`${marker}%`]);
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const liveAds = async () =>
  ((await call("GET", "/api/portal/ads/active")).body.ads as Array<{ id: number; title: string }>)
    .filter((ad) => ad.title.startsWith(marker));

test("staff create ads; the portal only sees live ones, highest priority first", async () => {
  const live = await call("POST", "/api/crm/portal-ads", {
    title: `${marker} spring tune-up`, body: "20% off tune-ups this month.", imageBase64: tinyJpeg, imageAlt: "Laptop on a bench",
    linkUrl: "/portal/referrals", linkLabel: "See offer", priority: 5, delaySeconds: 2, suppressHours: 72,
  });
  assert.equal(live.status, 201);
  assert.equal(live.body.state, "live");
  assert.match(live.body.imageUrl, /^\/api\/crm\/portal-ads\/\d+\/image\?v=/);

  const top = await call("POST", "/api/crm/portal-ads", { title: `${marker} urgent`, priority: 9 });
  const off = await call("POST", "/api/crm/portal-ads", { title: `${marker} draft`, isActive: false });
  const later = await call("POST", "/api/crm/portal-ads", {
    title: `${marker} next week`, startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  assert.equal(off.body.state, "off");
  assert.equal(later.body.state, "scheduled");

  const ads = await liveAds();
  assert.deepEqual(ads.map((ad) => ad.id), [top.body.id, live.body.id]);
  const publicAd = (await call("GET", "/api/portal/ads/active")).body.ads.find((ad: any) => ad.id === live.body.id);
  assert.equal(publicAd.delaySeconds, 2);
  assert.equal(publicAd.suppressHours, 72);
  assert.equal(publicAd.impressions, undefined, "counters stay staff-only");

  const image = await fetch(`${baseUrl}/api/portal/ads/${live.body.id}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal((await fetch(`${baseUrl}/api/portal/ads/${off.body.id}/image`)).status, 404, "drafts stay private");
});

test("impressions, dismissals and clicks are counted for live ads only", async () => {
  const ad = (await call("POST", "/api/crm/portal-ads", { title: `${marker} counted` })).body;
  const draft = (await call("POST", "/api/crm/portal-ads", { title: `${marker} hidden`, isActive: false })).body;
  for (const type of ["impression", "impression", "dismiss", "click"]) {
    assert.equal((await call("POST", `/api/portal/ads/${ad.id}/events`, { type })).status, 204);
  }
  await call("POST", `/api/portal/ads/${draft.id}/events`, { type: "impression" });
  assert.equal((await call("POST", `/api/portal/ads/${ad.id}/events`, { type: "purchase" })).status, 400);

  const listed = (await call("GET", "/api/crm/portal-ads")).body.ads;
  const counted = listed.find((row: any) => row.id === ad.id);
  assert.deepEqual([counted.impressions, counted.dismissals, counted.clicks], [2, 1, 1]);
  assert.equal(listed.find((row: any) => row.id === draft.id).impressions, 0);
});

test("unsafe links and backwards dates are rejected; edits and deletes apply", async () => {
  assert.equal((await call("POST", "/api/crm/portal-ads", { title: `${marker} bad`, linkUrl: "javascript:alert(1)" })).status, 400);
  const start = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(
    (await call("POST", "/api/crm/portal-ads", { title: `${marker} bad`, startsAt: start, endsAt: new Date().toISOString() })).status,
    400,
  );

  const ad = (await call("POST", "/api/crm/portal-ads", { title: `${marker} editable`, imageBase64: tinyJpeg })).body;
  const edited = await call("PUT", `/api/crm/portal-ads/${ad.id}`, { title: `${marker} edited`, isActive: false, removeImage: true });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.state, "off");
  assert.equal(edited.body.imageUrl, null);
  assert.equal((await call("DELETE", `/api/crm/portal-ads/${ad.id}`)).status, 204);
  assert.equal((await call("DELETE", `/api/crm/portal-ads/${ad.id}`)).status, 404);
});

test("link and live-window rules", () => {
  assert.equal(safeAdLink("/portal/ticket"), "/portal/ticket");
  assert.equal(safeAdLink("https://example.com/deal"), "https://example.com/deal");
  assert.equal(safeAdLink("//evil.example"), null);
  assert.equal(safeAdLink("data:text/html,hi"), null);
  const now = new Date("2026-11-11T12:00:00Z");
  assert.equal(isAdLive({ isActive: true, startsAt: null, endsAt: null }, now), true);
  assert.equal(isAdLive({ isActive: true, startsAt: null, endsAt: now }, now), false);
  assert.equal(isAdLive({ isActive: false, startsAt: null, endsAt: null }, now), false);
});
