import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyReferralsMigration } from "./migrations/2026-10-30-referrals";
import { registerRoutes } from "./routes/routes";
import { recordIntakeReferral } from "./referrals";
import { isPublicApiRequest } from "./api-auth-boundary";
import { requiredFeatureForApiPath } from "./security";

const marker = `referrals-${process.pid}-${Date.now()}`;
const staffId = `${marker}-staff`;
const staffEmail = `${marker}-staff@example.invalid`;
// A technician with no contact assignments: sees none of the program's people.
const techId = `${marker}-tech`;
const techEmail = `${marker}-tech@example.invalid`;
const referrerEmail = `${marker}-maria@example.invalid`;
const friendEmail = `${marker}-devon@example.invalid`;
let server: Server | undefined;
let baseUrl = "";
const sentMail: Array<{ to: string; subject: string; text: string }> = [];
const intakeIds: number[] = [];
let originalSettings: Record<string, unknown> | undefined;

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
    referralMailer: async (to, subject, text) => { sentMail.push({ to, subject, text }); },
  });
  server.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function request(path: string, init?: RequestInit & { actor?: "staff" | "tech" }) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.actor ? { "x-test-actor": init.actor } : {}),
      ...init?.headers,
    },
  });
}

const json = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const lastTokenFor = (email: string) => {
  const match = [...sentMail].reverse()
    .filter((m) => m.to === email)
    .map((m) => m.text.match(/\/portal\/referrals\/r\/([A-Za-z0-9_-]+)/))
    .find(Boolean);
  assert.ok(match, `expected a dashboard link emailed to ${email}`);
  return match[1];
};

async function insertIntake(name: string, email: string, phone: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO csd_intake_records
       (customer_name, phone_number, email_address, contact_preference, service_type, device_type,
        device_brand_model, operating_system, problem_description, how_did_you_hear, is_from_active_call, source)
     VALUES ($1, $2, $3, 'text', 'Virus Removal', 'Laptop', 'Dell XPS', 'Windows 11', 'Pop-ups', 'Referral from Friend/Family', false, 'website_intake')
     RETURNING id`,
    [name, phone, email],
  );
  const id = Number(rows[0].id);
  intakeIds.push(id);
  return id;
}

before(async () => {
  await applyReferralsMigration();
  const settings = await pool.query(`SELECT active, referrer_reward, friend_reward, terms FROM referral_program_settings WHERE id = 1`);
  originalSettings = settings.rows[0];
  await pool.query(`UPDATE referral_program_settings SET active = TRUE WHERE id = 1`);
  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Staff','Test'),($3,$4,'Tech','Test') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [staffId, staffEmail, techId, techEmail],
  );
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES($1,'administrator','approved',TRUE,'{}'),($2,'field_technician','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,approval_status=EXCLUDED.approval_status`,
    // "staff" is an administrator (unrestricted contact scope); "tech" has no assignments.
    [staffId, techId],
  );
  await startServer();
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await pool.query(`DELETE FROM referrers WHERE email LIKE $1`, [`${marker}%`]);
  if (intakeIds.length) await pool.query(`DELETE FROM csd_intake_records WHERE id = ANY($1::int[])`, [intakeIds]);
  if (originalSettings) {
    await pool.query(
      `UPDATE referral_program_settings SET active = $1, referrer_reward = $2, friend_reward = $3, terms = $4 WHERE id = 1`,
      [originalSettings.active, originalSettings.referrer_reward, originalSettings.friend_reward, originalSettings.terms],
    );
  }
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1::text[])", [[staffId, techId]]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [[staffId, techId]]);
});

