import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applySalesAgentsMigration } from "./migrations/2026-11-10-sales-agents";
import { requiredFeatureForApiPath } from "./security";
import { isPublicApiRequest } from "./api-auth-boundary";
import {
  detectFirstContacts,
  escalateWaitingLeads,
  getSpeedToLeadSettings,
  openSpeedToLeadClocks,
  registerSpeedToLeadRoutes,
  sendPendingAutoTexts,
} from "./speed-to-lead";
import { registerLeadGenRoutes, startLeadGenRun, type LeadGenResearcher } from "./lead-gen-agent";
import { registerLeadResearchRoutes, startLeadResearch, type LeadResearcher } from "./lead-research";
import { registerExecutiveAssistantRoutes } from "./executive-assistant";
import { executeAriaTool, type AriaToolSession } from "./aria-tools";
import { DEFAULT_AUTO_TEXT_TEMPLATE } from "./sales-agents-core";

const marker = `sales-agents-${process.pid}-${Date.now()}`;
const adminId = `${marker}-admin`;
const devId = `${marker}-dev`; // software_developer: no crm feature
const userIds = [adminId, devId];
const contactIds: number[] = [];
const leadIds: number[] = [];
let originalSettings: any = null;
let server: Server;
let baseUrl = "";

function request(path: string, actor: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-actor": actor, ...init?.headers },
  });
}
const json = async (res: Response) => (await res.json()) as any;

async function makeLead(opts: { name: string; phone?: string; company?: string; source?: string; consent?: boolean }) {
  const contact = await pool.query(
    "INSERT INTO crm_contacts (full_name, mobile_phone, company, tags) VALUES ($1,$2,$3,$4) RETURNING id",
    [opts.name, opts.phone ?? null, opts.company ?? null, marker],
  );
  const contactId = Number(contact.rows[0].id);
  contactIds.push(contactId);
  if (opts.consent) {
    await pool.query("INSERT INTO crm_interactions (type, summary, contact_id, performed_by) VALUES ('sms_consent','SMS opt-in',$1,'system')", [contactId]);
  }
  const lead = await pool.query(
    "INSERT INTO crm_leads (contact_id, source, service_type, status) VALUES ($1,$2,'Computer Repair','new') RETURNING id",
    [contactId, opts.source ?? "website_intake"],
  );
  const leadId = Number(lead.rows[0].id);
  leadIds.push(leadId);
  return { contactId, leadId };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for background work");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settingsBody = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, autoTextEnabled: true, autoTextTemplate: DEFAULT_AUTO_TEXT_TEMPLATE, targetMinutes: 5,
  escalateSlack: false, escalationPhones: ["+19545550199"], businessHoursOnly: false, businessStartHour: 9,
  businessEndHour: 18, businessDays: [1, 2, 3, 4, 5], timezone: "America/New_York", excludedSources: [],
  ...overrides,
});

