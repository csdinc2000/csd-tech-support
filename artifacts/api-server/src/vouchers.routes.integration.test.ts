import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyVouchersMigration } from "./migrations/2026-11-10-vouchers";
import { registerRoutes } from "./routes/routes";
import { isPublicApiRequest } from "./api-auth-boundary";
import { requiredFeatureForApiPath } from "./security";
import { businessDate } from "./voucher-core";

const marker = `vouchers-${process.pid}-${Date.now()}`;
const staffId = `${marker}-staff`;
const staffEmail = `${marker}-staff@example.invalid`;
// A technician with no contact assignments: sees only vouchers they sent.
const techId = `${marker}-tech`;
const techEmail = `${marker}-tech@example.invalid`;
const customerEmail = `${marker}-dana@example.invalid`;
let server: Server | undefined;
let baseUrl = "";
const sentMail: Array<{ to: string; subject: string; text: string; html: string }> = [];
let failMail = false;

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.header("x-test-actor");
    const userId = actor === "staff" ? staffId : actor === "tech" ? techId : undefined;
    const email = actor === "tech" ? techEmail : staffEmail;
    (req as any).auth = Object.assign(() => ({
      userId,
      sessionClaims: userId ? { userId, email } : undefined,
    }), { [Symbol.for("@clerk/express.auth")]: true });
    if (userId) {
      req.dbUser = {
        id: userId, email, firstName: null, lastName: null, profileImageUrl: null,
        stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date(), updatedAt: new Date(),
      };
    }
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });
  server = await registerRoutes(app, {
    disableBackgroundServices: true,
    voucherMailer: async (to, subject, text, { html }) => {
      if (failMail) throw new Error("SMTP down");
      sentMail.push({ to, subject, text, html });
    },
  });
  server.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function request(path: string, init?: RequestInit & { actor?: "staff" | "tech"; json?: unknown }) {
  const { json: body, ...rest } = init ?? {};
  return fetch(`${baseUrl}${path}`, {
    ...rest,
    body: body !== undefined ? JSON.stringify(body) : rest.body,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init?.actor ? { "x-test-actor": init.actor } : {}),
      ...init?.headers,
    },
  });
}

const json = async (response: Response | Promise<Response>): Promise<any> => (await response).json() as Promise<any>;

const inDays = (days: number) => businessDate(new Date(Date.now() + days * 86_400_000));

async function createVoucher(body: Record<string, unknown>, actor: "staff" | "tech" = "staff") {
  const res = await request("/api/crm/vouchers", { actor, method: "POST", json: { recipientName: "Dana Lee", recipientEmail: customerEmail, ...body } });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  await applyVouchersMigration();
  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Staff','Test'),($3,$4,'Tech','Test') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [staffId, staffEmail, techId, techEmail],
  );
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES($1,'administrator','approved',TRUE,'{}'),($2,'field_technician','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,approval_status=EXCLUDED.approval_status`,
    [staffId, techId],
  );
  await startServer();
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await pool.query(`DELETE FROM vouchers WHERE recipient_email LIKE $1`, [`${marker}%`]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1::text[])", [[staffId, techId]]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [[staffId, techId]]);
});

test("voucher routes are staff-only behind the crm feature", () => {
  for (const [method, path] of [["GET", "/api/crm/vouchers"], ["POST", "/api/crm/vouchers"], ["PATCH", "/api/crm/vouchers/4"], ["GET", "/api/crm/vouchers/lookup/CSD-ABCDEF"], ["POST", "/api/crm/vouchers/redeem"]] as const) {
    assert.equal(isPublicApiRequest(method, path), false, `${method} ${path}`);
    assert.equal(requiredFeatureForApiPath(path, method), "crm");
  }
});

test("creating a voucher emails the customer the code, percentage and expiry", async () => {
  const expiresOn = inDays(30);
  const { status, body } = await createVoucher({ percentOff: 15, maxDiscountCents: 5_000, expiresOn, message: "Thanks for being a loyal customer!" });
  assert.equal(status, 201);
  assert.equal(body.emailed, true);
  assert.match(body.voucher.code, /^CSD-[A-Z0-9]{6}$/);
  assert.equal(body.voucher.percentOff, 15);
  assert.equal(body.voucher.expiresOn, expiresOn);
  assert.equal(body.voucher.state, "active");
  assert.equal(body.voucher.emailCount, 1);

  const mail = sentMail.at(-1)!;
  assert.equal(mail.to, customerEmail);
  assert.equal(mail.subject, "Your 15% off voucher from Computer Systems Depot");
  assert.ok(mail.text.includes(body.voucher.code));
  assert.ok(mail.text.includes("15% off your next service (up to $50.00)"));
  assert.ok(mail.text.includes("Thanks for being a loyal customer!"));
  assert.ok(mail.html.includes("15% OFF"));
});

test("invalid percentages and past expiry dates are rejected", async () => {
  for (const percentOff of [0, 101, 12.5]) {
    assert.equal((await createVoucher({ percentOff })).status, 400, String(percentOff));
  }
  assert.equal((await createVoucher({ percentOff: 10, expiresOn: inDays(-2) })).status, 400);
  // HTML in the message is escaped in the email.
  const { body } = await createVoucher({ percentOff: 10, message: "<script>x</script>", send: true });
  assert.ok(sentMail.at(-1)!.html.includes("&lt;script&gt;"));
  assert.equal(body.emailed, true);
});

