/**
 * Opt-in Clerk browser check. The package command verifies and switches to a
 * separate, empty development test database before this script is loaded:
 * pnpm --filter @workspace/api-server test:clerk-invite
 *
 * Clerk's +clerk_test addresses use 424242 without delivering an email.
 * Never substitute a real teammate address or a live Clerk key.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { clerkClient, clerkMiddleware } from "@clerk/express";
import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { chromium, type BrowserContext } from "@playwright/test";
import express from "express";
import { pool } from "../src/db";
import { requireAuth } from "../src/middlewares/clerkAuth";
import { applyStaffAccessMigration } from "../src/migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "../src/migrations/2026-09-23-staff-invites";
import { applySharedRateLimitsMigration } from "../src/migrations/2026-09-16-shared-rate-limits";
import { registerPttRoutes } from "../src/ptt";
import { getStaffAccess } from "../src/staff-access";
import { registerStaffAccessRoutes, roleFeatureMap } from "../src/staff-access";
import { registerStaffInviteRoutes } from "../src/staff-invites";

if (
  process.env.RUN_CLERK_INVITE_E2E !== "1" ||
  !process.env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
  !process.env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL !== process.env.CLERK_INVITE_TEST_DATABASE_URL ||
  process.env.CLERK_ISOLATED_TEST_DB_ACTIVE !== "1" ||
  !process.env.REPLIT_DEV_DOMAIN ||
  process.env.NODE_ENV !== "development" ||
  process.env.REPLIT_DEPLOYMENT === "1"
) {
  throw new Error("Clerk invite check requires explicit opt-in, development Clerk keys, a separate development test database, and a dev preview domain.");
}

const suffix = randomBytes(8).toString("hex");
const testIp = `192.0.2.${parseInt(suffix.slice(0, 2), 16) % 250 + 1}`;
const invitedEmail = `invite+clerk_test_${suffix}@example.com`;
const ownerEmail = `owner+clerk_test_${suffix}@example.com`;
const password = `Test-${randomBytes(18).toString("base64url")}!`;
const appUrl = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const users = new Map<string, string>();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
const inviteIds: string[] = [];

async function createTestInvite(email: string, invitedBy: string | null) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const inserted = await pool.query(
    `INSERT INTO staff_invites(email,role,token_hash,invited_by,expires_at)
     VALUES($1,'field_technician',$2,$3,NOW() + INTERVAL '1 hour') RETURNING id`,
    [email, tokenHash, invitedBy],
  );
  inviteIds.push(inserted.rows[0].id);
  return token;
}

async function signup(email: string, inviteToken: string, apiBase: string): Promise<BrowserContext> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  await setupClerkTestingToken({ page });
  // The browser sees the real validation response from the isolated route
  // registrar, without using the running development app's shared rate bucket.
  await page.route("**/api/public/staff-invites/validate", async (route) => {
    const response = await fetch(`${apiBase}/api/public/staff-invites/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
      body: route.request().postData(),
    });
    await route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
  });
  await page.goto(`${appUrl}/staff-invite#${inviteToken}`);
  await page.locator("[data-testid=panel-valid-invite]").waitFor();
  await page.goto(`${appUrl}/sign-up`);
  await page.locator(".cl-signUp-root").waitFor();
  for (const [field, value] of [["firstName", "Test"], ["lastName", "Account"], ["username", `test${email.startsWith("owner") ? "owner" : "invite"}${suffix}`]] as const) {
    const input = page.locator(`input[name="${field}"]`);
    if (await input.isVisible()) await input.fill(value);
  }
  await page.locator('input[name="emailAddress"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const prepared = page.waitForResponse((response) =>
    response.url().includes("prepare_verification") && response.status() === 200,
  { timeout: 20000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await prepared;
  const code = page.getByRole("textbox", { name: "Enter verification code" });
  try {
    await code.waitFor({ timeout: 10000 });
  } catch {
    console.error("Clerk sign-up did not reach OTP:", page.url(), (await page.locator("body").innerText()).slice(0, 900),
      await page.locator("input").evaluateAll((items) => items.map((item) => ({
        name: item.getAttribute("name"), type: item.getAttribute("type"), placeholder: item.getAttribute("placeholder"),
      }))));
    await page.screenshot({ path: "/tmp/clerk-signup-fail.png" });
    throw new Error("Clerk sign-up did not reach email-code verification");
  }
  await code.pressSequentially("424242");
  try {
    await page.waitForFunction(() => Boolean((window as any).Clerk?.session?.id), { timeout: 10000 });
  } catch {
    console.error("Clerk OTP did not establish a session:", page.url(), (await page.locator("body").innerText()).slice(0, 1000),
      await page.evaluate(() => ({ clerkLoaded: Boolean((window as any).Clerk), signedIn: Boolean((window as any).Clerk?.user) })));
    throw new Error("Clerk email-code verification did not establish a session");
  }
  const matches = await clerkClient.users.getUserList({ emailAddress: [email], limit: 2 });
  assert.equal(matches.data.length, 1);
  const user = matches.data[0];
  assert.ok(user.emailAddresses.some((address) => address.emailAddress === email && address.verification?.status === "verified"));
  users.set(email, user.id);
  return context;
}

async function bearer(context: BrowserContext): Promise<string> {
  const token = await context.pages().at(-1)!.evaluate(() => (window as any).Clerk?.session?.getToken());
  assert.ok(token, "Clerk sign-up must create a real session");
  return token;
}

async function main() {
  await clerkSetup();
  await applyStaffAccessMigration();
  await applySharedRateLimitsMigration();
  await applyStaffInvitesMigration();
  const app = express();
  app.set("trust proxy", "loopback"); // only this loopback-bound test server
  app.use(clerkMiddleware());
  app.use(express.json());
  app.use("/api/staff-access", requireAuth);
  // The second verified test identity is the owner *only in this isolated process*.
  // Production owner allowlists and real teammate identities are never modified.
  registerStaffInviteRoutes(app);
  registerStaffAccessRoutes(app, { isOwner: (req) => req.dbUser?.id === users.get(ownerEmail) });
  registerPttRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, token: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Forwarded-For": testIp },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/repl/tools/bin/chromium" });
  const ownerInviteToken = await createTestInvite(ownerEmail, null);
  const owner = await signup(ownerEmail, ownerInviteToken, base);
  const ownerId = users.get(ownerEmail)!;
  await pool.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [ownerId, ownerEmail]);
  await pool.query(
    "INSERT INTO staff_access_profiles(user_id,role,approval_status) VALUES($1,'administrator','approved')",
    [ownerId],
  );
  const ownerToken = await bearer(owner);
  const inviteToken = await createTestInvite(invitedEmail, ownerId);
  const names = { token: inviteToken, firstName: "Test", lastName: "Teammate" };
  const wrong = await request("/api/public/staff-invites/accept", ownerToken, "POST", names);
  assert.equal(wrong.status, 403);
  assert.equal((await pool.query("SELECT accepted_at FROM staff_invites WHERE id=$1", [inviteIds[1]])).rows[0].accepted_at, null);

  const teammate = await signup(invitedEmail, inviteToken, base);
  const teammateId = users.get(invitedEmail)!;
  const teammateToken = await bearer(teammate);
  const accepted = await request("/api/public/staff-invites/accept", teammateToken, "POST", names);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body, { role: "field_technician", approvalStatus: "pending" });
  const access = async () => getStaffAccess({ dbUser: { id: teammateId } } as any);
  assert.equal((await access()).approvalStatus, "pending");
  assert.ok(Object.values((await access()).features).every((value) => value === false));
  assert.equal((await request("/api/ptt/session", teammateToken)).status, 403);
  assert.equal((await request("/api/public/staff-invites/accept", teammateToken, "POST", names)).status, 410);

  const profile = await pool.query("SELECT updated_at FROM staff_access_profiles WHERE user_id=$1", [teammateId]);
  const approval = await request(`/api/staff-access/${teammateId}`, ownerToken, "PATCH", {
    role: "field_technician", approvalStatus: "approved", capabilities: { viewVoicemails: false },
    features: roleFeatureMap("field_technician"), expectedUpdatedAt: profile.rows[0].updated_at,
  });
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  assert.equal((await access()).approvalStatus, "approved");
  assert.equal((await access()).features.communications, true);
  assert.equal((await access()).features.staffAdmin, false);
  assert.equal((await access()).features.billing, false);
  // A fresh login must see the same assigned role, not an elevated/default one.
  // Reuse the same browser device after a real sign-out. A new device can
  // require Clerk's unrelated client-trust challenge before password sign-in.
  await teammate.pages()[0].evaluate(() => (window as any).Clerk.signOut());
  const next = teammate;
  const page = await next.newPage();
  await page.goto(`${appUrl}/sign-in`);
  await page.locator('input[name="identifier"]').fill(invitedEmail);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  try {
    await page.waitForFunction(() => Boolean((window as any).Clerk?.session?.id), { timeout: 10000 });
  } catch {
    console.error("Next login did not establish a session:", page.url(), (await page.locator("body").innerText()).slice(0, 900));
    throw new Error("Approved teammate could not sign in again");
  }
  const nextToken = await bearer(next);
  assert.equal((await request("/api/public/staff-invites/validate", nextToken, "POST", { token: inviteToken })).status, 410);
  assert.equal((await access()).role, "field_technician");
  await next.close();

  const suspended = await request(`/api/staff-access/${teammateId}`, ownerToken, "PATCH", {
    role: "field_technician", approvalStatus: "suspended", capabilities: { viewVoicemails: false },
    features: roleFeatureMap("field_technician"), expectedUpdatedAt: approval.body.updatedAt,
  });
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.equal((await access()).approvalStatus, "suspended");
  assert.ok(Object.values((await access()).features).every((value) => value === false));
  assert.equal((await request("/api/ptt/session", nextToken)).status, 403);
  console.info("Clerk invitation acceptance, owner approval, next login, and suspension passed.");
}

try {
  await main();
} finally {
  if (browser) await browser.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  // An interrupted sign-up may have created a Clerk user before the test could
  // record its id. Look up only the two unique test addresses, never by prefix.
  for (const email of [invitedEmail, ownerEmail]) {
    const matches = await clerkClient.users.getUserList({ emailAddress: [email], limit: 2 });
    for (const user of matches.data) {
      if (user.emailAddresses.some((address) => address.emailAddress === email)) {
        users.set(email, user.id);
        await clerkClient.users.deleteUser(user.id);
      }
    }
  }
  for (const id of inviteIds) await pool.query("DELETE FROM staff_invites WHERE id=$1", [id]);
  for (const id of users.values()) {
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id=$1 OR actor_user_id=$1", [id]);
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM auth_user_clerk_links WHERE clerk_user_id=$1", [id]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [id]);
  }
  await pool.end();
}