before(async () => {
  await applyStaffAccessMigration();
  await applySalesAgentsMigration();
  originalSettings = (await pool.query("SELECT * FROM speed_to_lead_settings WHERE id=1")).rows[0] ?? null;
  for (const id of userIds) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Test','User')
       ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`, [id, `${id}@example.invalid`]);
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'administrator','approved',FALSE,'{}'), ($2,'software_developer','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role, approval_status=EXCLUDED.approval_status, feature_permissions=EXCLUDED.feature_permissions`,
    [adminId, devId]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actorId = String(req.header("x-test-actor") || "");
    const email = `${actorId}@example.invalid`;
    (req as any).auth = Object.assign(() => ({ userId: actorId, sessionClaims: { userId: actorId, email } }), {
      [Symbol.for("@clerk/express.auth")]: true,
    });
    req.dbUser = {
      id: actorId, email, firstName: "Test", lastName: "User", profileImageUrl: null,
      stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date(), updatedAt: new Date(),
    };
    next();
  });
  registerSpeedToLeadRoutes(app);
  registerLeadGenRoutes(app);
  registerLeadResearchRoutes(app);
  registerExecutiveAssistantRoutes(app);
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Restore the shared automation settings exactly; never leave it switched on.
  if (originalSettings) {
    const o = originalSettings;
    await pool.query(
      `UPDATE speed_to_lead_settings SET enabled=$1, enabled_at=$2, auto_text_enabled=$3, auto_text_template=$4, target_minutes=$5,
         escalate_slack=$6, escalation_phones=$7, business_hours_only=$8, business_start_hour=$9, business_end_hour=$10,
         business_days=$11, timezone=$12, excluded_sources=$13, updated_by=$14, updated_at=$15 WHERE id=1`,
      [o.enabled, o.enabled_at, o.auto_text_enabled, o.auto_text_template, o.target_minutes, o.escalate_slack, o.escalation_phones,
        o.business_hours_only, o.business_start_hour, o.business_end_hour, o.business_days, o.timezone, o.excluded_sources, o.updated_by, o.updated_at]);
  } else {
    await pool.query("DELETE FROM speed_to_lead_settings WHERE id=1");
  }
  const runs = await pool.query("SELECT id FROM lead_gen_runs WHERE created_by = ANY($1::text[])", [userIds]);
  const importedLeads = await pool.query("SELECT lead_id, contact_id FROM lead_gen_prospects WHERE run_id = ANY($1::bigint[])", [runs.rows.map((r: any) => r.id)]);
  leadIds.push(...importedLeads.rows.map((r: any) => r.lead_id).filter(Boolean));
  contactIds.push(...importedLeads.rows.map((r: any) => r.contact_id).filter(Boolean));
  await pool.query("DELETE FROM lead_gen_runs WHERE created_by = ANY($1::text[])", [userIds]);
  await pool.query("DELETE FROM assistant_tasks WHERE owner_user_id = ANY($1::text[])", [userIds]);
  await pool.query("DELETE FROM speed_to_lead_events WHERE lead_id = ANY($1::int[])", [leadIds]);
  await pool.query("DELETE FROM lead_research_briefs WHERE lead_id = ANY($1::int[])", [leadIds]);
  await pool.query("DELETE FROM crm_interactions WHERE lead_id = ANY($1::int[]) OR contact_id = ANY($2::int[])", [leadIds, contactIds]);
  await pool.query("DELETE FROM crm_leads WHERE id = ANY($1::int[])", [leadIds]);
  await pool.query("DELETE FROM crm_contacts WHERE id = ANY($1::int[])", [contactIds]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1::text[])", [userIds]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [userIds]);
});

