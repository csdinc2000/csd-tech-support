import type { Express, NextFunction, Request, Response } from "express";
import { pool } from "./db";
import { isAdminEmail, isAdminUser, isOwnerIdentity } from "./security";

export type StaffRole =
  | "administrator" | "field_technician" | "software_developer" | "accounting"
  | "it_manager" | "legal_team" | "secretary";
export type ApprovalStatus = "pending" | "approved" | "suspended";
export type StaffFeature =
  | "dashboard" | "crm" | "communications" | "scheduling" | "operations"
  | "helpdesk" | "invoices" | "reports" | "automation" | "compliance"
  | "helpdeskAdmin" | "dispatchAdmin" | "staffAdmin" | "billing" | "marketplace";

export const STAFF_ACCESS_RECOVERY_FAILURE_THRESHOLD = 3;
export const STAFF_ACCESS_RECOVERY_FAILURE_WINDOW_MINUTES = 10;
export const STAFF_ACCESS_RECOVERY_ALERT_SOURCE = "staff-access-recovery";

const ADMINISTRATOR_ONLY_ALERT_SOURCES = new Set<string>([
  STAFF_ACCESS_RECOVERY_ALERT_SOURCE,
]);

export function administratorOnlyAlertSources(): readonly string[] {
  return Object.freeze([...ADMINISTRATOR_ONLY_ALERT_SOURCES]);
}

export function canCreateAlertForSource(
  staffAdministrator: boolean,
  alertSource: string | null | undefined,
): boolean {
  return !alertSource
    || !ADMINISTRATOR_ONLY_ALERT_SOURCES.has(alertSource)
    || staffAdministrator;
}

export function canViewStaffRecoveryAlert(
  staffAdministrator: boolean,
  alertSource: string | null | undefined,
): boolean {
  return canCreateAlertForSource(staffAdministrator, alertSource);
}

export const ALL_STAFF_FEATURES: StaffFeature[] = [
  "dashboard", "crm", "communications", "scheduling", "operations", "helpdesk",
  "invoices", "reports", "automation", "compliance", "helpdeskAdmin",
  "dispatchAdmin", "staffAdmin", "billing", "marketplace",
];

const ROLE_FEATURES: Record<StaffRole, StaffFeature[]> = {
  administrator: ALL_STAFF_FEATURES.filter((feature) => feature !== "billing"),
  field_technician: ["dashboard", "communications", "operations", "helpdesk", "automation", "marketplace"],
  software_developer: ["dashboard", "operations", "helpdesk", "reports", "automation"],
  accounting: ["dashboard", "crm", "invoices", "reports"],
  it_manager: ["dashboard", "crm", "communications", "scheduling", "operations", "helpdesk", "reports", "automation", "compliance", "helpdeskAdmin", "dispatchAdmin", "marketplace"],
  legal_team: ["dashboard", "crm", "reports", "compliance"],
  secretary: ["dashboard", "crm", "communications", "scheduling", "helpdesk", "invoices", "marketplace"],
};

const STAFF_ROLES = Object.keys(ROLE_FEATURES) as StaffRole[];

export function roleFeatureMap(role: StaffRole): Record<StaffFeature, boolean> {
  return Object.fromEntries(ALL_STAFF_FEATURES.map((feature) => [
    feature,
    feature !== "billing" && ROLE_FEATURES[role].includes(feature),
  ])) as Record<StaffFeature, boolean>;
}

export type StaffAccess = {
  role: StaffRole | "owner";
  approvalStatus: ApprovalStatus;
  features: Record<StaffFeature, boolean>;
  configuredFeatures: Record<StaffFeature, boolean>;
  capabilities: { viewVoicemails: boolean };
};

type StaffAccessSnapshot = {
  role: StaffRole;
  approvalStatus: ApprovalStatus;
  features: Record<StaffFeature, boolean>;
  effectiveFeatures: Record<StaffFeature, boolean>;
  capabilities: { viewVoicemails: boolean };
  updatedAt: Date | null;
};

export type StaffAssignmentScope = {
  unrestricted: boolean;
  staffAdministrator: boolean;
  clientIds: Set<number>;
  jobIds: Set<number>;
  contactIds: Set<number>;
  editableContactIds: Set<number>;
};
function featureMap(role: StaffRole, status: ApprovalStatus, overrides: Record<string, unknown> = {}) {
  const approved = status === "approved";
  return Object.fromEntries(ALL_STAFF_FEATURES.map((feature) => [
    feature,
    approved && feature !== "billing"
      ? (typeof overrides[feature] === "boolean" ? overrides[feature] : ROLE_FEATURES[role].includes(feature))
      : false,
  ])) as Record<StaffFeature, boolean>;
}

