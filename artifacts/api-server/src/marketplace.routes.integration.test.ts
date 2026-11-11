import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyMarketplaceMigration } from "./migrations/2026-09-16-marketplace";
import { registerRoutes } from "./routes/routes";
import { publicSellerName } from "./marketplace";

const marker = `marketplace-${process.pid}-${Date.now()}`;
const staffId = `${marker}-staff`;
const staffEmail = `${marker}-staff@example.invalid`;
const sellerEmail = `${marker}-seller@example.invalid`;
let server: Server | undefined;
let baseUrl = "";
const sentMail: Array<{ to: string; subject: string; replyTo?: string }> = [];
const scanned: Array<{ mimeType: string; bytes: number }> = [];

// Smallest valid JPEG (SOI + EOI markers) — enough to pass the magic-byte sniff.
const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]).toString("base64");
const notAnImage = Buffer.from("<html>nope</html>").toString("base64");

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    const actor = req.header("x-test-actor");
    const userId = actor === "staff" ? staffId : undefined;
    (req as any).auth = Object.assign(() => ({
      userId,
      sessionClaims: userId ? { userId, email: staffEmail } : undefined,
    }), { [Symbol.for("@clerk/express.auth")]: true });
    if (userId) {
      req.dbUser = {
        id: userId,
        email: staffEmail,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });
  server = await registerRoutes(app, {
    disableBackgroundServices: true,
    marketplaceMailer: async (to, subject, _text, options) => {
      sentMail.push({ to, subject, replyTo: options.replyTo });
    },
    marketplaceLookupReader: async (query) => ({ rawText: query, brand: "Dell", model: "XPS 15 9520", deviceType: "laptop", cpu: "Intel Core i7-12700H", ram: "16GB DDR5", storage: "512GB NVMe SSD" }),
    // Stand-in for the vision model: pretend every photo is a Legion sticker.
    marketplaceScanReader: async ({ mimeType, dataBase64 }) => {
      scanned.push({ mimeType, bytes: Buffer.from(dataBase64, "base64").length });
      return {
        rawText: "Lenovo Legion 5 Pro 16ACH6H\nRyzen 7 5800H  RTX 3070 8GB\n16GB DDR4  1TB NVMe SSD",
        brand: "Lenovo",
        deviceType: "laptop",
      };
    },
  });
  server.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
}

function request(path: string, init?: RequestInit & { actor?: "staff" }) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.actor ? { "x-test-actor": init.actor } : {}),
      ...init?.headers,
    },
  });
}

const listingBody = (overrides: Record<string, unknown> = {}) => ({
  title: `${marker} RTX 4070 gaming desktop`,
  description: "Ryzen 7 build, runs everything at 1440p. Includes power cable.",
  category: "gaming_pc",
  condition: "like_new",
  price: 1350,
  specs: { cpu: "Ryzen 7 7800X3D", gpu: "RTX 4070" },
  location: "Lauderhill",
  sellerName: "Marcus Thompson",
  sellerEmail,
  sellerPhone: "954-555-0100",
  showPhone: false,
  images: [{ dataBase64: tinyJpeg }],
  ...overrides,
});

before(async () => {
  await applyMarketplaceMigration();
  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Staff','Test') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [staffId, staffEmail],
  );
  await startServer();
});

after(async () => {
  await stopServer();
  await pool.query("DELETE FROM marketplace_listings WHERE LOWER(seller_email) = LOWER($1)", [sellerEmail]);
  await pool.query("DELETE FROM auth_users WHERE id = $1", [staffId]);
});

test("public seller name hides the surname", () => {
  assert.equal(publicSellerName("Marcus Thompson"), "Marcus T.");
  assert.equal(publicSellerName("Cher"), "Cher");
  assert.equal(publicSellerName("  "), "Seller");
});