test("sales agent routes require sign-in, crm access, and owner for automation settings", () => {
  for (const path of ["/api/crm/lead-gen/runs", "/api/crm/lead-gen/prospects/1/import", "/api/crm/speed-to-lead", "/api/crm/lead-research/1"]) {
    assert.equal(isPublicApiRequest("POST", path), false);
    assert.equal(requiredFeatureForApiPath(path, "POST"), "crm");
  }
  assert.equal(requiredFeatureForApiPath("/api/crm/speed-to-lead/settings", "PUT"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/crm/speed-to-lead", "GET"), "crm");
  assert.equal(isPublicApiRequest("GET", "/api/assistant/briefing"), false);
  assert.equal(requiredFeatureForApiPath("/api/assistant/tasks", "POST"), null); // any approved staff
});

test("speed to lead: settings validation, instant text with consent only, first contact and escalation", async () => {
  const bad = await request("/api/crm/speed-to-lead/settings", adminId, { method: "PUT", body: JSON.stringify(settingsBody({ autoTextTemplate: "Hi {firstName}, thanks!" })) });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).message, /STOP/);
  const saved = await request("/api/crm/speed-to-lead/settings", adminId, { method: "PUT", body: JSON.stringify(settingsBody()) });
  assert.equal(saved.status, 200);
  const savedSettings = (await json(saved)).settings;
  assert.equal(savedSettings.enabled, true);
  assert.ok(savedSettings.enabledAt);
  assert.ok(savedSettings.excludedSources.includes("lead_gen_agent"), "cold prospects are always excluded");

  await new Promise((r) => setTimeout(r, 20)); // leads strictly after enabled_at
  const consented = await makeLead({ name: "maria tester", phone: "+19545550101", consent: true });
  const noConsent = await makeLead({ name: "Nate Noconsent", phone: "+19545550102" });
  const cold = await makeLead({ name: "Cold Prospect", phone: "+19545550103", consent: true, source: "lead_gen_agent" });

  const settings = await getSpeedToLeadSettings();
  await openSpeedToLeadClocks(settings);
  const events = await pool.query("SELECT lead_id FROM speed_to_lead_events WHERE lead_id = ANY($1::int[])", [[consented.leadId, noConsent.leadId, cold.leadId]]);
  assert.deepEqual(events.rows.map((r: any) => r.lead_id).sort(), [consented.leadId, noConsent.leadId].sort());

  // Quiet hours (3am New York): nothing is texted, events stay pending.
  const sentTo: Array<{ to: string; body: string }> = [];
  const fakeSend = async (to: string, body: string) => { sentTo.push({ to, body }); return { sid: "SMtest", status: "queued" }; };
  assert.equal(await sendPendingAutoTexts(settings, new Date("2026-11-10T08:00:00Z"), fakeSend), 0);
  assert.equal(sentTo.length, 0);

  // Noon in New York; pin the clocks so the run does not depend on when tests execute.
  const noon = new Date("2026-11-10T17:00:00Z");
  const ids = [consented.leadId, noConsent.leadId];
  await pool.query("UPDATE speed_to_lead_events SET lead_created_at = $2::timestamptz - INTERVAL '1 minute' WHERE lead_id = ANY($1::int[])", [ids, noon]);
  await sendPendingAutoTexts(settings, noon, fakeSend);
  await sendPendingAutoTexts(settings, noon, fakeSend); // second tick must not double-send
  assert.equal(sentTo.length, 1);
  assert.equal(sentTo[0].to, "+19545550101");
  assert.match(sentTo[0].body, /^Hi Maria,/);
  const statuses = await pool.query("SELECT lead_id, auto_text_status, auto_text_detail FROM speed_to_lead_events WHERE lead_id = ANY($1::int[])", [ids]);
  const byLead = Object.fromEntries(statuses.rows.map((r: any) => [r.lead_id, r]));
  assert.equal(byLead[consented.leadId].auto_text_status, "sent");
  assert.equal(byLead[noConsent.leadId].auto_text_status, "skipped");
  assert.match(byLead[noConsent.leadId].auto_text_detail, /consent/i);
  // Leads older than the 16 h window are never texted late.
  const stale = await makeLead({ name: "Stale Lead", phone: "+19545550104", consent: true });
  await openSpeedToLeadClocks(settings);
  await pool.query("UPDATE speed_to_lead_events SET lead_created_at = $2::timestamptz - INTERVAL '17 hours' WHERE lead_id=$1", [stale.leadId, noon]);
  await sendPendingAutoTexts(settings, noon, fakeSend);
  assert.equal(sentTo.length, 1);
  assert.equal((await pool.query("SELECT auto_text_status FROM speed_to_lead_events WHERE lead_id=$1", [stale.leadId])).rows[0].auto_text_status, "skipped");
  await pool.query("UPDATE speed_to_lead_events SET lead_created_at = NOW() - INTERVAL '1 minute', first_contact_at = NOW() WHERE lead_id=$1", [stale.leadId]);
  await pool.query("UPDATE speed_to_lead_events SET lead_created_at = NOW() - INTERVAL '1 minute' WHERE lead_id = ANY($1::int[])", [ids]);

  // The automated text is not a human first contact.
  await detectFirstContacts();
  let open = await pool.query("SELECT first_contact_at FROM speed_to_lead_events WHERE lead_id=$1", [consented.leadId]);
  assert.equal(open.rows[0].first_contact_at, null);
  // A technician's outbound call is.
  await pool.query("INSERT INTO crm_interactions (type, summary, contact_id, performed_by) VALUES ('call_out','Called back',$1,'Alex Tech')", [consented.contactId]);
  await detectFirstContacts();
  open = await pool.query("SELECT first_contact_at, first_contact_by, first_contact_kind FROM speed_to_lead_events WHERE lead_id=$1", [consented.leadId]);
  assert.ok(open.rows[0].first_contact_at);
  assert.equal(open.rows[0].first_contact_by, "Alex Tech");
  assert.equal(open.rows[0].first_contact_kind, "call_out");

  // The other lead waits past the 5 minute target: one staff alert, never repeated.
  await pool.query("UPDATE speed_to_lead_events SET lead_created_at = NOW() - INTERVAL '10 minutes' WHERE lead_id=$1", [noConsent.leadId]);
  const staffTexts: string[] = [];
  const fakeStaff = async (to: string, body: string) => { staffTexts.push(`${to}|${body}`); return {}; };
  await escalateWaitingLeads(settings, new Date(), fakeStaff);
  await escalateWaitingLeads(settings, new Date(), fakeStaff);
  assert.equal(staffTexts.length, 1);
  assert.match(staffTexts[0], /^\+19545550199\|.*Nate Noconsent.*waited 10 min/);

  const queue = await json(await request("/api/crm/speed-to-lead", adminId));
  const waiting = queue.leads.find((l: any) => l.leadId === noConsent.leadId);
  assert.equal(waiting.overdue, true);
  assert.ok(waiting.escalatedAt);
  assert.ok(queue.metrics.contacted >= 1);

  assert.equal((await request(`/api/crm/speed-to-lead/${noConsent.leadId}/contacted`, adminId, { method: "POST" })).status, 200);
  assert.equal((await request(`/api/crm/speed-to-lead/${noConsent.leadId}/contacted`, adminId, { method: "POST" })).status, 404);
});