test("staff adjust the percentage, keep the code, and re-send", async () => {
  const { body: created } = await createVoucher({ percentOff: 10 });
  const sentBefore = sentMail.length;
  const res = await request(`/api/crm/vouchers/${created.voucher.id}`, { actor: "staff", method: "PATCH", json: { percentOff: 25, maxDiscountCents: null, resend: true } });
  assert.equal(res.status, 200);
  const { voucher, emailed } = (await res.json()) as any;
  assert.equal(emailed, true);
  assert.equal(voucher.code, created.voucher.code);
  assert.equal(voucher.percentOff, 25);
  assert.equal(voucher.emailCount, 2);
  assert.equal(sentMail.length, sentBefore + 1);
  assert.match(sentMail.at(-1)!.subject, /25% off/);
});

test("a failed email still creates the voucher so staff can share the code", async () => {
  failMail = true;
  try {
    const { status, body } = await createVoucher({ percentOff: 5 });
    assert.equal(status, 201);
    assert.equal(body.emailed, false);
    assert.equal(body.voucher.emailCount, 0);
  } finally {
    failMail = false;
  }
});

test("counter lookup previews the discount, and a code can only be redeemed once", async () => {
  const { body: created } = await createVoucher({ percentOff: 20, maxDiscountCents: 3_000 });
  const code = created.voucher.code as string;
  const typed = code.toLowerCase().replace("-", " ");

  const lookup = await json(request(`/api/crm/vouchers/lookup/${encodeURIComponent(typed)}?subtotalCents=25000`, { actor: "tech" }));
  assert.equal(lookup.voucher.code, code);
  assert.equal(lookup.discountCents, 3_000); // 20% of $250 = $50, capped at $30

  const results = await Promise.all([0, 1, 2].map(() => request("/api/crm/vouchers/redeem", { actor: "tech", method: "POST", json: { code, note: "INV-1042" } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  const after = await json(request(`/api/crm/vouchers/lookup/${code}?subtotalCents=25000`, { actor: "staff" }));
  assert.equal(after.voucher.state, "redeemed");
  assert.equal(after.voucher.redemptionNote, "INV-1042");
  assert.equal(after.discountCents, null);

  // Redeemed vouchers can't be adjusted, but staff can undo the redemption.
  assert.equal((await request(`/api/crm/vouchers/${created.voucher.id}`, { actor: "staff", method: "PATCH", json: { percentOff: 30 } })).status, 409);
  const undo = await json(request(`/api/crm/vouchers/${created.voucher.id}`, { actor: "staff", method: "PATCH", json: { status: "active" } }));
  assert.equal(undo.voucher.state, "active");
  assert.equal(undo.voucher.redemptionNote, null);
});

test("expired and void vouchers can't be redeemed or emailed", async () => {
  const { body: created } = await createVoucher({ percentOff: 10, send: false });
  await pool.query(`UPDATE vouchers SET expires_on = $2 WHERE id = $1`, [created.voucher.id, inDays(-1)]);
  const expired = await request("/api/crm/vouchers/redeem", { actor: "staff", method: "POST", json: { code: created.voucher.code } });
  assert.equal(expired.status, 409);
  assert.equal(((await expired.json()) as any).message, "This voucher has expired");
  assert.equal((await request(`/api/crm/vouchers/${created.voucher.id}`, { actor: "staff", method: "PATCH", json: { resend: true } })).status, 409);

  // Extending the expiry brings it back.
  const extended = await json(request(`/api/crm/vouchers/${created.voucher.id}`, { actor: "staff", method: "PATCH", json: { expiresOn: inDays(7) } }));
  assert.equal(extended.voucher.state, "active");

  await request(`/api/crm/vouchers/${created.voucher.id}`, { actor: "staff", method: "PATCH", json: { status: "void" } });
  const voided = await request(`/api/crm/vouchers/${created.voucher.id}/redeem`, { actor: "staff", method: "POST", json: {} });
  assert.equal(voided.status, 409);
});

test("staff without the contact assigned only see vouchers they sent", async () => {
  const { body: own } = await createVoucher({ percentOff: 12, recipientEmail: `${marker}-tech-customer@example.invalid` }, "tech");
  const tech = await json(request("/api/crm/vouchers", { actor: "tech" }));
  const ids = tech.vouchers.map((v: any) => v.id);
  assert.ok(ids.includes(own.voucher.id));
  assert.equal(JSON.stringify(tech).includes(customerEmail), false);

  const admin = await json(request("/api/crm/vouchers", { actor: "staff" }));
  const someoneElses = admin.vouchers.find((v: any) => v.recipientEmail === customerEmail);
  assert.ok(someoneElses);
  assert.equal((await request(`/api/crm/vouchers/${someoneElses.id}`, { actor: "tech", method: "PATCH", json: { percentOff: 90 } })).status, 404);
  assert.equal((await request(`/api/crm/vouchers/${someoneElses.id}/redeem`, { actor: "tech", method: "POST", json: {} })).status, 404);
});