test("portal submissions are held for review, emailed a manage link, and hidden until approved", async () => {
  const created = await request("/api/portal/marketplace/listings", {
    method: "POST",
    body: JSON.stringify(listingBody()),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id, managePath } = await created.json() as { id: number; managePath: string };
  assert.match(managePath, /^\/portal\/marketplace\/manage\/[A-Za-z0-9_-]+$/);
  assert.ok(sentMail.some((m) => m.to === sellerEmail && /received your listing/i.test(m.subject)));

  // Not in the public feed and not viewable directly while pending.
  const feed = await request(`/api/portal/marketplace/listings?q=${encodeURIComponent(marker)}`);
  assert.equal(feed.status, 200);
  assert.equal(((await feed.json()) as any).listings.length, 0);
  assert.equal((await request(`/api/portal/marketplace/listings/${id}`)).status, 404);

  // The seller can see their own pending listing with full contact details.
  const token = managePath.split("/").pop()!;
  const mine = await request(`/api/portal/marketplace/manage/${token}`);
  assert.equal(mine.status, 200, await mine.clone().text());
  const mineBody = await mine.json() as any;
  assert.equal(mineBody.listing.status, "pending");
  assert.equal(mineBody.listing.sellerEmail, sellerEmail);
  assert.equal(mineBody.listing.imageIds.length, 1);

  // A bogus token is rejected.
  assert.equal((await request(`/api/portal/marketplace/manage/not-a-real-token`)).status, 404);

  // Staff see it in the pending queue and can approve it.
  const queue = await request("/api/marketplace/listings?status=pending", { actor: "staff" });
  assert.equal(queue.status, 200, await queue.clone().text());
  const queueBody = await queue.json() as any;
  assert.ok(queueBody.listings.some((l: any) => l.id === id));
  assert.ok(queueBody.counts.pending >= 1);

  const rejected = await request(`/api/marketplace/listings/${id}/status`, {
    method: "POST", actor: "staff", body: JSON.stringify({ status: "rejected" }),
  });
  assert.equal(rejected.status, 400, "rejecting requires a note");

  const approved = await request(`/api/marketplace/listings/${id}/status`, {
    method: "POST", actor: "staff", body: JSON.stringify({ status: "active" }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal(((await approved.json()) as any).listing.status, "active");
  assert.ok(sentMail.some((m) => m.to === sellerEmail && /listing is live/i.test(m.subject)));

  // Now public — with the seller's identity reduced and phone hidden (showPhone=false).
  const detail = await request(`/api/portal/marketplace/listings/${id}`);
  assert.equal(detail.status, 200);
  const pub = await detail.json() as any;
  assert.equal(pub.sellerName, "Marcus T.");
  assert.equal(pub.sellerPhone, null);
  assert.equal(pub.sellerEmail, undefined);
  assert.equal(pub.priceCents, 135000);

  const image = await request(`/api/portal/marketplace/images/${pub.coverImageId}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");

  // Buyers reach the seller through the relay form; the email replies to the buyer.
  const contact = await request(`/api/portal/marketplace/listings/${id}/contact`, {
    method: "POST",
    body: JSON.stringify({ buyerName: "Alex Rivera", buyerEmail: "alex@example.invalid", message: "Is this still available? Can I see it Saturday?" }),
  });
  assert.equal(contact.status, 201, await contact.clone().text());
  const inquiryMail = sentMail.find((m) => m.to === sellerEmail && /interested in your listing/i.test(m.subject));
  assert.ok(inquiryMail);
  assert.equal(inquiryMail!.replyTo, "alex@example.invalid");

  // The seller sees the inquiry, can edit, and can mark the item sold.
  const edited = await request(`/api/portal/marketplace/manage/${token}`, {
    method: "PATCH", body: JSON.stringify({ price: 1200, addImages: [{ dataBase64: tinyJpeg }] }),
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const editedBody = await edited.json() as any;
  assert.equal(editedBody.listing.priceCents, 120000);
  assert.equal(editedBody.listing.imageIds.length, 2);
  assert.equal(editedBody.inquiries.length, 1);
  assert.equal(editedBody.inquiries[0].buyerEmail, "alex@example.invalid");

  const sold = await request(`/api/portal/marketplace/manage/${token}/status`, {
    method: "POST", body: JSON.stringify({ status: "sold" }),
  });
  assert.equal(sold.status, 200, await sold.clone().text());
  assert.equal(((await sold.json()) as any).listing.status, "sold");
  assert.equal((await request(`/api/portal/marketplace/listings/${id}`)).status, 200, "sold listings stay viewable");
  assert.equal((await request(`/api/portal/marketplace/listings/${id}/contact`, {
    method: "POST",
    body: JSON.stringify({ buyerName: "Late Buyer", buyerEmail: "late@example.invalid", message: "Still have this one available?" }),
  })).status, 404, "sold listings cannot be contacted");
});

test("uploads must be real JPEG/PNG/WebP images", async () => {
  const response = await request("/api/portal/marketplace/listings", {
    method: "POST",
    body: JSON.stringify(listingBody({ images: [{ dataBase64: notAnImage, mimeType: "image/jpeg" }] })),
  });
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as any).message, /JPEG, PNG or WebP/);
});

test("staff can post on behalf of a caller and the listing goes live immediately", async () => {
  const created = await request("/api/marketplace/listings", {
    method: "POST", actor: "staff",
    body: JSON.stringify(listingBody({ title: `${marker} staff-posted laptop`, category: "laptop", images: [], showPhone: true })),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const body = await created.json() as any;
  assert.equal(body.listing.status, "active");
  assert.equal(body.listing.source, "staff");
  assert.ok(sentMail.some((m) => m.to === sellerEmail && /listing is live/i.test(m.subject)));

  const pub = await request(`/api/portal/marketplace/listings/${body.listing.id}`);
  assert.equal(pub.status, 200);
  const pubBody = (await pub.json()) as any;
  assert.equal(pubBody.sellerPhone, "954-555-0100", "phone shows when the seller opted in");
  assert.equal(pubBody.verified, true, "staff-posted listings carry the verified flag");

  const removed = await request(`/api/marketplace/listings/${body.listing.id}`, { method: "DELETE", actor: "staff" });
  assert.equal(removed.status, 200);
  assert.equal((await request(`/api/portal/marketplace/listings/${body.listing.id}`)).status, 404);
});

test("CyberScan turns a label photo into listing suggestions", async () => {
  const res = await request("/api/portal/marketplace/scan", { method: "POST", body: JSON.stringify({ dataBase64: tinyJpeg }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(scanned.at(-1)?.mimeType, "image/jpeg");
  assert.equal(body.detected, true);
  assert.equal(body.category, "laptop");
  assert.equal(body.specs.cpu, "AMD Ryzen 7 5800H");
  assert.equal(body.specs.gpu, "NVIDIA GeForce RTX 3070");
  assert.equal(body.specs.ram, "16GB DDR4");
  assert.equal(body.specs.storage, "1TB NVMe SSD");
  assert.match(body.title, /^Lenovo Legion 5 Pro 16ACH6H - RTX 3070/);
  assert.match(body.descriptionHook, /^Factory specs:/);

  const status = await request("/api/portal/marketplace/scan/status");
  assert.deepEqual(await status.json(), { enabled: true });

  const bad = await request("/api/portal/marketplace/scan", { method: "POST", body: JSON.stringify({ dataBase64: notAnImage }) });
  assert.equal(bad.status, 400);
});

test("typed model numbers resolve through the lookup endpoint", async () => {
  const res = await request("/api/portal/marketplace/scan/lookup", { method: "POST", body: JSON.stringify({ query: "XPS 9520" }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.detected, true);
  assert.equal(body.category, "laptop");
  assert.equal(body.specs.cpu, "Intel Core i7-12700H");
  assert.match(body.title, /^Dell XPS 15 9520/);

  const short = await request("/api/portal/marketplace/scan/lookup", { method: "POST", body: JSON.stringify({ query: "x" }) });
  assert.equal(short.status, 400);
});