test("lead generation: prospects are deduplicated, skip CRM companies, and import once as cold leads", async () => {
  const existing = await makeLead({ name: "Owner Person", company: `${marker} Existing Dental LLC` });
  const researcher: LeadGenResearcher = async () => ({
    model: "test-model",
    summary: "Found dental offices.",
    prospects: [
      { businessName: "Bright Smile Dental", website: "www.brightsmile-test.example", phone: "(954) 555-0110", email: "Front@BrightSmile-test.example", fitScore: 91.4, fitReasons: "Two locations.", suggestedServices: ["Managed IT"], openingLine: "Saw you opened a second office.", sources: ["https://brightsmile-test.example", "javascript:alert(1)"] },
      { businessName: "Bright Smile Dental (dup)", website: "https://brightsmile-test.example/contact", fitScore: 50, fitReasons: "", suggestedServices: [], openingLine: "", sources: [] },
      { businessName: `${marker} Existing Dental, LLC`, website: null, fitScore: 80, fitReasons: "", suggestedServices: [], openingLine: "", sources: [] },
      { businessName: "Low Fit Dental", website: null, phone: "12", email: "not-an-email", fitScore: -5, fitReasons: "", suggestedServices: [], openingLine: "", sources: [] },
    ],
  });
  const runId = await startLeadGenRun(adminId, { target: "dental offices", location: "Lauderhill, FL", maxResults: 5 }, researcher);
  const run = await waitFor(async () => {
    const r = await json(await request(`/api/crm/lead-gen/runs/${runId}`, adminId));
    return r.run.status === "running" ? null : r;
  });
  assert.equal(run.run.status, "completed");
  assert.equal(run.run.prospectCount, 2);
  const [top, low] = run.prospects.sort((a: any, b: any) => b.fitScore - a.fitScore);
  assert.equal(top.businessName, "Bright Smile Dental");
  assert.equal(top.website, "https://www.brightsmile-test.example");
  assert.equal(top.phone, "+19545550110");
  assert.equal(top.email, "front@brightsmile-test.example");
  assert.equal(top.fitScore, 91);
  assert.deepEqual(top.sources, ["https://brightsmile-test.example"]);
  assert.equal(low.fitScore, 0);
  assert.equal(low.phone, null);
  assert.equal(low.email, null);
  assert.ok(!run.prospects.some((p: any) => p.businessName.includes("Existing Dental")), "existing CRM company is skipped");
  void existing;

  const imported = await json(await request(`/api/crm/lead-gen/prospects/${top.id}/import`, adminId, { method: "POST" }));
  assert.equal(imported.prospect.status, "imported");
  const lead = (await pool.query("SELECT source, status, priority, contact_id FROM crm_leads WHERE id=$1", [imported.prospect.leadId])).rows[0];
  assert.deepEqual([lead.source, lead.status, lead.priority], ["lead_gen_agent", "new", "high"]);
  const again = await json(await request(`/api/crm/lead-gen/prospects/${top.id}/import`, adminId, { method: "POST" }));
  assert.equal(again.prospect.leadId, imported.prospect.leadId, "import is idempotent");
  assert.equal((await request(`/api/crm/lead-gen/prospects/${top.id}/dismiss`, adminId, { method: "POST" })).status, 409);
  assert.equal((await request(`/api/crm/lead-gen/prospects/${low.id}/dismiss`, adminId, { method: "POST" })).status, 200);

  // A second run that finds the same business does not suggest it again.
  const rerun = await startLeadGenRun(adminId, { target: "dental offices", maxResults: 5 }, researcher);
  const second = await waitFor(async () => {
    const r = await json(await request(`/api/crm/lead-gen/runs/${rerun}`, adminId));
    return r.run.status === "running" ? null : r;
  });
  assert.equal(second.run.prospectCount, 0);
});