// The auth boundary is mounted in index.ts, not by registerRoutes, so the
// policy is asserted directly (same approach as api-auth-boundary tests).
test("portal referral routes are public; staff routes need crm, and owners set rewards", () => {
  for (const [method, path] of [["GET", "/api/portal/referrals/program"], ["POST", "/api/portal/referrals/join"], ["GET", "/api/portal/referrals/r/abc"], ["GET", "/api/portal/referrals/code/MARIA-2345Z"]] as const) {
    assert.equal(isPublicApiRequest(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [["GET", "/api/crm/referrals"], ["PATCH", "/api/crm/referrals/4"], ["POST", "/api/crm/referrals/referrers"]] as const) {
    assert.equal(isPublicApiRequest(method, path), false, `${method} ${path}`);
    assert.equal(requiredFeatureForApiPath(path, method), "crm");
  }
  assert.equal(requiredFeatureForApiPath("/api/crm/referrals/settings", "PUT"), "owner");
});

test("joining emails a private dashboard link and never reveals the code in the response", async () => {
  const program = await json(request("/api/portal/referrals/program"));
  assert.equal(program.active, true);

  const joined = await request("/api/portal/referrals/join", {
    method: "POST",
    body: JSON.stringify({ fullName: "Maria Alvarez", email: referrerEmail.toUpperCase(), phone: "954-555-0101" }),
  });
  assert.equal(joined.status, 200);
  const body = await json(joined);
  assert.deepEqual(Object.keys(body).sort(), ["message", "ok"]);

  const token = lastTokenFor(referrerEmail);
  const dashboard = await json(request(`/api/portal/referrals/r/${token}`));
  assert.equal(dashboard.referrer.firstName, "Maria");
  assert.match(dashboard.referrer.code, /^MARIA-[2-9A-HJKMNP-Z]{5}$/);
  assert.match(dashboard.referrer.shareUrl, new RegExp(`/intake\\?ref=${dashboard.referrer.code}$`));
  assert.equal(dashboard.summary.total, 0);

  const lookup = await json(request(`/api/portal/referrals/code/${dashboard.referrer.code.toLowerCase()}`));
  assert.deepEqual(lookup, { valid: true, code: dashboard.referrer.code, referrerFirstName: "Maria", friendReward: program.friendReward });
  assert.deepEqual(await json(request("/api/portal/referrals/code/NOPE-ZZZZZ")), { valid: false });
});

test("re-joining rotates the link without letting a stranger rename the referrer", async () => {
  const oldToken = lastTokenFor(referrerEmail);
  const again = await request("/api/portal/referrals/join", {
    method: "POST",
    body: JSON.stringify({ fullName: "Mallory Imposter", email: referrerEmail }),
  });
  assert.equal(again.status, 200);
  const newToken = lastTokenFor(referrerEmail);
  assert.notEqual(newToken, oldToken);
  assert.equal((await request(`/api/portal/referrals/r/${oldToken}`)).status, 404);
  const dashboard = await json(request(`/api/portal/referrals/r/${newToken}`));
  assert.equal(dashboard.referrer.firstName, "Maria");
});

test("intakes with a code create one pending referral; self-referrals and bad codes are ignored", async () => {
  const token = lastTokenFor(referrerEmail);
  const { referrer } = await json(request(`/api/portal/referrals/r/${token}`));

  const friendIntake = await insertIntake("Devon Price", friendEmail, "+19545550102");
  const recorded = await recordIntakeReferral({
    code: ` ${referrer.code.toLowerCase()} `, intakeRecordId: friendIntake, leadId: null, contactId: null,
    existingCustomer: false, friendName: "Devon Price", friendEmail, friendPhone: "+19545550102",
  });
  assert.ok(recorded?.referralId);
  assert.ok(sentMail.some((m) => m.to === referrerEmail && m.subject === "Devon P. used your referral code"));

  // Replaying the same intake does not double count.
  const replay = await recordIntakeReferral({
    code: referrer.code, intakeRecordId: friendIntake, leadId: null, contactId: null,
    existingCustomer: false, friendName: "Devon Price", friendEmail, friendPhone: null,
  });
  assert.equal(replay, null);

  const selfIntake = await insertIntake("Maria Alvarez", referrerEmail, "+19545550101");
  assert.equal(await recordIntakeReferral({
    code: referrer.code, intakeRecordId: selfIntake, leadId: null, contactId: null,
    existingCustomer: true, friendName: "Maria Alvarez", friendEmail: null, friendPhone: "(954) 555-0101",
  }), null);
  assert.equal(await recordIntakeReferral({
    code: "'; DROP TABLE referrals; --", intakeRecordId: selfIntake, leadId: null, contactId: null,
    existingCustomer: false, friendName: "X", friendEmail: null, friendPhone: null,
  }), null);

  const dashboard = await json(request(`/api/portal/referrals/r/${token}`));
  assert.equal(dashboard.summary.total, 1);
  assert.deepEqual(dashboard.referrals.map((r: any) => [r.friendName, r.status]), [["Devon P.", "pending"]]);
  assert.equal(JSON.stringify(dashboard).includes(friendEmail), false, "referrers never see a friend's contact details");
});

test("staff review a referral through to rewarded, which emails the referrer", async () => {
  const list = await json(request("/api/crm/referrals", { actor: "staff" }));
  const referral = list.referrals.find((r: any) => r.friendEmail === friendEmail);
  assert.ok(referral);
  assert.equal(referral.referrer.email, referrerEmail);
  assert.equal(referral.status, "pending");
  assert.ok(list.referrers.some((r: any) => r.email === referrerEmail && r.referralCount === 1));

  const rewarded = await request(`/api/crm/referrals/${referral.id}`, {
    actor: "staff", method: "PATCH", body: JSON.stringify({ status: "rewarded", note: "Credit applied to invoice" }),
  });
  assert.deepEqual(await json(rewarded), { ok: true, emailed: true });
  assert.ok(sentMail.some((m) => m.to === referrerEmail && m.subject === "Your referral reward is ready"));

  const { rows } = await pool.query(`SELECT status, staff_note, qualified_at, rewarded_at FROM referrals WHERE id = $1`, [referral.id]);
  assert.equal(rows[0].status, "rewarded");
  assert.equal(rows[0].staff_note, "Credit applied to invoice");
  assert.ok(rows[0].qualified_at && rows[0].rewarded_at);

  const bad = await request(`/api/crm/referrals/${referral.id}`, { actor: "staff", method: "PATCH", body: JSON.stringify({ status: "paid" }) });
  assert.equal(bad.status, 400);
});

test("staff without the contact assigned can't see or change referrals", async () => {
  const owner = await json(request("/api/crm/referrals", { actor: "staff" }));
  const referral = owner.referrals.find((r: any) => r.friendEmail === friendEmail);
  const referrer = owner.referrers.find((r: any) => r.email === referrerEmail);
  assert.ok(referral && referrer);

  const tech = await json(request("/api/crm/referrals", { actor: "tech" }));
  assert.equal(tech.referrals.some((r: any) => r.friendEmail === friendEmail), false);
  assert.equal(tech.referrers.some((r: any) => r.email === referrerEmail), false);
  assert.equal(JSON.stringify(tech).includes(referrerEmail), false);

  const edit = await request(`/api/crm/referrals/${referral.id}`, { actor: "tech", method: "PATCH", body: JSON.stringify({ status: "declined" }) });
  assert.equal(edit.status, 404);
  assert.equal((await request(`/api/crm/referrals/referrers/${referrer.id}/resend`, { actor: "tech", method: "POST" })).status, 404);
  assert.equal((await request(`/api/crm/referrals/referrers/${referrer.id}`, { actor: "tech", method: "PATCH", body: JSON.stringify({ status: "paused" }) })).status, 404);
});

test("simultaneous sign-ups for one new email both succeed and create one referrer", async () => {
  const email = `${marker}-race@example.invalid`;
  // Staff enrollment shares enrollReferrer with the portal and has no rate limit.
  const results = await Promise.all([0, 1, 2].map(() => request("/api/crm/referrals/referrers", {
    actor: "staff", method: "POST", body: JSON.stringify({ fullName: "Race Person", email }),
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201]);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM referrers WHERE email = $1`, [email]);
  assert.equal(rows[0].n, 1);
});

test("paused programs stop new sign-ups and code lookups", async () => {
  const token = lastTokenFor(referrerEmail);
  const { referrer } = await json(request(`/api/portal/referrals/r/${token}`));
  const current = await json(request("/api/crm/referrals", { actor: "staff" }));
  const paused = await request("/api/crm/referrals/settings", {
    actor: "staff", method: "PUT", body: JSON.stringify({ ...current.settings, active: false }),
  });
  assert.equal((await json(paused)).active, false);
  const join = await request("/api/portal/referrals/join", { method: "POST", body: JSON.stringify({ fullName: "New Person", email: `${marker}-new@example.invalid` }) });
  assert.equal(join.status, 409);
  assert.deepEqual(await json(request(`/api/portal/referrals/code/${referrer.code}`)), { valid: false });
});
