import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import {
  administratorOnlyAlertSources,
  ALL_STAFF_FEATURES,
  canCreateAlertForSource,
  canViewStaffRecoveryAlert,
  enforceAssignedResourceBoundary,
  getStaffAccess,
  getStaffAssignmentScope,
  registerStaffAccessRoutes,
  roleFeatureMap,
  STAFF_ACCESS_RECOVERY_ALERT_SOURCE,
} from "./staff-access";
import { emergencyAlertService } from "./emergency-alerts";
import { registerRoutes } from "./routes/routes";

const marker = `staff-access-${process.pid}-${Date.now()}`;
const ids = {
  administrator: `${marker}-administrator`,
  regular: `${marker}-regular`,
  suspended: `${marker}-suspended`,
  target: `${marker}-target`,
  owner: `${marker}-owner`,
  noProfile: `${marker}-no-profile`,
};
const ownerEmail = `${marker}-owner@example.invalid`;
let server: Server;
let baseUrl = "";
let oldAdminEmails: string | undefined;
let clientIds: number[] = [];
let contactIds: number[] = [];
let jobIds: number[] = [];
let deviceIds: number[] = [];
let ticketIds: number[] = [];
let logIds: number[] = [];

function request(path: string, actor: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-actor": actor, ...init?.headers },
  });
}

function updateBody(
  features: Record<string, boolean>,
  role: Parameters<typeof roleFeatureMap>[0] = "accounting",
  expectedUpdatedAt: string | null = null,
) {
  return JSON.stringify({
    role,
    approvalStatus: "approved",
    capabilities: { viewVoicemails: true },
    features: { ...roleFeatureMap(role), ...features },
    expectedUpdatedAt,
  });
}

async function profileVersion(userId: string): Promise<string | null> {
  const result = await pool.query("SELECT updated_at FROM staff_access_profiles WHERE user_id=$1", [userId]);
  return result.rows[0]?.updated_at?.toISOString() ?? null;
}

async function assignmentAuditHistory(userId: string) {
  const result = await pool.query(
    `SELECT id, action, previous_access, new_access, created_at
     FROM staff_access_audit
     WHERE target_user_id=$1 AND action='assignments_updated'
     ORDER BY id`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    action: row.action,
    previousAccess: row.previous_access,
    newAccess: row.new_access,
    createdAt: row.created_at.toISOString(),
  }));
}

async function assignmentState(userId: string) {
  const [clients, jobs, profile, audit] = await Promise.all([
    pool.query("SELECT client_id FROM staff_client_assignments WHERE user_id=$1 ORDER BY client_id", [userId]),
    pool.query("SELECT job_id FROM staff_job_assignments WHERE user_id=$1 ORDER BY job_id", [userId]),
    pool.query("SELECT updated_at FROM staff_access_profiles WHERE user_id=$1", [userId]),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
      [userId],
    ),
  ]);
  return {
    clientIds: clients.rows.map((row) => Number(row.client_id)),
    jobIds: jobs.rows.map((row) => Number(row.job_id)),
    updatedAt: profile.rows[0]?.updated_at?.toISOString() ?? null,
    auditCount: audit.rows[0].count,
  };
}