test("sales copilot stores a research brief per lead", async () => {
  const { leadId } = await makeLead({ name: "Brief Subject", company: "Acme Law Group" });
  let seenPrompt = "";
  let seenSearches = -1;
  const researcher: LeadResearcher = async (prompt, searches) => {
    seenPrompt = prompt; seenSearches = searches;
    return {
      model: "test-model", grounded: true, sources: ["https://acme-law.example"],
      brief: {
        headline: "Law firm needing managed IT", summary: "Summary.", customerType: "small_business", companyProfile: { name: "Acme Law Group" },
        needs: ["Backups"], recommendedServices: [{ service: "Managed IT", why: "Compliance" }], talkingPoints: ["Client confidentiality"],
        discoveryQuestions: ["How do you back up?"], objections: [{ objection: "Too expensive", response: "Downtime costs more." }], risks: [],
        nextBestAction: { action: "Call", timing: "Today", channel: "call" }, leadScore: 72,
        draftEmail: { subject: "Hello", body: "Hi" }, draftText: "Hi from CSD",
      },
    };
  };
  const started = await startLeadResearch(leadId, adminId, researcher);
  assert.equal(started.alreadyRunning, false);
  const done = await waitFor(async () => {
    const r = await json(await request(`/api/crm/lead-research/${leadId}`, adminId));
    return r.brief?.status === "completed" ? r : null;
  });
  assert.equal(done.lead.company, "Acme Law Group");
  assert.equal(done.brief.brief.headline, "Law firm needing managed IT");
  assert.deepEqual(done.brief.sources, ["https://acme-law.example"]);
  assert.match(seenPrompt, /Acme Law Group/);
  assert.equal(seenSearches, 5, "businesses get web research");
  assert.equal((await request("/api/crm/lead-research/99999999", adminId)).status, 404);
});

test("executive assistant tasks are private and the briefing respects feature access", async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const created = await request("/api/assistant/tasks", adminId, { method: "POST", body: JSON.stringify({ title: "Call the dentist back", dueAt: past, priority: "high" }) });
  assert.equal(created.status, 201);
  const task = (await json(created)).task;
  assert.equal(task.bucket, "overdue");
  assert.equal((await request("/api/assistant/tasks", adminId, { method: "POST", body: JSON.stringify({ title: "" }) })).status, 400);

  // Another staff member can neither see nor change it.
  assert.deepEqual((await json(await request("/api/assistant/tasks", devId))).tasks, []);
  assert.equal((await request(`/api/assistant/tasks/${task.id}`, devId, { method: "PATCH", body: JSON.stringify({ status: "done" }) })).status, 404);
  // Linking to CRM records needs CRM access.
  assert.equal((await request("/api/assistant/tasks", devId, { method: "POST", body: JSON.stringify({ title: "x", leadId: leadIds[0] }) })).status, 403);

  const adminBriefing = (await json(await request("/api/assistant/briefing", adminId))).briefing;
  assert.ok(adminBriefing.tasks.overdue.some((t: any) => t.id === task.id));
  assert.ok(adminBriefing.leads, "crm users see lead sections");
  assert.ok(adminBriefing.speedToLead);
  const devBriefing = (await json(await request("/api/assistant/briefing", devId))).briefing;
  assert.equal(devBriefing.leads, undefined);
  assert.equal(devBriefing.speedToLead, undefined);

  const done = await json(await request(`/api/assistant/tasks/${task.id}`, adminId, { method: "PATCH", body: JSON.stringify({ status: "done" }) }));
  assert.equal(done.task.status, "done");
  assert.ok(done.task.completedAt);
  assert.equal((await request(`/api/assistant/tasks/${task.id}`, adminId, { method: "DELETE" })).status, 200);
});

test("aria tools expose the executive assistant and gate CRM-wide sales data", async () => {
  const scope = { unrestricted: true, staffAdministrator: true, clientIds: new Set<number>(), jobIds: new Set<number>(), contactIds: new Set<number>(), editableContactIds: new Set<number>() } as any;
  const session: AriaToolSession = { userId: adminId, conversationId: 0, scope, canReadCrm: true, canCommunicate: false, features: { crm: true } };
  const created = (await executeAriaTool("create_task", { title: "Follow up with Acme", dueAt: "2030-01-02T10:00:00-05:00" }, session)) as any;
  assert.equal(created.task.createdVia, "aria");
  const listed = (await executeAriaTool("list_tasks", {}, session)) as any;
  assert.ok(listed.tasks.some((t: any) => t.id === created.task.id));
  await executeAriaTool("complete_task", { taskId: created.task.id }, session);
  const briefing = (await executeAriaTool("daily_briefing", {}, session)) as any;
  assert.ok(briefing.tasks && briefing.leads);
  const queue = (await executeAriaTool("speed_to_lead_queue", {}, session)) as any;
  assert.ok(Array.isArray(queue.waiting));

  const noCrm: AriaToolSession = { ...session, userId: devId, canReadCrm: false, features: {} };
  await assert.rejects(executeAriaTool("speed_to_lead_queue", {}, noCrm), /CRM/);
  await assert.rejects(executeAriaTool("lead_research", { leadId: 1 }, noCrm), /CRM/);
  await assert.rejects(executeAriaTool("find_prospects", { target: "law firms" }, noCrm), /CRM/);
  const devBriefing = (await executeAriaTool("daily_briefing", {}, noCrm)) as any;
  assert.equal(devBriefing.leads, undefined);
});
