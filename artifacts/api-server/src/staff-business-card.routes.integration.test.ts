import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffAvatarsMigration } from "./migrations/2026-11-06-staff-avatars";
import { applyStaffBusinessCardsMigration } from "./migrations/2026-11-06-staff-business-cards";
import { registerStaffProfileRoutes } from "./staff-profile";
import { buildVCard, registerStaffBusinessCardRoutes, type PublicBusinessCard } from "./staff-business-card";
import { __setSmtpTransportForTests } from "./mail-transport";
import { isPublicApiRequest } from "./api-auth-boundary";

const marker = `staff-card-${process.pid}-${Date.now()}`;
const techId = `${marker}-tech`;
const techEmail = `${techId}@example.invalid`;
let server: Server;
let baseUrl = "";
const sent: any[] = [];
const savedEnv = { host: process.env.CSD_MAIL_HOST, user: process.env.CSD_MAIL_USER, password: process.env.CSD_MAIL_PASSWORD };

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);

function request(path: string, init?: RequestInit & { actor?: string }) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.actor ? { "x-test-actor": init.actor } : {}), ...init?.headers },
  });
}

async function myCard() {
  const res = await request("/api/staff-profile/me/card", { actor: techId });
  assert.equal(res.status, 200);
  return (await res.json()) as { token: string; card: PublicBusinessCard; hasDirectPhone: boolean; emailAvailable: boolean };
}