before(async () => {
  oldAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await applyStaffAccessMigration();
  await applyStaffInvitesMigration();
  for (const [name, id] of Object.entries(ids)) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name)
       VALUES($1,$2,$3,'Integration') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
      [id, name === "owner" ? ownerEmail : `${id}@example.invalid`, name],
    );
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'administrator','approved',TRUE,'{}'),($2,'accounting','approved',TRUE,'{}'),
       ($3,'administrator','suspended',TRUE,'{"staffAdmin":true}'),
       ($4,'field_technician','pending',FALSE,'{}'),($5,'administrator','approved',TRUE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,approval_status=EXCLUDED.approval_status,
       can_view_voicemails=EXCLUDED.can_view_voicemails,feature_permissions=EXCLUDED.feature_permissions`,
    [ids.administrator, ids.regular, ids.suspended, ids.target, ids.owner],
  );
  const clients = await pool.query(
    "INSERT INTO clients(name,contact_email) VALUES($1,$2),($3,$4) RETURNING id",
    [`${marker}-a`, `${marker}-a@example.invalid`, `${marker}-b`, `${marker}-b@example.invalid`],
  );
  clientIds = clients.rows.map((row) => Number(row.id));
  const contacts = await pool.query(
    `INSERT INTO crm_contacts(full_name,email,client_id) VALUES($1,$2,$3),($4,$5,$6) RETURNING id`,
    [`${marker}-a`, `${marker}-ca@example.invalid`, clientIds[0], `${marker}-b`, `${marker}-cb@example.invalid`, clientIds[1]],
  );
  contactIds = contacts.rows.map((row) => Number(row.id));
  const jobs = await pool.query(
    `INSERT INTO crm_jobs(contact_id,job_number,service_type)
     VALUES($1,$2,'computer_repair'),($3,$4,'computer_repair') RETURNING id`,
    [contacts.rows[0].id, `${marker}-job-a`, contacts.rows[1].id, `${marker}-job-b`],
  );
  jobIds = jobs.rows.map((row) => Number(row.id));
  const devices = await pool.query(
    `INSERT INTO devices(name,type,status,client_id) VALUES($1,'workstation','online',$2),($3,'workstation','online',$4) RETURNING id`,
    [`${marker}-device-a`, clientIds[0], `${marker}-device-b`, clientIds[1]],
  );
  deviceIds = devices.rows.map((row) => Number(row.id));
  const tickets = await pool.query(
    `INSERT INTO tickets(subject,priority,status,client_id) VALUES($1,'medium','open',$2),($3,'medium','open',$4) RETURNING id`,
    [`${marker}-ticket-a`, clientIds[0], `${marker}-ticket-b`, clientIds[1]],
  );
  ticketIds = tickets.rows.map((row) => Number(row.id));
  const logs = await pool.query(
    `INSERT INTO service_logs(contact_id,job_id,client_name,device_model)
     VALUES($1,$2,$3,'Test'),($4,NULL,$5,'Test'),(NULL,NULL,$6,'Test') RETURNING id`,
    [contacts.rows[0].id, jobIds[0], `${marker}-a`, contacts.rows[1].id, `${marker}-b`, `${marker}-unlinked`],
  );
  logIds = logs.rows.map((row) => Number(row.id));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = String(req.header("x-test-actor") || "");
    req.dbUser = {
      id: actor,
      email: actor === ids.owner ? ownerEmail : `${actor}@example.invalid`,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    next();
  });
  app.get("/test/assignment-scope", async (req, res) => {
    const scope = await getStaffAssignmentScope(req);
    res.json({
      unrestricted: scope.unrestricted,
      staffAdministrator: scope.staffAdministrator,
      clientIds: [...scope.clientIds],
      jobIds: [...scope.jobIds],
      contactIds: [...scope.contactIds],
      editableContactIds: [...scope.editableContactIds],
    });
  });
  app.get("/test/staff-access", async (req, res) => {
    res.json(await getStaffAccess(req));
  });
  app.get("/test/contact-scope/:id", async (req, res) => {
    const scope = await getStaffAssignmentScope(req);
    const contactId = Number(req.params.id);
    if (!scope.unrestricted && !scope.contactIds.has(contactId)) return res.status(404).json({ error: "Contact not found" });
    return res.json({ canEdit: scope.unrestricted || scope.editableContactIds.has(contactId) });
  });
  registerStaffAccessRoutes(app, { isOwner: (req) => req.dbUser?.id === ids.owner });
  app.use(enforceAssignedResourceBoundary);
  server = await registerRoutes(app, { disableBackgroundServices: true });
  for (const path of ["/api/clients/:id/probe", "/api/devices/:id/probe", "/api/tickets/:id/probe",
    "/api/crm/jobs/:id/probe", "/api/service-logs/:id/probe"]) {
    app.get(path, (_req, res) => res.json({ ok: true }));
  }
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM staff_access_audit WHERE target_user_id LIKE $1 OR actor_user_id LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM alerts WHERE alert_source=$1 AND affected_services LIKE $2", [
    STAFF_ACCESS_RECOVERY_ALERT_SOURCE,
    `%${marker}%`,
  ]);
  await pool.query("DELETE FROM service_logs WHERE client_name LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM tickets WHERE subject LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM devices WHERE name LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM crm_jobs WHERE job_number LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM crm_contacts WHERE full_name LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM clients WHERE name LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM auth_users WHERE id LIKE $1", [`${marker}%`]);
  if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = oldAdminEmails;
});

test("assignment changes are authorized, audited, enforced, and revocable", async () => {
  const empty = await (await request("/test/assignment-scope", ids.regular)).json() as any;
  assert.deepEqual(empty, {
    unrestricted: false,
    staffAdministrator: false,
    clientIds: [],
    jobIds: [],
    contactIds: [],
    editableContactIds: [],
  });
  assert.equal((await request(`/api/clients/${clientIds[0]}/probe`, ids.regular)).status, 404);
  assert.equal((await request(`/api/tickets/${ticketIds[0]}x/probe`, ids.regular)).status, 404);
  assert.equal((await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
    method: "PUT", body: JSON.stringify({ clientIds: [clientIds[0]], jobIds: [jobIds[1]] }),
  })).status, 400);
  const expectedUpdatedAt = await profileVersion(ids.regular);
  assert.equal((await request(`/api/staff-access/${ids.regular}/assignments`, ids.regular, {
    method: "PUT", body: JSON.stringify({ clientIds: [clientIds[0]], jobIds: [jobIds[1]], expectedUpdatedAt }),
  })).status, 403);

  const changed = await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
    method: "PUT", body: JSON.stringify({
      clientIds: [clientIds[0]],
      jobIds: [jobIds[1]],
      contactAssignments: [
        { contactId: contactIds[0], canEdit: false },
        { contactId: contactIds[1], canEdit: true },
      ],
      expectedUpdatedAt,
    }),
  });
  assert.equal(changed.status, 200);
  const changedBody = await changed.json() as any;
  assert.ok(changedBody.updatedAt);
  const probes = [
    [`/api/clients/${clientIds[0]}/probe`, 200], [`/api/clients/${clientIds[1]}/probe`, 404],
    [`/api/devices/${deviceIds[0]}/probe`, 200], [`/api/devices/${deviceIds[1]}/probe`, 404],
    [`/api/tickets/${ticketIds[0]}/probe`, 200], [`/api/tickets/${ticketIds[1]}/probe`, 404],
    [`/api/crm/jobs/${jobIds[0]}/probe`, 200], [`/api/crm/jobs/${jobIds[1]}/probe`, 200],
    [`/api/service-logs/${logIds[0]}/probe`, 200], [`/api/service-logs/${logIds[1]}/probe`, 404],
  ] as const;
  for (const [path, status] of probes) assert.equal((await request(path, ids.regular)).status, status, path);
  assert.deepEqual(await (await request(`/test/contact-scope/${contactIds[0]}`, ids.regular)).json(), { canEdit: false });
  assert.deepEqual(await (await request(`/test/contact-scope/${contactIds[1]}`, ids.regular)).json(), { canEdit: true });
  assert.equal((await request(`/api/service-logs/${logIds[2]}/probe`, ids.administrator)).status, 200);

  const audit = await pool.query(
    "SELECT previous_access,new_access FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
    [ids.regular],
  );
  assert.equal(audit.rowCount, 1);
  assert.deepEqual(audit.rows[0].new_access, {
    clientIds: [clientIds[0]],
    jobIds: [jobIds[1]],
    contactAssignments: [
      { contactId: contactIds[0], canEdit: false },
      { contactId: contactIds[1], canEdit: true },
    ],
  });
  assert.equal((await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
    method: "PUT", body: JSON.stringify({ clientIds: [], jobIds: [], contactAssignments: [], expectedUpdatedAt: changedBody.updatedAt }),
  })).status, 200);
  assert.equal((await request(`/api/clients/${clientIds[0]}/probe`, ids.regular)).status, 404);
  assert.equal((await request(`/test/contact-scope/${contactIds[0]}`, ids.regular)).status, 404);
});

test("stale competing assignment edits are rejected without assignment or audit writes", async () => {
  const expectedUpdatedAt = await profileVersion(ids.regular);
  assert.ok(expectedUpdatedAt);
  const auditBefore = await pool.query(
    "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
    [ids.regular],
  );

  const [first, second] = await Promise.all([
    request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
      method: "PUT",
      body: JSON.stringify({ clientIds: [clientIds[0]], jobIds: [jobIds[0]], expectedUpdatedAt }),
    }),
    request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
      method: "PUT",
      body: JSON.stringify({ clientIds: [clientIds[1]], jobIds: [jobIds[1]], expectedUpdatedAt }),
    }),
  ]);
  assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);

  const successfulResponse = first.status === 200 ? first : second;
  const staleResponse = first.status === 409 ? first : second;
  const successfulBody = await successfulResponse.json() as any;
  const staleBody = await staleResponse.json() as any;
  assert.ok(successfulBody.updatedAt);
  assert.equal(staleBody.latestAccess.updatedAt, successfulBody.updatedAt);
  assert.equal(staleBody.latestAccess.role, "accounting");
  assert.equal(staleBody.latestAccess.approvalStatus, "approved");
  assert.equal(staleBody.latestAccess.features.dashboard, true);

  const [assignedClients, assignedJobs] = await Promise.all([
    pool.query("SELECT client_id FROM staff_client_assignments WHERE user_id=$1 ORDER BY client_id", [ids.regular]),
    pool.query("SELECT job_id FROM staff_job_assignments WHERE user_id=$1 ORDER BY job_id", [ids.regular]),
  ]);
  const winningClientId = successfulResponse === first ? clientIds[0] : clientIds[1];
  const winningJobId = successfulResponse === first ? jobIds[0] : jobIds[1];
  assert.deepEqual(assignedClients.rows.map((row) => Number(row.client_id)), [winningClientId]);
  assert.deepEqual(assignedJobs.rows.map((row) => Number(row.job_id)), [winningJobId]);
  const auditAfter = await pool.query(
    "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
    [ids.regular],
  );
  assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count + 1);
});

test("invalid customer and job lists are rejected without changing routing, version, or audit history", async () => {
  const setup = await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
    method: "PUT",
    body: JSON.stringify({
      clientIds: [clientIds[0]],
      jobIds: [jobIds[0]],
      expectedUpdatedAt: await profileVersion(ids.regular),
    }),
  });
  assert.equal(setup.status, 200);
  const setupBody = await setup.json() as { updatedAt: string };
  const baseline = await assignmentState(ids.regular);
  assert.deepEqual(baseline.clientIds, [clientIds[0]]);
  assert.deepEqual(baseline.jobIds, [jobIds[0]]);
  assert.equal(baseline.updatedAt, new Date(setupBody.updatedAt).toISOString());

  const missingClientId = Number((await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM clients")).rows[0].id);
  const missingJobId = Number((await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM crm_jobs")).rows[0].id);
  const invalidLists = [
    { label: "missing customer", clientIds: [missingClientId], jobIds: [jobIds[0]] },
    { label: "missing job", clientIds: [clientIds[0]], jobIds: [missingJobId] },
    { label: "duplicate customer", clientIds: [clientIds[0], clientIds[0]], jobIds: [jobIds[0]] },
    { label: "duplicate job", clientIds: [clientIds[0]], jobIds: [jobIds[0], jobIds[0]] },
    { label: "non-positive customer", clientIds: [0], jobIds: [jobIds[0]] },
    { label: "non-positive job", clientIds: [clientIds[0]], jobIds: [-1] },
    { label: "string customer", clientIds: [String(clientIds[0])], jobIds: [jobIds[0]] },
    { label: "string job", clientIds: [clientIds[0]], jobIds: [String(jobIds[0])] },
    { label: "fractional customer", clientIds: [clientIds[0] + 0.5], jobIds: [jobIds[0]] },
    { label: "fractional job", clientIds: [clientIds[0]], jobIds: [jobIds[0] + 0.5] },
    { label: "boolean customer", clientIds: [true], jobIds: [jobIds[0]] },
    { label: "boolean job", clientIds: [clientIds[0]], jobIds: [false] },
    { label: "null customer", clientIds: [null], jobIds: [jobIds[0]] },
    { label: "null job", clientIds: [clientIds[0]], jobIds: [null] },
    { label: "object customer", clientIds: [{ id: clientIds[0] }], jobIds: [jobIds[0]] },
    { label: "object job", clientIds: [clientIds[0]], jobIds: [{ id: jobIds[0] }] },
    { label: "mixed customer list", clientIds: [clientIds[0], missingClientId], jobIds: [jobIds[0]] },
    { label: "mixed job list", clientIds: [clientIds[0]], jobIds: [jobIds[0], missingJobId] },
  ];

  for (const invalid of invalidLists) {
    const response = await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
      method: "PUT",
      body: JSON.stringify({ ...invalid, expectedUpdatedAt: baseline.updatedAt }),
    });
    assert.equal(response.status, 400, invalid.label);
    assert.deepEqual(await assignmentState(ids.regular), baseline, invalid.label);
  }
});

test("unexpected assignment save failures roll back routing, profile version, and audit history", async () => {
  const setup = await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
    method: "PUT",
    body: JSON.stringify({
      clientIds: [clientIds[0]],
      jobIds: [jobIds[0]],
      expectedUpdatedAt: await profileVersion(ids.regular),
    }),
  });
  assert.equal(setup.status, 200);
  const baseline = await assignmentState(ids.regular);
  const baselineAudit = await assignmentAuditHistory(ids.regular);

  const sqlName = marker.replace(/[^a-zA-Z0-9_]/g, "_");
  const failureFunction = `${sqlName}_assignment_save_failure`;
  const failureTrigger = `${sqlName}_assignment_save_failure_trigger`;
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${failureFunction}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'controlled assignment save failure';
    END;
    $$;
    CREATE TRIGGER ${failureTrigger}
    BEFORE INSERT ON staff_access_audit
    FOR EACH ROW
    WHEN (NEW.action = 'assignments_updated')
    EXECUTE FUNCTION ${failureFunction}();
  `);

  try {
    const response = await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
      method: "PUT",
      body: JSON.stringify({
        clientIds: [clientIds[1]],
        jobIds: [jobIds[1]],
        expectedUpdatedAt: baseline.updatedAt,
      }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await assignmentState(ids.regular), baseline);
    assert.deepEqual(await assignmentAuditHistory(ids.regular), baselineAudit);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${failureTrigger} ON staff_access_audit`);
    await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
  }
});

test("missing, malformed, and null assignment versions are handled without unintended writes", async () => {
  const expectedUpdatedAt = await profileVersion(ids.regular);
  assert.ok(expectedUpdatedAt);
  const before = await Promise.all([
    pool.query("SELECT client_id FROM staff_client_assignments WHERE user_id=$1 ORDER BY client_id", [ids.regular]),
    pool.query("SELECT job_id FROM staff_job_assignments WHERE user_id=$1 ORDER BY job_id", [ids.regular]),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
      [ids.regular],
    ),
  ]);

  const versionInputs = [
    {},
    { expectedUpdatedAt: "not-a-version" },
    { expectedUpdatedAt: null },
  ];
  const expectedStatuses = [400, 400, 409];
  for (const [index, versionInput] of versionInputs.entries()) {
    const response = await request(`/api/staff-access/${ids.regular}/assignments`, ids.administrator, {
      method: "PUT",
      body: JSON.stringify({
        clientIds: [clientIds[0]],
        jobIds: [jobIds[0]],
        ...versionInput,
      }),
    });
    assert.equal(response.status, expectedStatuses[index]);
  }

  const after = await Promise.all([
    pool.query("SELECT client_id FROM staff_client_assignments WHERE user_id=$1 ORDER BY client_id", [ids.regular]),
    pool.query("SELECT job_id FROM staff_job_assignments WHERE user_id=$1 ORDER BY job_id", [ids.regular]),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
      [ids.regular],
    ),
  ]);
  assert.deepEqual(after[0].rows, before[0].rows);
  assert.deepEqual(after[1].rows, before[1].rows);
  assert.equal(after[2].rows[0].count, before[2].rows[0].count);
  assert.equal(await profileVersion(ids.regular), expectedUpdatedAt);
});

test("assignment editing cannot enroll a sign-in-only account without an invitation", async () => {
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [ids.noProfile]);
  assert.equal(await profileVersion(ids.noProfile), null);

  const response = await request(`/api/staff-access/${ids.noProfile}/assignments`, ids.administrator, {
    method: "PUT",
    body: JSON.stringify({ clientIds: [clientIds[0]], jobIds: [jobIds[0]], expectedUpdatedAt: null }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json() as { message: string }).message, /invitation/);
  assert.equal(await profileVersion(ids.noProfile), null);
  assert.equal((await pool.query("SELECT 1 FROM staff_client_assignments WHERE user_id=$1", [ids.noProfile])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM staff_job_assignments WHERE user_id=$1", [ids.noProfile])).rowCount, 0);
});

test("owner assignment attempts are write-free for every version input", async () => {
  const ownerVersion = await profileVersion(ids.owner);
  assert.ok(ownerVersion);
  const auditBefore = await pool.query(
    "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
    [ids.owner],
  );
  const versionInputs = [
    {},
    { expectedUpdatedAt: "not-a-version" },
    { expectedUpdatedAt: null },
    { expectedUpdatedAt: ownerVersion },
  ];
  const expectedStatuses = [400, 400, 403, 403];

  for (const [index, versionInput] of versionInputs.entries()) {
    const response = await request(`/api/staff-access/${ids.owner}/assignments`, ids.administrator, {
      method: "PUT",
      body: JSON.stringify({
        clientIds: [clientIds[0]],
        jobIds: [jobIds[0]],
        ...versionInput,
      }),
    });
    assert.equal(response.status, expectedStatuses[index]);
  }

  const [clients, jobs, auditAfter] = await Promise.all([
    pool.query("SELECT client_id FROM staff_client_assignments WHERE user_id=$1", [ids.owner]),
    pool.query("SELECT job_id FROM staff_job_assignments WHERE user_id=$1", [ids.owner]),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='assignments_updated'",
      [ids.owner],
    ),
  ]);
  assert.equal(clients.rowCount, 0);
  assert.equal(jobs.rowCount, 0);
  assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count);
  assert.equal(await profileVersion(ids.owner), ownerVersion);
});

test("only approved staff administrators can read or change staff access", async () => {
  assert.equal((await request("/api/staff-access", ids.regular)).status, 403);
  assert.equal((await request("/api/staff-access", ids.suspended)).status, 403);
  const response = await request("/api/staff-access", ids.administrator);
  assert.equal(response.status, 200);
  const profiles = await response.json() as any[];
  const pending = profiles.find((profile) => profile.id === ids.target);
  const suspended = profiles.find((profile) => profile.id === ids.suspended);
  assert.ok(pending);
  assert.ok(suspended);
  assert.equal(Object.values(pending.effectiveFeatures).some(Boolean), false);
  assert.equal(Object.values(suspended.effectiveFeatures).some(Boolean), false);
  assert.equal(pending.features.dashboard, true);
  assert.equal(suspended.features.staffAdmin, true);
});

test("only the owner can approve an accepted staff invitation", async () => {
  const userId = `${marker}-invited`;
  const email = `${userId}@example.invalid`;
  const tokenHash = createHash("sha256").update(userId).digest("hex");
  await pool.query(
    "INSERT INTO auth_users(id,email,first_name) VALUES($1,$2,'Invited')",
    [userId, email],
  );
  try {
    await pool.query(
      "INSERT INTO staff_access_profiles(user_id,role,approval_status) VALUES($1,'field_technician','pending')",
      [userId],
    );
    await pool.query(
      `INSERT INTO staff_invites(email,role,token_hash,expires_at,accepted_at,accepted_by)
       VALUES($1,'field_technician',$2,NOW() + INTERVAL '7 days',NOW(),$3)`,
      [email, tokenHash, userId],
    );
    const version = await profileVersion(userId);
    const body = updateBody(roleFeatureMap("field_technician"), "field_technician", version);
    const staffResponse = await request(`/api/staff-access/${userId}`, ids.administrator, { method: "PATCH", body });
    assert.equal(staffResponse.status, 403);
    assert.match((await staffResponse.json() as { message: string }).message, /only the owner/i);
    assert.equal((await pool.query("SELECT approval_status FROM staff_access_profiles WHERE user_id=$1", [userId])).rows[0].approval_status, "pending");
    const ownerResponse = await request(`/api/staff-access/${userId}`, ids.owner, { method: "PATCH", body });
    assert.equal(ownerResponse.status, 200);
    assert.equal((await pool.query("SELECT approval_status FROM staff_access_profiles WHERE user_id=$1", [userId])).rows[0].approval_status, "approved");
  } finally {
    await pool.query("DELETE FROM staff_invites WHERE accepted_by=$1", [userId]);
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id=$1", [userId]);
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [userId]);
  }
});

test("viewing access and the roster never provisions an uninvited account", async () => {
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [ids.noProfile]);
  const access = await (await request("/test/staff-access", ids.noProfile)).json() as any;
  assert.equal(access.approvalStatus, "pending");
  assert.equal(Object.values(access.features).some(Boolean), false);
  assert.equal(await profileVersion(ids.noProfile), null);
  const roster = await (await request("/api/staff-access", ids.administrator)).json() as any[];
  assert.equal(roster.some((person) => person.id === ids.noProfile), false);
  assert.equal(await profileVersion(ids.noProfile), null);
});

test("even an owner cannot enroll a sign-in-only account through the access editor", async () => {
  const response = await request(`/api/staff-access/${ids.noProfile}`, ids.owner, {
    method: "PATCH",
    body: updateBody({}, "field_technician", null),
  });
  assert.equal(response.status, 403, await response.clone().text());
  assert.match((await response.json() as { message: string }).message, /invitation/);
  assert.equal(await profileVersion(ids.noProfile), null);
});

test("only administrators receive complete access audit history", async () => {
  const createdAt = new Date("2026-09-08T12:34:56.000Z");
  const inserted = await pool.query(
    `INSERT INTO staff_access_audit
       (target_user_id,actor_user_id,action,previous_access,new_access,created_at)
     VALUES($1,$2,'access_updated',$3::jsonb,$4::jsonb,$5)
     RETURNING id`,
    [
      ids.target,
      ids.administrator,
      JSON.stringify({
        role: "field_technician",
        approval_status: "pending",
        can_view_voicemails: false,
        feature_permissions: { reports: false },
      }),
      JSON.stringify({
        role: "administrator",
        approval_status: "approved",
        can_view_voicemails: true,
        feature_permissions: { reports: true },
      }),
      createdAt,
    ],
  );

  assert.equal((await request("/api/staff-access/audit", ids.regular)).status, 403);
  assert.equal((await request("/api/staff-access/audit", ids.suspended)).status, 403);

  const response = await request("/api/staff-access/audit", ids.administrator);
  assert.equal(response.status, 200);
  const history = await response.json() as any[];
  const entry = history.find((item) => item.id === String(inserted.rows[0].id));
  assert.ok(entry);
  assert.equal(entry.actorEmail, `${ids.administrator}@example.invalid`);
  assert.equal(entry.targetEmail, `${ids.target}@example.invalid`);
  assert.equal(new Date(entry.createdAt).toISOString(), createdAt.toISOString());
  assert.deepEqual(entry.previousAccess, {
    role: "field_technician",
    approval_status: "pending",
    can_view_voicemails: false,
    feature_permissions: { reports: false },
  });
  assert.deepEqual(entry.newAccess, {
    role: "administrator",
    approval_status: "approved",
    can_view_voicemails: true,
    feature_permissions: { reports: true },
  });
  await pool.query("DELETE FROM staff_access_audit WHERE id=$1", [inserted.rows[0].id]);
});

test("conflict recovery outcomes are linked to the administrator without storing reload data", async () => {
  const invalidResponse = await request(`/api/staff-access/${ids.target}/recovery-audit`, ids.administrator, {
    method: "POST",
    body: JSON.stringify({ outcome: "unexpected", rawResponse: "should-not-be-accepted" }),
  });
  assert.equal(invalidResponse.status, 400);

  const failedResponse = await request(`/api/staff-access/${ids.target}/recovery-audit`, ids.administrator, {
    method: "POST",
    body: JSON.stringify({
      outcome: "failed",
      error: "raw provider response: password=should-not-persist",
      credentials: { token: "should-not-persist" },
    }),
  });
  assert.equal(failedResponse.status, 204);

  const succeededResponse = await request(`/api/staff-access/${ids.target}/recovery-audit`, ids.administrator, {
    method: "POST",
    body: JSON.stringify({ outcome: "succeeded", response: "raw response should not persist" }),
  });
  assert.equal(succeededResponse.status, 204);
  assert.equal((await request(`/api/staff-access/${ids.target}/recovery-audit`, ids.regular, {
    method: "POST",
    body: JSON.stringify({ outcome: "failed" }),
  })).status, 403);

  const historyResponse = await request("/api/staff-access/audit", ids.administrator);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as any[];
  const recoveryEntries = history
    .filter((entry) => entry.targetEmail === `${ids.target}@example.invalid`)
    .filter((entry) => entry.action.startsWith("conflict_recovery_"));
  assert.equal(recoveryEntries.length, 2);
  assert.deepEqual(
    recoveryEntries.map((entry) => entry.action).sort(),
    ["conflict_recovery_failed", "conflict_recovery_succeeded"],
  );
  for (const entry of recoveryEntries) {
    assert.equal(entry.actorEmail, `${ids.administrator}@example.invalid`);
    assert.deepEqual(entry.previousAccess, { recovery: "conflict" });
    assert.deepEqual(entry.newAccess, {
      outcome: entry.action === "conflict_recovery_failed" ? "failed" : "succeeded",
    });
  }
  const serializedEntries = JSON.stringify(recoveryEntries);
  assert.equal(serializedEntries.includes("should-not-persist"), false);
  assert.equal(serializedEntries.includes("raw response"), false);
  await pool.query(
    "DELETE FROM staff_access_audit WHERE target_user_id=$1 AND action LIKE 'conflict_recovery_%'",
    [ids.target],
  );
});

test("repeated recovery failures create one sanitized administrator alert", async () => {
  await pool.query(
    "DELETE FROM alerts WHERE alert_source=$1 AND affected_services=$2",
    [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, JSON.stringify([`staff-access-recovery:${ids.target}`])],
  );
  await pool.query(
    "DELETE FROM staff_access_audit WHERE target_user_id=$1 AND action='conflict_recovery_failed'",
    [ids.target],
  );

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(`/api/staff-access/${ids.target}/recovery-audit`, ids.administrator, {
        method: "POST",
        body: JSON.stringify({
          outcome: "failed",
          rawReloadResponse: "password=should-not-persist",
          credentials: { token: "should-not-persist" },
        }),
      });
      assert.equal(response.status, 204);
    }

    const firstAlert = await pool.query(
      `SELECT title, description, severity, category, status, alert_source, affected_services
       FROM alerts
       WHERE alert_source=$1 AND affected_services=$2`,
      [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, JSON.stringify([`staff-access-recovery:${ids.target}`])],
    );
    assert.equal(firstAlert.rows.length, 1);
    assert.equal(firstAlert.rows[0].severity, "high");
    assert.equal(firstAlert.rows[0].category, "security");
    assert.equal(firstAlert.rows[0].status, "active");
    assert.match(firstAlert.rows[0].description, /failed 3 times/);
    assert.match(firstAlert.rows[0].description, /target Integration/);
    assert.doesNotMatch(JSON.stringify(firstAlert.rows[0]), /password|token|reload response|credentials/i);

    const fourthResponse = await request(`/api/staff-access/${ids.target}/recovery-audit`, ids.administrator, {
      method: "POST",
      body: JSON.stringify({ outcome: "failed", rawResponse: "raw response should-not-persist" }),
    });
    assert.equal(fourthResponse.status, 204);
    const updatedAlert = await pool.query(
      "SELECT description FROM alerts WHERE alert_source=$1 AND affected_services=$2",
      [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, JSON.stringify([`staff-access-recovery:${ids.target}`])],
    );
    assert.equal(updatedAlert.rows.length, 1);
    assert.match(updatedAlert.rows[0].description, /failed 4 times/);
    assert.doesNotMatch(updatedAlert.rows[0].description, /raw response|password|token/i);
  } finally {
    await pool.query(
      "DELETE FROM staff_access_audit WHERE target_user_id=$1 AND action='conflict_recovery_failed'",
      [ids.target],
    );
    await pool.query(
      "DELETE FROM alerts WHERE alert_source=$1 AND affected_services=$2",
      [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, JSON.stringify([`staff-access-recovery:${ids.target}`])],
    );
  }
});

test("stale recovery failures are ignored until a fresh threshold burst", async () => {
  const alertTargetMarker = JSON.stringify([`staff-access-recovery:${ids.target}`]);
  await pool.query(
    "DELETE FROM alerts WHERE alert_source=$1 AND affected_services=$2",
    [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, alertTargetMarker],
  );
  await pool.query(
    "DELETE FROM staff_access_audit WHERE target_user_id=$1 AND action='conflict_recovery_failed'",
    [ids.target],
  );

  try {
    await pool.query(
      `INSERT INTO staff_access_audit
         (target_user_id, actor_user_id, action, previous_access, new_access, created_at)
       SELECT $1, $2, 'conflict_recovery_failed',
              '{"recovery":"conflict"}'::jsonb, '{"outcome":"failed"}'::jsonb,
              NOW() - INTERVAL '11 minutes'
       FROM generate_series(1, 3)`,
      [ids.target, ids.administrator],
    );

    const submitFreshFailure = () =>
      request(`/api/staff-access/${ids.target}/recovery-audit`, ids.administrator, {
        method: "POST",
        body: JSON.stringify({
          outcome: "failed",
          rawReloadResponse: "password=stale-window-secret",
          credentials: { token: "stale-window-token" },
        }),
      });

    assert.equal((await submitFreshFailure()).status, 204);
    const beforeThreshold = await pool.query(
      "SELECT id FROM alerts WHERE alert_source=$1 AND affected_services=$2",
      [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, alertTargetMarker],
    );
    assert.equal(beforeThreshold.rows.length, 0);

    assert.equal((await submitFreshFailure()).status, 204);
    assert.equal((await submitFreshFailure()).status, 204);

    const alerts = await pool.query(
      `SELECT title, description, severity, category, status, alert_source, affected_services
       FROM alerts
       WHERE alert_source=$1 AND affected_services=$2`,
      [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, alertTargetMarker],
    );
    assert.equal(alerts.rows.length, 1);
    assert.match(alerts.rows[0].description, /failed 3 times/);
    assert.doesNotMatch(
      JSON.stringify(alerts.rows[0]),
      /stale-window-secret|stale-window-token|rawReloadResponse|credentials/i,
    );

    const audits = await pool.query(
      `SELECT previous_access, new_access
       FROM staff_access_audit
       WHERE target_user_id=$1 AND action='conflict_recovery_failed'
       ORDER BY id`,
      [ids.target],
    );
    assert.equal(audits.rows.length, 6);
    assert.doesNotMatch(
      JSON.stringify(audits.rows),
      /stale-window-secret|stale-window-token|rawReloadResponse|credentials/i,
    );
  } finally {
    await pool.query(
      "DELETE FROM staff_access_audit WHERE target_user_id=$1 AND action='conflict_recovery_failed'",
      [ids.target],
    );
    await pool.query(
      "DELETE FROM alerts WHERE alert_source=$1 AND affected_services=$2",
      [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, alertTargetMarker],
    );
  }
});

test("staff recovery alerts are restricted without changing ordinary alert visibility", () => {
  assert.equal(canCreateAlertForSource(false, STAFF_ACCESS_RECOVERY_ALERT_SOURCE), false);
  assert.equal(canCreateAlertForSource(true, STAFF_ACCESS_RECOVERY_ALERT_SOURCE), true);
  assert.equal(canCreateAlertForSource(false, "device-monitor"), true);
  assert.equal(canCreateAlertForSource(false, null), true);
  assert.equal(canViewStaffRecoveryAlert(false, STAFF_ACCESS_RECOVERY_ALERT_SOURCE), false);
  assert.equal(canViewStaffRecoveryAlert(true, STAFF_ACCESS_RECOVERY_ALERT_SOURCE), true);
  assert.equal(canViewStaffRecoveryAlert(false, "device-monitor"), true);
  assert.equal(canViewStaffRecoveryAlert(false, null), true);
});

test("every administrator-only alert source rejects ordinary staff before writes or emergency dispatch", async () => {
  const reservedSources = administratorOnlyAlertSources();
  assert.ok(reservedSources.length > 0);
  assert.equal(Object.isFrozen(reservedSources), true);
  await pool.query(
    `INSERT INTO staff_client_assignments(user_id,client_id)
     VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [ids.regular, clientIds[0]],
  );
  const originalProcessAlert = emergencyAlertService.processAlert;
  const dispatchedAlertIds: number[] = [];
  emergencyAlertService.processAlert = async (alert) => {
    dispatchedAlertIds.push(alert.id);
  };

  try {
    for (const [index, alertSource] of reservedSources.entries()) {
      const affectedServices = JSON.stringify([`${marker}-creation-policy-${index}`]);
      const alertBody = {
        title: `${marker}-created-alert-${index}`,
        description: "Creation authorization test",
        severity: "high",
        category: "security",
        clientId: clientIds[0],
        alertSource,
        affectedServices,
      };

      const rejected = await request("/api/alerts", ids.regular, {
        method: "POST",
        body: JSON.stringify(alertBody),
      });
      assert.equal(rejected.status, 403, alertSource);
      assert.deepEqual(
        await rejected.json(),
        { error: "Administrator access required" },
        alertSource,
      );
      assert.equal(
        Number((await pool.query(
          "SELECT COUNT(*)::int AS count FROM alerts WHERE affected_services=$1",
          [affectedServices],
        )).rows[0].count),
        0,
        alertSource,
      );
      assert.deepEqual(dispatchedAlertIds, [], alertSource);

      const administratorResponse = await request("/api/alerts", ids.administrator, {
        method: "POST",
        body: JSON.stringify(alertBody),
      });
      assert.equal(administratorResponse.status, 201, alertSource);
      const administratorAlert = await administratorResponse.json() as any;
      assert.equal(administratorAlert.alertSource, alertSource);
      assert.deepEqual(
        dispatchedAlertIds,
        [administratorAlert.id],
        alertSource,
      );
      dispatchedAlertIds.length = 0;
    }

    const ordinaryResponse = await request("/api/alerts", ids.regular, {
      method: "POST",
      body: JSON.stringify({
        title: `${marker}-ordinary-created-alert`,
        description: "Creation authorization test",
        severity: "high",
        category: "security",
        clientId: clientIds[0],
        alertSource: "device-monitor",
        affectedServices: JSON.stringify([`${marker}-creation-policy-ordinary`]),
      }),
    });
    assert.equal(ordinaryResponse.status, 201);
    const ordinaryAlert = await ordinaryResponse.json() as any;
    assert.equal(ordinaryAlert.alertSource, "device-monitor");
    assert.deepEqual(dispatchedAlertIds, [ordinaryAlert.id]);

    const deviceResponse = await request("/api/alerts", ids.regular, {
      method: "POST",
      body: JSON.stringify({
        title: `${marker}-device-created-alert`,
        description: "Creation authorization test",
        severity: "high",
        category: "security",
        deviceId: deviceIds[0],
        alertSource: "device-monitor",
        affectedServices: JSON.stringify([`${marker}-creation-policy-device`]),
      }),
    });
    assert.equal(deviceResponse.status, 201);
    const deviceAlert = await deviceResponse.json() as any;
    assert.equal(deviceAlert.deviceId, deviceIds[0]);
    assert.deepEqual(
      dispatchedAlertIds,
      [ordinaryAlert.id, deviceAlert.id],
    );
  } finally {
    emergencyAlertService.processAlert = originalProcessAlert;
    await pool.query("DELETE FROM alerts WHERE affected_services LIKE $1", [`%${marker}-creation-policy%`]);
  }
});