function accessSnapshotFromRow(row: any): StaffAccessSnapshot {
  const role = (STAFF_ROLES.includes(row?.role) ? row.role : "field_technician") as StaffRole;
  const approvalStatus = (["approved", "suspended"].includes(row?.approval_status)
    ? row.approval_status : "pending") as ApprovalStatus;
  return {
    role,
    approvalStatus,
    features: featureMap(role, "approved", row?.feature_permissions),
    effectiveFeatures: featureMap(role, approvalStatus, row?.feature_permissions),
    capabilities: {
      viewVoicemails: approvalStatus === "approved" && row?.can_view_voicemails !== false,
    },
    updatedAt: row?.updated_at ?? null,
  };
}

async function accessForUserId(userId: string): Promise<StaffAccess> {
  const result = await pool.query(
    `SELECT role, can_view_voicemails, approval_status, feature_permissions
     FROM staff_access_profiles WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  const role = (STAFF_ROLES.includes(row?.role)
    ? row.role : "field_technician") as StaffRole;
  const approvalStatus = (["approved", "suspended"].includes(row?.approval_status)
    ? row.approval_status : "pending") as ApprovalStatus;
  return {
    role,
    approvalStatus,
    features: featureMap(role, approvalStatus, row?.feature_permissions),
    configuredFeatures: featureMap(role, "approved", row?.feature_permissions),
    capabilities: {
      viewVoicemails: approvalStatus === "approved" && row?.can_view_voicemails !== false,
    },
  };
}

export async function getStaffAccess(req: Request): Promise<StaffAccess> {
  if (isOwnerIdentity(req)) {
    const status = req.ownerApprovalStatus ?? "approved";
    const enabled = status === "approved";
    return {
      role: "owner",
      approvalStatus: status,
      features: Object.fromEntries(ALL_STAFF_FEATURES.map((feature) => [feature, enabled])) as Record<StaffFeature, boolean>,
      configuredFeatures: Object.fromEntries(ALL_STAFF_FEATURES.map((feature) => [feature, true])) as Record<StaffFeature, boolean>,
      capabilities: { viewVoicemails: enabled },
    };
  }
  const userId = req.dbUser?.id;
  if (!userId) {
    return {
      role: "field_technician",
      approvalStatus: "pending",
      features: featureMap("field_technician", "pending"),
      configuredFeatures: featureMap("field_technician", "approved"),
      capabilities: { viewVoicemails: false },
    };
  }
  return accessForUserId(userId);
}

export async function canAccessFeature(req: Request, feature: StaffFeature): Promise<boolean> {
  return (await getStaffAccess(req)).features[feature];
}

export async function canViewVoicemails(req: Request): Promise<boolean> {
  return (await getStaffAccess(req)).capabilities.viewVoicemails;
}

export async function getStaffAssignmentScope(req: Request): Promise<StaffAssignmentScope> {
  const access = await getStaffAccess(req);
  const staffAdministrator = access.features.staffAdmin;
  if ((access.role === "owner" && access.approvalStatus === "approved") || staffAdministrator) {
    return { unrestricted: true, staffAdministrator, clientIds: new Set(), jobIds: new Set(), contactIds: new Set(), editableContactIds: new Set() };
  }
  if (access.approvalStatus !== "approved" || !req.dbUser?.id) {
    return { unrestricted: false, staffAdministrator: false, clientIds: new Set(), jobIds: new Set(), contactIds: new Set(), editableContactIds: new Set() };
  }
  const [clients, jobs, contacts] = await Promise.all([
    pool.query("SELECT client_id FROM staff_client_assignments WHERE user_id = $1", [req.dbUser.id]),
    pool.query("SELECT job_id FROM staff_job_assignments WHERE user_id = $1", [req.dbUser.id]),
    pool.query("SELECT contact_id, can_edit FROM staff_contact_assignments WHERE user_id = $1", [req.dbUser.id]),
  ]);
  return {
    unrestricted: false,
    staffAdministrator: false,
    clientIds: new Set(clients.rows.map((row) => Number(row.client_id))),
    jobIds: new Set(jobs.rows.map((row) => Number(row.job_id))),
    contactIds: new Set(contacts.rows.map((row) => Number(row.contact_id))),
    editableContactIds: new Set(contacts.rows.filter((row) => row.can_edit).map((row) => Number(row.contact_id))),
  };
}
export function requireStaffAdministrator(req: Request, res: Response, next: NextFunction): void {
  void canAccessFeature(req, "staffAdmin")
    .then((allowed) => {
      if (allowed) return next();
      res.status(403).json({ message: "Approved staffAdmin access required" });
    })
    .catch(next);
}

export function registerStaffAccessRoutes(
  app: Express,
  options: { isOwner?: (req: Request) => boolean } = {},
): void {
  const isOwner = options.isOwner ?? isAdminUser;
  app.get("/api/staff-access/role-features", requireStaffAdministrator, (_req, res) => {
    res.json(Object.fromEntries(
      STAFF_ROLES.map((role) => [role, roleFeatureMap(role)]),
    ));
  });

  app.get("/api/staff-access", requireStaffAdministrator, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, p.role,
          p.can_view_voicemails, p.approval_status, p.feature_permissions, p.updated_at,
          EXISTS (SELECT 1 FROM staff_access_audit oa WHERE oa.target_user_id = u.id AND oa.action = 'owner_status_updated') AS owner_status_explicit,
          EXISTS (SELECT 1 FROM staff_invites i WHERE i.accepted_by = u.id) AS invited,
          (SELECT hl.helpdesk_user_id FROM staff_helpdesk_links hl
           WHERE hl.auth_user_id = u.id) AS helpdesk_assignee_id,
          COALESCE((SELECT json_agg(client_id ORDER BY client_id) FROM staff_client_assignments ca WHERE ca.user_id = u.id), '[]') AS client_ids,
          COALESCE((SELECT json_agg(job_id ORDER BY job_id) FROM staff_job_assignments ja WHERE ja.user_id = u.id), '[]') AS job_ids,
          COALESCE((SELECT json_agg(json_build_object('contactId', contact_id, 'canEdit', can_edit) ORDER BY contact_id)
                    FROM staff_contact_assignments coa WHERE coa.user_id = u.id), '[]') AS contact_assignments
        FROM auth_users u
        LEFT JOIN staff_access_profiles p ON p.user_id = u.id
        WHERE COALESCE(NULLIF(TRIM(u.email), ''), NULLIF(TRIM(u.first_name), ''), NULLIF(TRIM(u.last_name), '')) IS NOT NULL
          AND (p.user_id IS NOT NULL OR LOWER(u.email) = ANY($1::text[]))
        ORDER BY COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), COALESCE(u.email, ''), u.id
      `, [(process.env.ADMIN_EMAILS || process.env.CSD_ADMIN_EMAIL || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean)]);
      const ownerEmails = new Set(
        (process.env.ADMIN_EMAILS || process.env.CSD_ADMIN_EMAIL || "")
          .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
      );
      const profiles = result.rows.map((row) => {
        const isOwner = Boolean(row.email && ownerEmails.has(String(row.email).toLowerCase()));
        const ownerStatus = row.owner_status_explicit
          ? row.approval_status as ApprovalStatus : "approved";
        const access = isOwner
          ? {
              role: "owner" as const,
              approvalStatus: ownerStatus,
              features: Object.fromEntries(ALL_STAFF_FEATURES.map((feature) => [feature, true])),
              effectiveFeatures: Object.fromEntries(ALL_STAFF_FEATURES.map((feature) => [feature, ownerStatus === "approved"])),
              capabilities: { viewVoicemails: ownerStatus === "approved" },
            }
          : accessSnapshotFromRow(row);
        return {
          id: row.id,
          email: row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          helpdeskAssigneeId: row.helpdesk_assignee_id,
          requiresOwnerApproval: row.invited === true,
          isOwner,
          updatedAt: row.updated_at ?? null,
          ...access,
          assignments: {
            clientIds: row.client_ids.map(Number),
            jobIds: row.job_ids.map(Number),
            contactAssignments: row.contact_assignments.map((assignment: any) => ({
              contactId: Number(assignment.contactId),
              canEdit: assignment.canEdit === true,
            })),
          },
        };
      });
      res.json(profiles);
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Could not load staff access" });
    }
  });

  app.patch("/api/staff-access/:userId/owner-status", async (req, res) => {
    if (!isOwner(req) || req.ownerApprovalStatus === "pending" || req.ownerApprovalStatus === "suspended") {
      return res.status(403).json({ message: "Active owner access required" });
    }
    const status = req.body?.approvalStatus;
    const version = req.body?.expectedUpdatedAt;
    if (!["approved", "pending", "suspended"].includes(status)
      || !Object.prototype.hasOwnProperty.call(req.body ?? {}, "expectedUpdatedAt")
      || (version !== null && (typeof version !== "string" || !Number.isFinite(Date.parse(version))))) {
      return res.status(400).json({ message: "Valid status and access version are required" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize owner changes so two concurrent suspensions cannot both
      // believe another active owner will remain.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('csd-owner-status'))");
      const target = await client.query("SELECT id, email FROM auth_users WHERE id = $1 FOR UPDATE", [req.params.userId]);
      if (!target.rows[0] || !isAdminEmail(target.rows[0].email)) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Owner account not found" });
      }
      const profile = await client.query(
        "SELECT role, approval_status, updated_at FROM staff_access_profiles WHERE user_id = $1 FOR UPDATE",
        [req.params.userId],
      );
      const currentVersion = profile.rows[0]?.updated_at ?? null;
      if (currentVersion === null ? version !== null : version === null || new Date(currentVersion).getTime() !== new Date(version).getTime()) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Owner access changed. Reload and try again." });
      }
      const explicit = await client.query(
        "SELECT 1 FROM staff_access_audit WHERE target_user_id = $1 AND action = 'owner_status_updated' LIMIT 1",
        [req.params.userId],
      );
      const previousStatus = explicit.rows[0] ? profile.rows[0]?.approval_status : "approved";
      if (status !== "approved") {
        const configured = (process.env.ADMIN_EMAILS || process.env.CSD_ADMIN_EMAIL || "")
          .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
        const active = await client.query(
          `SELECT COUNT(DISTINCT LOWER(u.email))::int AS count FROM auth_users u
           WHERE LOWER(u.email) = ANY($1::text[])
             AND LOWER(u.email) <> $2
             AND NOT EXISTS (
               SELECT 1 FROM staff_access_audit a
               JOIN staff_access_profiles p ON p.user_id = a.target_user_id
               JOIN auth_users other ON other.id = a.target_user_id
               WHERE LOWER(other.email) = LOWER(u.email) AND a.action = 'owner_status_updated'
                 AND p.approval_status <> 'approved'
             )`,
          [configured, String(target.rows[0].email).trim().toLowerCase()],
        );
        if (active.rows[0].count < 1) {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: "The last active owner cannot be set pending or suspended." });
        }
      }
      const result = await client.query(
        `INSERT INTO staff_access_profiles (user_id, role, approval_status, updated_at)
         VALUES ($1, 'administrator', $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET approval_status = EXCLUDED.approval_status,
           updated_at = GREATEST(NOW(), staff_access_profiles.updated_at + INTERVAL '1 millisecond')
         RETURNING updated_at`,
        [req.params.userId, status],
      );
      await client.query(
        `INSERT INTO staff_access_audit (target_user_id, actor_user_id, action, previous_access, new_access)
         VALUES ($1, $2, 'owner_status_updated', $3::jsonb, $4::jsonb)`,
        [req.params.userId, req.dbUser?.id ?? null,
          JSON.stringify({ approval_status: previousStatus }),
          JSON.stringify({ approval_status: status })],
      );
      await client.query("COMMIT");
      // Status changes affect already-issued radio credentials as well as HTTP
      // requests. Revoke on reapproval too so only fresh sessions can resume.
      const { revokePttUserSessions } = await import("./ptt");
      revokePttUserSessions(req.params.userId, String(target.rows[0].email));
      return res.json({ id: req.params.userId, approvalStatus: status, updatedAt: result.rows[0].updated_at });
    } catch {
      await client.query("ROLLBACK");
      return res.status(500).json({ message: "Could not update owner status" });
    } finally {
      client.release();
    }
  });

  app.patch("/api/staff-access/:userId/identity", requireStaffAdministrator, async (req, res) => {
    const normalizeName = (value: unknown) => typeof value === "string" ? value.trim() : null;
    const firstName = normalizeName(req.body?.firstName);
    const lastName = normalizeName(req.body?.lastName);
    if (firstName === null || lastName === null) {
      return res.status(400).json({ message: "First and last name are required fields" });
    }
    if (!firstName && !lastName) {
      return res.status(400).json({ message: "Enter at least a first or last name" });
    }
    if (firstName.length > 100 || lastName.length > 100) {
      return res.status(400).json({ message: "Staff names must be 100 characters or fewer" });
    }

    try {
      const result = await pool.query(
        `UPDATE auth_users
         SET first_name = $2, last_name = $3, updated_at = NOW()
         WHERE LOWER(id) = LOWER($1::text)
         RETURNING id, email, first_name, last_name`,
        [req.params.userId, firstName || null, lastName || null],
      );
      if (!result.rows[0]) {
        return res.status(404).json({ message: "Staff user not found" });
      }
      const row = result.rows[0];
      return res.json({
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
      });
    } catch (error: any) {
      return res.status(500).json({ message: error?.message || "Could not update staff name" });
    }
  });

  app.patch("/api/staff-access/:userId", requireStaffAdministrator, async (req, res) => {
    const role = req.body?.role;
    const approvalStatus = req.body?.approvalStatus;
    const viewVoicemails = req.body?.capabilities?.viewVoicemails;
    const requestedPermissions = req.body?.features;
    const expectedUpdatedAt = req.body?.expectedUpdatedAt;
    if (!STAFF_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid staff role" });
    }
    if (!["pending", "approved", "suspended"].includes(approvalStatus)) {
      return res.status(400).json({ message: "Invalid approval status" });
    }
    if (typeof viewVoicemails !== "boolean") {
      return res.status(400).json({ message: "Voicemail access must be on or off" });
    }
    if (!requestedPermissions || typeof requestedPermissions !== "object" || Array.isArray(requestedPermissions)) {
      return res.status(400).json({ message: "Feature permissions are required" });
    }
    if (!ALL_STAFF_FEATURES.every((feature) => typeof requestedPermissions[feature] === "boolean")) {
      return res.status(400).json({ message: "Every feature permission must be explicitly on or off" });
    }
    if (
      !Object.prototype.hasOwnProperty.call(req.body ?? {}, "expectedUpdatedAt") ||
      (expectedUpdatedAt !== null && (
        typeof expectedUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(expectedUpdatedAt))
      ))
    ) {
      return res.status(400).json({ message: "Expected access version is required" });
    }
    const permissions = Object.fromEntries(
      ALL_STAFF_FEATURES
        .filter((feature) => feature !== "billing")
        .filter((feature) => typeof requestedPermissions[feature] === "boolean")
        .map((feature) => [feature, requestedPermissions[feature]]),
    );
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query(
          "SELECT id, email FROM auth_users WHERE LOWER(id) = LOWER($1::text) FOR UPDATE",
          [req.params.userId],
        );
        if (!target.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Staff user not found" });
        }
        if (isAdminEmail(target.rows[0].email)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Owner access cannot be modified" });
        }
        const previous = await client.query(
          `SELECT role, can_view_voicemails, approval_status, feature_permissions, updated_at
           FROM staff_access_profiles WHERE user_id = $1 FOR UPDATE`,
          [target.rows[0].id],
        );
        if (!previous.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            message: "Staff enrollment requires an accepted owner-issued invitation. Invite this person first.",
          });
        }
        if (approvalStatus === "approved" && previous.rows[0]?.approval_status !== "approved" && !isOwner(req)) {
          const invited = await client.query(
            "SELECT 1 FROM staff_invites WHERE accepted_by = $1 LIMIT 1",
            [target.rows[0].id],
          );
          if (invited.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Only the owner can approve an invited staff account" });
          }
        }
        const currentUpdatedAt = previous.rows[0]?.updated_at;
        const versionMatches = currentUpdatedAt
          ? expectedUpdatedAt !== null &&
            new Date(currentUpdatedAt).getTime() === new Date(expectedUpdatedAt).getTime()
          : expectedUpdatedAt === null;
        if (!versionMatches) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "This staff member's access changed since you loaded it. Review the latest settings and try again.",
            latestAccess: accessSnapshotFromRow(previous.rows[0]),
          });
        }
        const result = await client.query(
          `INSERT INTO staff_access_profiles
           (user_id, role, can_view_voicemails, approval_status, feature_permissions,
            approved_at, approved_by, updated_at)
         SELECT id::varchar, $2::varchar, $3::boolean, $4::varchar, $5::jsonb,
            CASE WHEN $4::varchar = 'approved' THEN NOW() ELSE NULL END,
            CASE WHEN $4::varchar = 'approved' THEN $6::varchar ELSE NULL END, NOW()
         FROM auth_users WHERE id = $1::text
         ON CONFLICT (user_id) DO UPDATE SET
           role=EXCLUDED.role, can_view_voicemails=EXCLUDED.can_view_voicemails,
           approval_status=EXCLUDED.approval_status,
           feature_permissions=EXCLUDED.feature_permissions,
           approved_at=EXCLUDED.approved_at, approved_by=EXCLUDED.approved_by,
           updated_at=GREATEST(NOW(), staff_access_profiles.updated_at + INTERVAL '1 millisecond')
         RETURNING user_id, role, can_view_voicemails, approval_status, feature_permissions, updated_at`,
          [target.rows[0].id, role, viewVoicemails, approvalStatus, JSON.stringify(permissions), req.dbUser?.id ?? null],
        );
        if (!result.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Staff user not found" });
        }
        const row = result.rows[0];
        const previousAccess = previous.rows[0]
          ? {
              role: previous.rows[0].role,
              can_view_voicemails: previous.rows[0].can_view_voicemails,
              approval_status: previous.rows[0].approval_status,
              feature_permissions: previous.rows[0].feature_permissions,
            }
          : {};
        await client.query(
          `INSERT INTO staff_access_audit
             (target_user_id, actor_user_id, previous_access, new_access)
           VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
          [
            row.user_id,
            req.dbUser?.id ?? null,
            JSON.stringify(previousAccess),
            JSON.stringify({
              role: row.role,
              can_view_voicemails: row.can_view_voicemails,
              approval_status: row.approval_status,
              feature_permissions: row.feature_permissions,
            }),
          ],
        );
        await client.query("COMMIT");
        if (approvalStatus !== "approved" || !featureMap(role, approvalStatus, permissions).communications) {
          const { revokePttUserSessions } = await import("./ptt");
          revokePttUserSessions(row.user_id);
        }
        res.json({
          id: row.user_id,
          role: row.role,
          approvalStatus: row.approval_status,
          features: featureMap(row.role, "approved", row.feature_permissions),
          effectiveFeatures: featureMap(row.role, row.approval_status, row.feature_permissions),
          capabilities: { viewVoicemails: row.approval_status === "approved" && row.can_view_voicemails },
          updatedAt: row.updated_at,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Could not update staff access" });
    }
  });

  app.put("/api/staff-access/:userId/assignments", requireStaffAdministrator, async (req, res) => {
    const clientIds = Array.isArray(req.body?.clientIds) ? req.body.clientIds : null;
    const jobIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds : null;
    const contactAssignments = Array.isArray(req.body?.contactAssignments) ? req.body.contactAssignments : null;
    const expectedUpdatedAt = req.body?.expectedUpdatedAt;
    const validIds = (values: unknown[] | null) => values !== null &&
      values.every((value) => Number.isSafeInteger(value) && Number(value) > 0) &&
      new Set(values).size === values.length;
    if (!validIds(clientIds) || !validIds(jobIds)) {
      return res.status(400).json({ message: "Assignments must contain unique positive numeric ids" });
    }
    if (contactAssignments !== null && (
      !contactAssignments.every((assignment: any) =>
        assignment && Number.isSafeInteger(assignment.contactId) && assignment.contactId > 0 && typeof assignment.canEdit === "boolean") ||
      new Set(contactAssignments.map((assignment: any) => assignment.contactId)).size !== contactAssignments.length
    )) {
      return res.status(400).json({ message: "Contact assignments must contain unique contacts and an explicit edit permission" });
    }
    if (
      !Object.prototype.hasOwnProperty.call(req.body ?? {}, "expectedUpdatedAt") ||
      (expectedUpdatedAt !== null && (
        typeof expectedUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(expectedUpdatedAt))
      ))
    ) {
      return res.status(400).json({ message: "Expected assignment version is required" });
    }
    const normalizedClients = clientIds as number[];
    const normalizedJobs = jobIds as number[];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query("SELECT id, email FROM auth_users WHERE id = $1 FOR UPDATE", [req.params.userId]);
      if (!target.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Staff user not found" });
      }
      if (isAdminEmail(target.rows[0].email)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Owner assignments cannot be modified" });
      }
      const previousProfile = await client.query(
        `SELECT role, can_view_voicemails, approval_status, feature_permissions, updated_at
         FROM staff_access_profiles WHERE user_id=$1 FOR UPDATE`,
        [target.rows[0].id],
      );
      if (!previousProfile.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          message: "Staff enrollment requires an accepted owner-issued invitation. Invite this person before assigning records.",
        });
      }
      const currentUpdatedAt = previousProfile.rows[0]?.updated_at;
      const [existingClients, existingJobs, existingContacts] = await Promise.all([
        client.query("SELECT client_id FROM staff_client_assignments WHERE user_id=$1 ORDER BY client_id FOR UPDATE", [target.rows[0].id]),
        client.query("SELECT job_id FROM staff_job_assignments WHERE user_id=$1 ORDER BY job_id FOR UPDATE", [target.rows[0].id]),
        client.query("SELECT contact_id, can_edit FROM staff_contact_assignments WHERE user_id=$1 ORDER BY contact_id FOR UPDATE", [target.rows[0].id]),
      ]);
      const normalizedContacts = (contactAssignments === null
        ? existingContacts.rows.map((row) => ({ contactId: Number(row.contact_id), canEdit: row.can_edit === true }))
        : contactAssignments.map((assignment: any) => ({ contactId: Number(assignment.contactId), canEdit: assignment.canEdit === true }))
      ) as Array<{ contactId: number; canEdit: boolean }>;
      const versionMatches = currentUpdatedAt
        ? expectedUpdatedAt !== null &&
          new Date(currentUpdatedAt).getTime() === new Date(expectedUpdatedAt).getTime()
        : expectedUpdatedAt === null;
      if (!versionMatches) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "This staff member's assignments changed since you loaded them. Review the latest assignments and try again.",
          latestAccess: {
            ...accessSnapshotFromRow(previousProfile.rows[0]),
            assignments: {
              clientIds: existingClients.rows.map((row) => Number(row.client_id)),
              jobIds: existingJobs.rows.map((row) => Number(row.job_id)),
              contactAssignments: existingContacts.rows.map((row) => ({
                contactId: Number(row.contact_id),
                canEdit: row.can_edit === true,
              })),
            },
          },
        });
      }
      if (normalizedClients.length) {
        const count = await client.query("SELECT COUNT(*)::int count FROM clients WHERE id = ANY($1::int[])", [normalizedClients]);
        if (count.rows[0].count !== normalizedClients.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "One or more customers do not exist" });
        }
      }
      if (normalizedJobs.length) {
        const count = await client.query("SELECT COUNT(*)::int count FROM crm_jobs WHERE id = ANY($1::int[])", [normalizedJobs]);
        if (count.rows[0].count !== normalizedJobs.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "One or more jobs do not exist" });
        }
      }
      if (normalizedContacts.length) {
        const ids = normalizedContacts.map((assignment) => assignment.contactId);
        const count = await client.query("SELECT COUNT(*)::int count FROM crm_contacts WHERE id = ANY($1::int[])", [ids]);
        if (count.rows[0].count !== ids.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "One or more contacts do not exist" });
        }
      }
      await client.query("DELETE FROM staff_client_assignments WHERE user_id=$1", [target.rows[0].id]);
      await client.query("DELETE FROM staff_job_assignments WHERE user_id=$1", [target.rows[0].id]);
      await client.query("DELETE FROM staff_contact_assignments WHERE user_id=$1", [target.rows[0].id]);
      for (const id of normalizedClients) {
        await client.query("INSERT INTO staff_client_assignments(user_id,client_id,assigned_by) VALUES($1,$2,$3)", [target.rows[0].id, id, req.dbUser?.id ?? null]);
      }
      for (const id of normalizedJobs) {
        await client.query("INSERT INTO staff_job_assignments(user_id,job_id,assigned_by) VALUES($1,$2,$3)", [target.rows[0].id, id, req.dbUser?.id ?? null]);
      }
      for (const assignment of normalizedContacts) {
        await client.query(
          "INSERT INTO staff_contact_assignments(user_id,contact_id,can_edit,assigned_by) VALUES($1,$2,$3,$4)",
          [target.rows[0].id, assignment.contactId, assignment.canEdit, req.dbUser?.id ?? null],
        );
      }
      const previousAccess = {
        clientIds: existingClients.rows.map((row) => Number(row.client_id)),
        jobIds: existingJobs.rows.map((row) => Number(row.job_id)),
        contactAssignments: existingContacts.rows.map((row) => ({
          contactId: Number(row.contact_id),
          canEdit: row.can_edit === true,
        })),
      };
      const newAccess = {
        clientIds: normalizedClients.slice().sort((a, b) => a - b),
        jobIds: normalizedJobs.slice().sort((a, b) => a - b),
        contactAssignments: normalizedContacts.slice().sort((a, b) => a.contactId - b.contactId),
      };
      const updatedProfile = await client.query(
        `INSERT INTO staff_access_profiles (user_id, role, can_view_voicemails, approval_status)
         SELECT id, 'field_technician', TRUE, 'pending'
         FROM auth_users WHERE id=$1
         ON CONFLICT (user_id) DO UPDATE SET
           updated_at=GREATEST(NOW(), staff_access_profiles.updated_at + INTERVAL '1 millisecond')
         RETURNING updated_at`,
        [target.rows[0].id],
      );
      await client.query(
        `INSERT INTO staff_access_audit(target_user_id,actor_user_id,action,previous_access,new_access)
         VALUES($1,$2,'assignments_updated',$3::jsonb,$4::jsonb)`,
        [target.rows[0].id, req.dbUser?.id ?? null, JSON.stringify(previousAccess), JSON.stringify(newAccess)],
      );
      await client.query("COMMIT");
      return res.json({ ...newAccess, updatedAt: updatedProfile.rows[0]?.updated_at ?? null });
    } catch (error: any) {
      await client.query("ROLLBACK");
      return res.status(500).json({ message: error?.message || "Could not update staff assignments" });
    } finally {
      client.release();
    }
  });

  app.post("/api/staff-access/:userId/recovery-audit", requireStaffAdministrator, async (req, res) => {
    const outcome = req.body?.outcome;
    if (outcome !== "succeeded" && outcome !== "failed") {
      return res.status(400).json({ message: "Recovery outcome must be succeeded or failed" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(
        "SELECT id, email, first_name, last_name FROM auth_users WHERE id = $1 FOR UPDATE",
        [req.params.userId],
      );
      if (!target.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Staff user not found" });
      }

      await client.query(
        `INSERT INTO staff_access_audit
           (target_user_id, actor_user_id, action, previous_access, new_access)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [
          target.rows[0].id,
          req.dbUser?.id ?? null,
          `conflict_recovery_${outcome}`,
          JSON.stringify({ recovery: "conflict" }),
          JSON.stringify({ outcome }),
        ],
      );

      if (outcome === "failed") {
        const failureCountResult = await client.query(
          `SELECT COUNT(*)::int AS count
           FROM staff_access_audit
           WHERE target_user_id = $1
             AND action = 'conflict_recovery_failed'
             AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')`,
          [target.rows[0].id, STAFF_ACCESS_RECOVERY_FAILURE_WINDOW_MINUTES],
        );
        const failureCount = Number(failureCountResult.rows[0]?.count ?? 0);

        if (failureCount >= STAFF_ACCESS_RECOVERY_FAILURE_THRESHOLD) {
          const staffMember = [target.rows[0].first_name, target.rows[0].last_name]
            .filter((part): part is string => Boolean(part))
            .join(" ") || target.rows[0].email || "Unknown staff member";
          const alertTargetMarker = JSON.stringify([`staff-access-recovery:${target.rows[0].id}`]);
          const alertTitle = "Repeated staff access recovery failures";
          const alertDescription =
            `Conflict recovery has failed ${failureCount} times for ${staffMember} ` +
            `in the last ${STAFF_ACCESS_RECOVERY_FAILURE_WINDOW_MINUTES} minutes. ` +
            "Review the Staff Access page before trying again.";
          const existingAlert = await client.query(
            `SELECT id
             FROM alerts
             WHERE alert_source = $1
               AND status = 'active'
               AND affected_services = $2
             FOR UPDATE`,
            [STAFF_ACCESS_RECOVERY_ALERT_SOURCE, alertTargetMarker],
          );

          if (existingAlert.rows[0]) {
            await client.query(
              `UPDATE alerts
               SET title = $1, description = $2, severity = 'high',
                   category = 'security', resolved_at = NULL
               WHERE id = $3`,
              [alertTitle, alertDescription, existingAlert.rows[0].id],
            );
          } else {
            await client.query(
              `INSERT INTO alerts
                 (title, description, severity, category, status, alert_source, affected_services)
               VALUES ($1, $2, 'high', 'security', 'active', $3, $4)`,
              [alertTitle, alertDescription, STAFF_ACCESS_RECOVERY_ALERT_SOURCE, alertTargetMarker],
            );
          }
        }
      }

      await client.query("COMMIT");
      return res.status(204).end();
    } catch (error: any) {
      await client.query("ROLLBACK");
      console.error("Could not record staff access recovery outcome:", error?.message || error);
      return res.status(500).json({ message: "Could not record recovery outcome" });
    } finally {
      client.release();
    }
  });

  app.get("/api/staff-access/audit", requireStaffAdministrator, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT a.id, a.action, a.previous_access, a.new_access, a.created_at,
          target.email AS target_email, actor.email AS actor_email
        FROM staff_access_audit a
        JOIN auth_users target ON target.id = a.target_user_id
        LEFT JOIN auth_users actor ON actor.id = a.actor_user_id
        ORDER BY a.created_at DESC
        LIMIT 200
      `);
      res.json(result.rows.map((row) => ({
        id: String(row.id),
        action: row.action,
        previousAccess: row.previous_access,
        newAccess: row.new_access,
        createdAt: row.created_at,
        targetEmail: row.target_email,
        actorEmail: row.actor_email,
      })));
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Could not load access audit" });
    }
  });
}

export async function canAccessAssignedClient(req: Request, clientId: number | null | undefined): Promise<boolean> {
  const scope = await getStaffAssignmentScope(req);
  return scope.unrestricted || (clientId != null && scope.clientIds.has(clientId));
}

export async function enforceAssignedResourceBoundary(req: Request, res: Response, next: NextFunction): Promise<void> {
  const path = req.path.toLowerCase();
  if (
    path === "/api/tickets/open" ||
    path === "/api/crm/jobs/stats/summary" ||
    /^\/api\/service-logs\/(?:job|contact)\/[^/]+(?:\/|$)/.test(path)
  ) {
    next();
    return;
  }
  const checks: Array<[RegExp, (id: number) => Promise<boolean>]> = [
    [/^\/api\/clients\/([^/]+)(?:\/|$)/, (id) => canAccessAssignedClient(req, id)],
    [/^\/api\/devices\/([^/]+)(?:\/|$)/, (id) => canAccessAssignedDevice(req, id)],
    [/^\/api\/tickets\/([^/]+)(?:\/|$)/, (id) => canAccessAssignedTicket(req, id)],
    [/^\/api\/crm\/jobs\/([^/]+)(?:\/|$)/, (id) => canAccessAssignedJob(req, id)],
    [/^\/api\/service-logs\/([^/]+)(?:\/|$)/, (id) => canAccessAssignedServiceLog(req, id)],
  ];
  for (const [pattern, allowed] of checks) {
    const match = pattern.exec(path);
    if (!match) continue;
    let segment = match[1];
    try {
      segment = decodeURIComponent(segment);
    } catch {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (!/^[1-9]\d*$/.test(segment)) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (await allowed(Number(segment))) {
      next();
      return;
    }
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  next();
}

export async function canAccessAssignedDevice(req: Request, deviceId: number): Promise<boolean> {
  const result = await pool.query("SELECT client_id FROM devices WHERE id=$1", [deviceId]);
  return result.rows[0] ? canAccessAssignedClient(req, result.rows[0].client_id) : false;
}

async function canAccessAssignedServiceLog(req: Request, logId: number): Promise<boolean> {
  const scope = await getStaffAssignmentScope(req);
  if (scope.unrestricted) return true;
  const result = await pool.query("SELECT contact_id,job_id FROM service_logs WHERE id=$1", [logId]);
  const log = result.rows[0];
  if (!log) return false;
  if (log.job_id != null && await canAccessAssignedJob(req, Number(log.job_id))) return true;
  if (log.contact_id != null) {
    const contact = await pool.query("SELECT client_id FROM crm_contacts WHERE id=$1", [log.contact_id]);
    if (contact.rows[0] && await canAccessAssignedClient(req, contact.rows[0].client_id)) return true;
  }
  return false;
}

async function canAccessAssignedTicket(req: Request, ticketId: number): Promise<boolean> {
  const result = await pool.query("SELECT client_id FROM tickets WHERE id=$1", [ticketId]);
  return result.rows[0] ? canAccessAssignedClient(req, result.rows[0].client_id) : false;
}

async function canAccessAssignedJob(req: Request, jobId: number): Promise<boolean> {
  const scope = await getStaffAssignmentScope(req);
  if (scope.unrestricted || scope.jobIds.has(jobId)) return true;
  const result = await pool.query(
    `SELECT c.client_id FROM crm_jobs j LEFT JOIN crm_contacts c ON c.id=j.contact_id WHERE j.id=$1`,
    [jobId],
  );
  return result.rows[0] ? canAccessAssignedClient(req, result.rows[0].client_id) : false;
}