before(async () => {
  process.env.CSD_MAIL_HOST = "smtp.example.invalid";
  process.env.CSD_MAIL_USER = "support@example.invalid";
  process.env.CSD_MAIL_PASSWORD = "test";
  __setSmtpTransportForTests({ sendMail: async (message: any) => { sent.push(message); return { messageId: "m1" } as any; } });
  await applyStaffAccessMigration();
  await applyStaffAvatarsMigration();
  await applyStaffBusinessCardsMigration();
  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Tess','Tech')
     ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [techId, techEmail],
  );
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'field_technician','approved',TRUE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role, approval_status=EXCLUDED.approval_status`,
    [techId],
  );
  await pool.query(
    `INSERT INTO staff_directory_details(user_id, phone, job_title) VALUES ($1, '+19545550101', 'Bench Technician')
     ON CONFLICT(user_id) DO UPDATE SET phone=EXCLUDED.phone, job_title=EXCLUDED.job_title`,
    [techId],
  );

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const actorId = req.header("x-test-actor");
    if (actorId) {
      req.dbUser = {
        id: actorId, email: techEmail, firstName: null, lastName: null, profileImageUrl: null,
        stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date(), updatedAt: new Date(),
      };
    }
    next();
  });
  registerStaffProfileRoutes(app);
  registerStaffBusinessCardRoutes(app);
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __setSmtpTransportForTests(null);
  await pool.query("DELETE FROM auth_users WHERE id = $1", [techId]);
  for (const [key, value] of [["CSD_MAIL_HOST", savedEnv.host], ["CSD_MAIL_USER", savedEnv.user], ["CSD_MAIL_PASSWORD", savedEnv.password]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("only the card lookup paths are public; managing a card needs a staff session", () => {
  assert.equal(isPublicApiRequest("GET", "/api/portal/business-card/abcDEF1234567890xyz"), true);
  assert.equal(isPublicApiRequest("GET", "/api/portal/business-card/abcDEF1234567890xyz/vcard"), true);
  assert.equal(isPublicApiRequest("GET", "/api/staff-profile/me/card"), false);
  assert.equal(isPublicApiRequest("POST", "/api/staff-profile/me/card/email"), false);
  assert.equal(isPublicApiRequest("POST", "/api/staff-profile/me/card/rotate"), false);
});

test("a technician's card is public by token, hides the direct phone by default and includes the photo", async () => {
  const mine = await myCard();
  assert.match(mine.token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(mine.hasDirectPhone, true);
  assert.equal(mine.card.cardUrl.endsWith(`/card/${mine.token}`), true);
  assert.equal(mine.card.cardUrl.includes(techId), false, "card links never expose the internal user id");

  const pub = await request(`/api/portal/business-card/${mine.token}`);
  assert.equal(pub.status, 200);
  const card = (await pub.json()) as PublicBusinessCard;
  assert.equal(card.name, "Tess Tech");
  assert.equal(card.title, "Bench Technician");
  assert.equal(card.email, techEmail);
  assert.equal(card.directPhone, null);
  assert.equal(card.photoUrl, null);

  await request("/api/staff-profile/me/avatar", { actor: techId, method: "PUT", body: JSON.stringify({ dataBase64: jpeg.toString("base64") }) });
  await request("/api/staff-profile/me/card", {
    actor: techId, method: "PATCH", body: JSON.stringify({ showDirectPhone: true, showEmail: false, headline: "PC repair specialist" }),
  });
  const updated = (await (await request(`/api/portal/business-card/${mine.token}`)).json()) as PublicBusinessCard;
  assert.equal(updated.directPhone, "+19545550101");
  assert.equal(updated.email, null);
  assert.equal(updated.headline, "PC repair specialist");
  assert.ok(updated.photoUrl);
  const photo = await request(updated.photoUrl!);
  assert.equal(photo.status, 200);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);

  const vcard = await request(updated.vcardUrl);
  assert.equal(vcard.status, 200);
  assert.match(vcard.headers.get("content-type") || "", /text\/vcard/);
  assert.match(vcard.headers.get("content-disposition") || "", /Tess-Tech\.vcf/);
  const text = await vcard.text();
  assert.match(text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  assert.match(text, /FN:Tess Tech\r\n/);
  assert.match(text, /TEL;TYPE=CELL,VOICE:\+19545550101/);
  assert.match(text, /PHOTO;ENCODING=b;TYPE=JPEG:/);
  assert.equal(text.includes(techEmail), false, "hidden email stays out of the vCard");
});

test("suspending the technician turns their card off; replacing the link kills the old one", async () => {
  const { token } = await myCard();
  await pool.query(`UPDATE staff_access_profiles SET approval_status='suspended' WHERE user_id=$1`, [techId]);
  assert.equal((await request(`/api/portal/business-card/${token}`)).status, 404);
  assert.equal((await request(`/api/portal/business-card/${token}/vcard`)).status, 404);
  await pool.query(`UPDATE staff_access_profiles SET approval_status='approved' WHERE user_id=$1`, [techId]);
  assert.equal((await request(`/api/portal/business-card/${token}`)).status, 200);

  assert.equal((await request("/api/staff-profile/me/card/rotate", { actor: techId, method: "POST" })).status, 200);
  const { token: fresh } = await myCard();
  assert.notEqual(fresh, token);
  assert.equal((await request(`/api/portal/business-card/${token}`)).status, 404);
  assert.equal((await request(`/api/portal/business-card/${fresh}`)).status, 200);
  assert.equal((await request(`/api/portal/business-card/not-a-token`)).status, 404);
});

test("emailing the card sends a branded message with the card link and replies to the technician", async () => {
  const { card } = await myCard();
  const bad = await request("/api/staff-profile/me/card/email", { actor: techId, method: "POST", body: JSON.stringify({ to: "nope" }) });
  assert.equal(bad.status, 400);
  const res = await request("/api/staff-profile/me/card/email", {
    actor: techId, method: "POST",
    body: JSON.stringify({ to: "customer@example.invalid", recipientName: "Sam", message: "Thanks for <coming> in!" }),
  });
  assert.equal(res.status, 200);
  const mail = sent.at(-1);
  assert.equal(mail.to, "customer@example.invalid");
  assert.equal(mail.replyTo, techEmail);
  assert.match(mail.subject, /Tess Tech's contact card/);
  assert.ok(mail.text.includes(card.cardUrl));
  assert.ok(mail.html.includes("Thanks for &lt;coming&gt; in!"), "user text is escaped in HTML");
});

test("vCard escapes separators and folds long lines", () => {
  const text = buildVCard({
    name: "Ana; Smith, Jr", firstName: "Ana", lastName: "Smith, Jr", title: "Tech", headline: "x".repeat(200),
    email: null, directPhone: null, photoUrl: null,
    company: { name: "CSD", phone: null, email: null, website: "https://example.invalid", accentColor: "red" },
    cardUrl: "https://example.invalid/card/t", vcardUrl: "/v", bookingUrl: "/intake",
  });
  assert.ok(text.includes("FN:Ana\\; Smith\\, Jr\r\n"), text);
  for (const line of text.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line.length}`);
});