test("every alert response hides administrator-only incidents from ordinary staff without changing assigned alerts", async () => {
  const reservedSources = administratorOnlyAlertSources();
  assert.ok(reservedSources.length > 0);
  const affectedServices = JSON.stringify([`${marker}-route-policy`]);
  await pool.query(
    `INSERT INTO staff_client_assignments(user_id,client_id)
     VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [ids.regular, clientIds[0]],
  );
  const reservedAlertIds = new Map<string, number>();
  for (const [index, alertSource] of reservedSources.entries()) {
    const inserted = await pool.query(
      `INSERT INTO alerts
         (title,description,severity,category,client_id,status,alert_source,affected_services)
       VALUES ($1,$2,'high','security',NULL,'active',$3,$4)
       RETURNING id`,
      [
        `${marker}-reserved-${index}`,
        "Internal administrator-only incident",
        alertSource,
        affectedServices,
      ],
    );
    reservedAlertIds.set(alertSource, Number(inserted.rows[0].id));
  }
  const ordinaryInsert = await pool.query(
    `INSERT INTO alerts
       (title,description,severity,category,client_id,status,alert_source,affected_services)
     VALUES ($1,$2,'critical','general',$3,'active','device-monitor',$4)
     RETURNING id`,
    [
      `${marker}-ordinary`,
      "Assigned customer alert",
      clientIds[0],
      affectedServices,
    ],
  );
  const ordinaryId = Number(ordinaryInsert.rows[0].id);

  try {
    for (const path of ["/api/alerts", "/api/alerts/active"]) {
      const staffResponse = await request(path, ids.regular);
      assert.equal(staffResponse.status, 200);
      const staffAlerts = await staffResponse.json() as any[];
      for (const [alertSource, alertId] of reservedAlertIds) {
        assert.equal(staffAlerts.some((alert) => alert.id === alertId), false, `${path} ${alertSource}`);
      }
      assert.equal(staffAlerts.some((alert) => alert.id === ordinaryId), true, path);

      const administratorResponse = await request(path, ids.administrator);
      assert.equal(administratorResponse.status, 200);
      const administratorAlerts = await administratorResponse.json() as any[];
      for (const [alertSource, alertId] of reservedAlertIds) {
        assert.equal(administratorAlerts.some((alert) => alert.id === alertId), true, `${path} ${alertSource}`);
      }
      assert.equal(administratorAlerts.some((alert) => alert.id === ordinaryId), true, path);
    }

    const staffMetrics = await request("/api/dashboard/metrics", ids.regular);
    assert.equal(staffMetrics.status, 200);
    const staffMetricBody = await staffMetrics.json() as any;
    assert.equal(staffMetricBody.activeAlerts, 1);
    assert.equal(staffMetricBody.criticalAlerts, 1);
    assert.equal(staffMetricBody.attentionAlerts, 0);

    const administratorMetrics = await request("/api/dashboard/metrics", ids.administrator);
    assert.equal(administratorMetrics.status, 200);
    const administratorMetricBody = await administratorMetrics.json() as any;
    assert.equal(
      administratorMetricBody.activeAlerts >= staffMetricBody.activeAlerts + reservedSources.length,
      true,
    );
    assert.equal(
      administratorMetricBody.attentionAlerts >= staffMetricBody.attentionAlerts + reservedSources.length,
      true,
    );

    for (const [alertSource, alertId] of reservedAlertIds) {
      const staffMutations: Array<[string, RequestInit]> = [
        [`/api/alerts/${alertId}/acknowledge`, {
          method: "POST",
          body: JSON.stringify({}),
        }],
        [`/api/alerts/${alertId}`, {
          method: "PUT",
          body: JSON.stringify({ severity: "low" }),
        }],
        [`/api/alerts/${alertId}`, { method: "DELETE" }],
      ];
      for (const [path, init] of staffMutations) {
        const response = await request(path, ids.regular, init);
        assert.equal(response.status, 404, `${alertSource} ${init.method} ${path}`);
        assert.deepEqual(await response.json(), { error: "Alert not found" }, alertSource);
      }
    }

    const unchanged = await pool.query(
      `SELECT id,severity,status,acknowledged_at,resolved_at
       FROM alerts WHERE id = ANY($1::int[]) ORDER BY id`,
      [[...reservedAlertIds.values()]],
    );
    assert.equal(unchanged.rowCount, reservedSources.length);
    for (const alert of unchanged.rows) {
      assert.equal(alert.severity, "high");
      assert.equal(alert.status, "active");
      assert.equal(alert.acknowledged_at, null);
      assert.equal(alert.resolved_at, null);
    }

    assert.equal((await request(`/api/alerts/${ordinaryId}`, ids.regular, {
      method: "PUT",
      body: JSON.stringify({ severity: "medium" }),
    })).status, 200);
    assert.equal((await request(`/api/alerts/${ordinaryId}/acknowledge`, ids.regular, {
      method: "POST",
      body: JSON.stringify({}),
    })).status, 200);
    assert.equal((await request(`/api/alerts/${ordinaryId}`, ids.regular, {
      method: "DELETE",
    })).status, 200);

    for (const [alertSource, alertId] of reservedAlertIds) {
      assert.equal((await request(`/api/alerts/${alertId}`, ids.administrator, {
        method: "PUT",
        body: JSON.stringify({ severity: "medium" }),
      })).status, 200, alertSource);
      assert.equal((await request(`/api/alerts/${alertId}/acknowledge`, ids.administrator, {
        method: "POST",
        body: JSON.stringify({}),
      })).status, 200, alertSource);
      assert.equal((await request(`/api/alerts/${alertId}`, ids.administrator, {
        method: "DELETE",
      })).status, 200, alertSource);
    }
  } finally {
    await pool.query("DELETE FROM alerts WHERE affected_services=$1", [affectedServices]);
  }
});

test("role defaults are complete and never grant billing", async () => {
  const response = await request("/api/staff-access/role-features", ids.administrator);
  assert.equal(response.status, 200);
  const defaults = await response.json() as Record<string, Record<string, boolean>>;
  for (const features of Object.values(defaults)) {
    assert.deepEqual(Object.keys(features), ALL_STAFF_FEATURES);
    assert.equal(features.billing, false);
  }
});

test("feature changes persist configured grants and create audit rows", async () => {
  const features = { dashboard: true, crm: true, reports: true, billing: true };
  const response = await request(`/api/staff-access/${ids.target}`, ids.administrator, {
    method: "PATCH", body: updateBody(features, "accounting", await profileVersion(ids.target)),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.features.reports, true);
  assert.equal(body.features.billing, false);
  const audit = await pool.query("SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1", [ids.target]);
  assert.equal(audit.rows[0].count, 1);
});

test("incomplete feature maps are rejected without profile or audit writes", async () => {
  const expectedUpdatedAt = await profileVersion(ids.target);
  const auditBefore = await pool.query(
    "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1",
    [ids.target],
  );
  const response = await request(`/api/staff-access/${ids.target}`, ids.administrator, {
    method: "PATCH",
    body: JSON.stringify({
      role: "accounting",
      approvalStatus: "approved",
      capabilities: { viewVoicemails: true },
      features: { dashboard: true },
      expectedUpdatedAt,
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(await profileVersion(ids.target), expectedUpdatedAt);
  const auditAfter = await pool.query(
    "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1",
    [ids.target],
  );
  assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count);
});

test("an administrator cannot create staff access for an account without an accepted invitation", async () => {
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [ids.noProfile]);
  const response = await request(`/api/staff-access/${ids.noProfile}`, ids.administrator, {
    method: "PATCH", body: updateBody({ dashboard: true, crm: true }, "secretary"),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json() as { message: string }).message, /invitation/);
  const profile = await pool.query("SELECT role,approval_status FROM staff_access_profiles WHERE user_id=$1", [ids.noProfile]);
  assert.equal(profile.rowCount, 0);
});

test("owner and missing-user changes are rejected without writes", async () => {
  assert.equal((await request(`/api/staff-access/${ids.owner}`, ids.administrator, {
    method: "PATCH", body: updateBody({ dashboard: false }, "accounting", await profileVersion(ids.owner)),
  })).status, 403);
  const missing = `${marker}-missing`;
  assert.equal((await request(`/api/staff-access/${missing}`, ids.administrator, {
    method: "PATCH", body: updateBody({ dashboard: true }),
  })).status, 404);
  const audit = await pool.query(
    "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id = ANY($1::text[])",
    [[ids.owner, missing]],
  );
  assert.equal(audit.rows[0].count, 0);
});

test("concurrent access edits preserve the winning settings and exactly one history entry after refresh", async () => {
  const expectedUpdatedAt = await profileVersion(ids.target);
  assert.ok(expectedUpdatedAt);
  const auditBefore = await pool.query(
    "SELECT id FROM staff_access_audit WHERE target_user_id=$1 ORDER BY id",
    [ids.target],
  );

  const [accountingResponse, legalResponse] = await Promise.all([
    request(`/api/staff-access/${ids.target}`, ids.administrator, {
      method: "PATCH",
      body: updateBody({ dashboard: true, crm: false, reports: true }, "accounting", expectedUpdatedAt),
    }),
    request(`/api/staff-access/${ids.target}`, ids.administrator, {
      method: "PATCH",
      body: updateBody({ dashboard: false, crm: true, reports: false }, "legal_team", expectedUpdatedAt),
    }),
  ]);
  assert.deepEqual([accountingResponse.status, legalResponse.status].sort((a, b) => a - b), [200, 409]);

  const winningResponse = accountingResponse.status === 200 ? accountingResponse : legalResponse;
  const staleResponse = accountingResponse.status === 409 ? accountingResponse : legalResponse;
  const winningBody = await winningResponse.json() as any;
  const staleBody = await staleResponse.json() as any;
  const winningRole = accountingResponse.status === 200 ? "accounting" : "legal_team";
  const winningCrm = winningRole === "legal_team";
  assert.equal(staleBody.latestAccess.role, winningRole);
  assert.equal(staleBody.latestAccess.approvalStatus, "approved");
  assert.equal(staleBody.latestAccess.features.crm, winningCrm);
  assert.equal(staleBody.latestAccess.capabilities.viewVoicemails, true);

  const refreshedStaffResponse = await request("/api/staff-access", ids.administrator);
  assert.equal(refreshedStaffResponse.status, 200);
  const refreshedStaff = await refreshedStaffResponse.json() as any[];
  const refreshedTarget = refreshedStaff.find((item) => item.id === ids.target);
  assert.ok(refreshedTarget);
  assert.equal(refreshedTarget.role, winningRole);
  assert.equal(refreshedTarget.features.crm, winningCrm);
  assert.equal(new Date(refreshedTarget.updatedAt).toISOString(), new Date(winningBody.updatedAt).toISOString());

  const historyResponse = await request("/api/staff-access/audit", ids.administrator);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as any[];
  const priorIds = new Set(auditBefore.rows.map((row) => String(row.id)));
  const newEntries = history.filter((entry) => entry.targetEmail === `${ids.target}@example.invalid` && !priorIds.has(entry.id));
  assert.equal(newEntries.length, 1);
  assert.equal(newEntries[0].action, "access_updated");
  assert.equal(newEntries[0].newAccess.role, winningRole);
  assert.equal(newEntries[0].newAccess.approval_status, "approved");
  assert.equal(newEntries[0].newAccess.can_view_voicemails, true);
  assert.equal(newEntries[0].newAccess.feature_permissions.crm, winningCrm);
});