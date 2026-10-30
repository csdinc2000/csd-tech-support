import type { Express, Request, Response } from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { storage } from "../storage";
import { z } from "zod";
import {
  insertTicketDepartmentSchema,
  insertTicketTeamSchema,
  insertTicketTeamMemberSchema,
  insertTicketHelpTopicSchema,
  insertSlaPlanSchema,
  insertTicketMessageSchema,
  insertTicketActivitySchema,
  insertCannedResponseSchema,
  insertEmailTemplateSchema,
  insertTicketFilterSchema,
  insertTicketSettingsSchema,
  type Ticket,
  type TicketFilter,
} from "@shared/schema";
import {
  sendAutoresponder,
  sendStaffNotice,
  sendAssignmentNotice,
  sendReplyNotice,
  sendOverdueAlert,
  sendResolvedNotice,
} from "../helpdesk-email";

const ATTACHMENT_DIR = process.env.HELPDESK_ATTACHMENT_DIR || path.resolve(process.cwd(), "helpdesk-attachments");
try { fs.mkdirSync(ATTACHMENT_DIR, { recursive: true }); } catch {}

export function generateAccessToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Enrich a freshly-submitted ticket: ticket number, access token, default
 * department/SLA, filter routing, SLA due date, autoresponder, staff notice,
 * initial system activity log, and a seed message containing the description.
 */
export async function enrichNewTicket(
  ticket: Ticket,
  opts: { suppressAutoresponder?: boolean } = {},
): Promise<Ticket> {
  const settings = await storage.getTicketSettings();
  const prefix = settings?.ticketNumberPrefix || "CSD";
  const patch: Partial<Ticket> = {};

  if (!ticket.ticketNumber) {
    patch.ticketNumber = await storage.getNextTicketNumber(prefix);
  }
  if (!ticket.accessToken) {
    patch.accessToken = generateAccessToken();
  }

  if (!ticket.departmentId) {
    const defaultDeptId = settings?.defaultDepartmentId;
    const dept = defaultDeptId
      ? await storage.getTicketDepartment(defaultDeptId)
      : await storage.getDefaultTicketDepartment();
    if (dept) patch.departmentId = dept.id;
  }

  // Help-topic auto-routing
  if (ticket.helpTopicId) {
    const topic = await storage.getTicketHelpTopic(ticket.helpTopicId);
    if (topic) {
      if (!ticket.departmentId && topic.departmentId) patch.departmentId = topic.departmentId;
      if (!ticket.slaPlanId && topic.slaPlanId) patch.slaPlanId = topic.slaPlanId;
      if (!ticket.assignedTo && topic.autoAssignUserId) patch.assignedTo = topic.autoAssignUserId;
      if (!ticket.teamId && topic.autoAssignTeamId) patch.teamId = topic.autoAssignTeamId;
      if (topic.priority && !ticket.priority) patch.priority = topic.priority;
    }
  }

  // Default SLA plan from settings if still unset
  if (!ticket.slaPlanId && !patch.slaPlanId && settings?.defaultSlaPlanId) {
    patch.slaPlanId = settings.defaultSlaPlanId;
  }

  // Apply filters
  const filters = (await storage.getTicketFilters()).filter((f) => f.isActive);
  for (const f of filters) {
    const merged = { ...ticket, ...patch };
    if (filterMatches(f, merged)) {
      applyFilterActions(f, patch);
      const actions = (f.actions || {}) as any;
      if (actions.stopProcessing) break;
    }
  }

  // Compute SLA due date
  const finalSlaId = patch.slaPlanId ?? ticket.slaPlanId;
  if (finalSlaId) {
    const sla = await storage.getSlaPlan(finalSlaId);
    if (sla) {
      const created = ticket.createdAt ? new Date(ticket.createdAt) : new Date();
      patch.slaDueAt = new Date(created.getTime() + sla.resolveTimeMinutes * 60_000);
      if (!patch.dueAt && !ticket.dueAt) patch.dueAt = patch.slaDueAt;
    }
  }

  // Persist enrichments
  const enriched = Object.keys(patch).length
    ? await storage.updateTicket(ticket.id, patch)
    : ticket;
  const finalTicket = enriched || ticket;

  // Seed initial message containing the description so the thread reflects intake
  if (finalTicket.description) {
    await storage.createTicketMessage({
      ticketId: finalTicket.id,
      authorType: finalTicket.requesterEmail ? "customer" : "system",
      authorName: finalTicket.requesterName || "System",
      authorEmail: finalTicket.requesterEmail || null,
      body: finalTicket.description,
      isInternal: false,
    });
  }

  // Activity log
  await storage.createTicketActivity({
    ticketId: finalTicket.id,
    actorType: "system",
    actorName: "System",
    action: "created",
    details: JSON.stringify({ source: finalTicket.source, ticketNumber: finalTicket.ticketNumber }),
  });

  // Autoresponder + staff notice (fire-and-forget). The autoresponder can be
  // suppressed by callers that send their own customer acknowledgement (e.g.
  // the intake form's confirmation email) so the customer gets exactly one.
  if (!opts.suppressAutoresponder) void sendAutoresponder(finalTicket);
  void sendStaffNotice(finalTicket);

  return finalTicket;
}

function filterMatches(f: TicketFilter, t: Ticket): boolean {
  const conds = (f.conditions || []) as Array<{ field: string; op: string; value: string }>;
  if (!conds.length) return false;
  const test = (c: { field: string; op: string; value: string }) => {
    const v = (t as any)[c.field];
    const sv = v == null ? "" : String(v).toLowerCase();
    const cv = (c.value ?? "").toLowerCase();
    switch (c.op) {
      case "equals":
        return sv === cv;
      case "not_equals":
        return sv !== cv;
      case "contains":
        return sv.includes(cv);
      case "starts_with":
        return sv.startsWith(cv);
      case "ends_with":
        return sv.endsWith(cv);
      case "is_empty":
        return sv === "";
      case "is_not_empty":
        return sv !== "";
      default:
        return false;
    }
  };
  return f.matchType === "any" ? conds.some(test) : conds.every(test);
}

function applyFilterActions(f: TicketFilter, patch: Partial<Ticket>) {
  const a = (f.actions || {}) as any;
  if (a.assignToUserId != null && patch.assignedTo == null) patch.assignedTo = a.assignToUserId;
  if (a.assignToTeamId != null && patch.teamId == null) patch.teamId = a.assignToTeamId;
  if (a.setPriority) patch.priority = a.setPriority;
  if (a.setDepartmentId != null) patch.departmentId = a.setDepartmentId;
  if (a.setHelpTopicId != null && patch.helpTopicId == null) patch.helpTopicId = a.setHelpTopicId;
  if (a.setStatus) patch.status = a.setStatus;
}

// ---------- session-user helper ----------
function sessionUserId(req: Request): number | null {
  const u: any = (req as any).user;
  if (!u) return null;
  if (typeof u.id === "number") return u.id;
  if (typeof u.claims?.sub === "string") {
    const n = parseInt(u.claims.sub, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sessionUserName(req: Request): string {
  const u: any = (req as any).user;
  return u?.username || u?.claims?.email || u?.claims?.name || "staff";
}

// ---------- public customer portal schemas ----------
const portalNewTicketSchema = z.object({
  requesterName: z.string().min(1),
  requesterEmail: z.string().email(),
  requesterPhone: z.string().optional(),
  subject: z.string().min(1),
  description: z.string().min(1),
  helpTopicId: z.number().optional(),
  priority: z.string().optional(),
});

const portalLookupSchema = z.object({
  email: z.string().email(),
  ticketNumber: z.string().min(1),
  accessToken: z.string().min(8).optional(),
});

const portalReplySchema = z.object({
  email: z.string().email(),
  ticketNumber: z.string().min(1),
  accessToken: z.string().min(8),
  body: z.string().min(1),
});

// ---------- routes ----------
export function registerHelpdeskRoutes(app: Express) {
  // ====== DEPARTMENTS ======
  app.get("/api/helpdesk/departments", async (_req, res) => {
    res.json(await storage.getTicketDepartments());
  });
  app.post("/api/helpdesk/departments", async (req, res) => {
    try {
      const data = insertTicketDepartmentSchema.parse(req.body);
      res.status(201).json(await storage.createTicketDepartment(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/departments/:id", async (req, res) => {
    const row = await storage.updateTicketDepartment(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/departments/:id", async (req, res) => {
    const ok = await storage.deleteTicketDepartment(parseInt(req.params.id));
    res.json({ ok });
  });

  // ====== TEAMS ======
  app.get("/api/helpdesk/teams", async (_req, res) => res.json(await storage.getTicketTeams()));
  app.post("/api/helpdesk/teams", async (req, res) => {
    try {
      const data = insertTicketTeamSchema.parse(req.body);
      res.status(201).json(await storage.createTicketTeam(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/teams/:id", async (req, res) => {
    const row = await storage.updateTicketTeam(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/teams/:id", async (req, res) => {
    res.json({ ok: await storage.deleteTicketTeam(parseInt(req.params.id)) });
  });
  app.get("/api/helpdesk/teams/:id/members", async (req, res) => {
    res.json(await storage.getTicketTeamMembers(parseInt(req.params.id)));
  });
  app.post("/api/helpdesk/teams/:id/members", async (req, res) => {
    try {
      const data = insertTicketTeamMemberSchema.parse({
        ...req.body,
        teamId: parseInt(req.params.id),
      });
      res.status(201).json(await storage.addTicketTeamMember(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.delete("/api/helpdesk/teams/:teamId/members/:userId", async (req, res) => {
    const ok = await storage.removeTicketTeamMember(
      parseInt(req.params.teamId),
      parseInt(req.params.userId),
    );
    res.json({ ok });
  });

  // ====== HELP TOPICS ======
  app.get("/api/helpdesk/help-topics", async (_req, res) => res.json(await storage.getTicketHelpTopics()));
  app.post("/api/helpdesk/help-topics", async (req, res) => {
    try {
      const data = insertTicketHelpTopicSchema.parse(req.body);
      res.status(201).json(await storage.createTicketHelpTopic(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/help-topics/:id", async (req, res) => {
    const row = await storage.updateTicketHelpTopic(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/help-topics/:id", async (req, res) => {
    res.json({ ok: await storage.deleteTicketHelpTopic(parseInt(req.params.id)) });
  });

  // ====== SLA PLANS ======
  app.get("/api/helpdesk/sla-plans", async (_req, res) => res.json(await storage.getSlaPlans()));
  app.post("/api/helpdesk/sla-plans", async (req, res) => {
    try {
      const data = insertSlaPlanSchema.parse(req.body);
      res.status(201).json(await storage.createSlaPlan(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/sla-plans/:id", async (req, res) => {
    const row = await storage.updateSlaPlan(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/sla-plans/:id", async (req, res) => {
    res.json({ ok: await storage.deleteSlaPlan(parseInt(req.params.id)) });
  });

  // ====== CANNED RESPONSES ======
  app.get("/api/helpdesk/canned-responses", async (_req, res) => res.json(await storage.getCannedResponses()));
  app.post("/api/helpdesk/canned-responses", async (req, res) => {
    try {
      const data = insertCannedResponseSchema.parse(req.body);
      res.status(201).json(await storage.createCannedResponse(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/canned-responses/:id", async (req, res) => {
    const row = await storage.updateCannedResponse(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/canned-responses/:id", async (req, res) => {
    res.json({ ok: await storage.deleteCannedResponse(parseInt(req.params.id)) });
  });

  // ====== EMAIL TEMPLATES ======
  app.get("/api/helpdesk/email-templates", async (_req, res) => res.json(await storage.getEmailTemplates()));
  app.post("/api/helpdesk/email-templates", async (req, res) => {
    try {
      const data = insertEmailTemplateSchema.parse(req.body);
      res.status(201).json(await storage.createEmailTemplate(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/email-templates/:id", async (req, res) => {
    const row = await storage.updateEmailTemplate(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/email-templates/:id", async (req, res) => {
    res.json({ ok: await storage.deleteEmailTemplate(parseInt(req.params.id)) });
  });

  // ====== FILTERS ======
  app.get("/api/helpdesk/filters", async (_req, res) => res.json(await storage.getTicketFilters()));
  app.post("/api/helpdesk/filters", async (req, res) => {
    try {
      const data = insertTicketFilterSchema.parse(req.body);
      res.status(201).json(await storage.createTicketFilter(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.put("/api/helpdesk/filters/:id", async (req, res) => {
    const row = await storage.updateTicketFilter(parseInt(req.params.id), req.body);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/helpdesk/filters/:id", async (req, res) => {
    res.json({ ok: await storage.deleteTicketFilter(parseInt(req.params.id)) });
  });

  // ====== SETTINGS ======
  app.get("/api/helpdesk/settings", async (_req, res) => {
    const settings = await storage.getTicketSettings();
    res.json(settings || null);
  });
  app.put("/api/helpdesk/settings", async (req, res) => {
    try {
      const data = insertTicketSettingsSchema.partial().parse(req.body);
      res.json(await storage.updateTicketSettings(data));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });

  // ====== TICKET SUB-RESOURCES (auth — assumes /api/tickets is authenticated) ======
  // Messages (replies + internal notes interleaved)
  app.get("/api/tickets/:id/messages", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    res.json(await storage.getTicketMessages(ticketId, { includeInternal: true }));
  });
  app.post("/api/tickets/:id/messages", async (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const ticket = await storage.getTicket(ticketId);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      const uid = sessionUserId(req);
      const data = insertTicketMessageSchema.parse({
        ...req.body,
        ticketId,
        authorType: req.body.authorType || "staff",
        authorId: req.body.authorId ?? uid,
        authorName: req.body.authorName || sessionUserName(req),
      });
      const msg = await storage.createTicketMessage(data);

      // Update first_response_at on first staff public reply
      if (!ticket.firstResponseAt && data.authorType === "staff" && !data.isInternal) {
        await storage.updateTicket(ticketId, { firstResponseAt: new Date() });
      }
      // Activity
      await storage.createTicketActivity({
        ticketId,
        actorType: data.authorType,
        actorId: data.authorId ?? null,
        actorName: data.authorName || null,
        action: data.isInternal ? "note" : "reply",
        details: data.body.length > 200 ? data.body.slice(0, 200) + "…" : data.body,
      });
      // Notify customer of public staff replies
      if (data.authorType === "staff" && !data.isInternal) {
        void sendReplyNotice(ticket, data.body);
      }
      res.status(201).json(msg);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });

  // Activity feed
  app.get("/api/tickets/:id/activity", async (req, res) => {
    res.json(await storage.getTicketActivity(parseInt(req.params.id)));
  });

  // Attachments
  app.get("/api/tickets/:id/attachments", async (req, res) => {
    res.json(await storage.getTicketAttachments(parseInt(req.params.id)));
  });
  app.post("/api/tickets/:id/attachments", async (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const ticket = await storage.getTicket(ticketId);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      const settings = await storage.getTicketSettings();
      const { filename, mimeType, dataBase64, messageId } = req.body || {};
      if (!filename || !dataBase64) return res.status(400).json({ error: "filename and dataBase64 required" });

      const allowedMime = (settings?.allowedMimeTypes || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (allowedMime.length && mimeType && !allowedMime.includes(mimeType)) {
        return res.status(400).json({ error: `Mime type not allowed: ${mimeType}` });
      }
      const buf = Buffer.from(dataBase64, "base64");
      if (settings?.maxAttachmentBytes && buf.length > settings.maxAttachmentBytes) {
        return res.status(400).json({ error: "File exceeds max attachment size" });
      }
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storeName = `${ticketId}-${Date.now()}-${safeName}`;
      const storePath = path.join(ATTACHMENT_DIR, storeName);
      fs.writeFileSync(storePath, buf);

      const uid = sessionUserId(req);
      const att = await storage.createTicketAttachment({
        ticketId,
        messageId: messageId ?? null,
        filename: safeName,
        mimeType: mimeType || null,
        sizeBytes: buf.length,
        storagePath: storePath,
        uploadedByType: "staff",
        uploadedById: uid,
      });
      await storage.createTicketActivity({
        ticketId,
        actorType: "staff",
        actorId: uid,
        actorName: sessionUserName(req),
        action: "attachment_added",
        details: safeName,
      });
      res.status(201).json(att);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });
  app.get("/api/tickets/:id/attachments/:attId/download", async (req, res) => {
    const attId = parseInt(req.params.attId);
    const list = await storage.getTicketAttachments(parseInt(req.params.id));
    const att = list.find((a) => a.id === attId);
    if (!att) return res.status(404).json({ error: "Not found" });
    if (!fs.existsSync(att.storagePath)) return res.status(410).json({ error: "Attachment missing on disk" });
    res.setHeader("Content-Disposition", `attachment; filename="${att.filename}"`);
    if (att.mimeType) res.setHeader("Content-Type", att.mimeType);
    fs.createReadStream(att.storagePath).pipe(res);
  });

  // Lock / unlock — collision avoidance
  app.post("/api/tickets/:id/lock", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    const ticket = await storage.getTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    const uid = sessionUserId(req);
    const settings = await storage.getTicketSettings();
    const expiryMin = settings?.lockExpiryMinutes ?? 15;
    if (ticket.lockedBy && ticket.lockedBy !== uid && ticket.lockedAt) {
      const ageMs = Date.now() - new Date(ticket.lockedAt).getTime();
      if (ageMs < expiryMin * 60_000) {
        return res.status(409).json({ error: "Ticket is locked by another user", lockedBy: ticket.lockedBy });
      }
    }
    const updated = await storage.updateTicket(ticketId, { lockedBy: uid, lockedAt: new Date() });
    await storage.createTicketActivity({
      ticketId,
      actorType: "staff",
      actorId: uid,
      actorName: sessionUserName(req),
      action: "locked",
    });
    res.json(updated);
  });
  app.post("/api/tickets/:id/unlock", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    const updated = await storage.updateTicket(ticketId, { lockedBy: null, lockedAt: null });
    if (!updated) return res.status(404).json({ error: "Ticket not found" });
    await storage.createTicketActivity({
      ticketId,
      actorType: "staff",
      actorId: sessionUserId(req),
      actorName: sessionUserName(req),
      action: "unlocked",
    });
    res.json(updated);
  });

  // Assign / transfer
  app.post("/api/tickets/:id/assign", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    const { assignedTo, teamId, note } = req.body || {};
    const ticket = await storage.getTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    const updated = await storage.updateTicket(ticketId, {
      assignedTo: assignedTo ?? null,
      teamId: teamId ?? ticket.teamId,
    });
    await storage.createTicketActivity({
      ticketId,
      actorType: "staff",
      actorId: sessionUserId(req),
      actorName: sessionUserName(req),
      action: "assigned",
      details: JSON.stringify({ assignedTo: assignedTo ?? null, teamId: teamId ?? null }),
    });
    if (note) {
      await storage.createTicketMessage({
        ticketId,
        authorType: "staff",
        authorId: sessionUserId(req),
        authorName: sessionUserName(req),
        body: `[assignment] ${note}`,
        isInternal: true,
      });
    }
    if (assignedTo) {
      const user = await storage.getUser(assignedTo);
      if (user?.email) void sendAssignmentNotice(updated || ticket, user.email, user.username);
    }
    res.json(updated);
  });
  app.post("/api/tickets/:id/transfer", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    const { departmentId, note } = req.body || {};
    const ticket = await storage.getTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    const updated = await storage.updateTicket(ticketId, {
      departmentId,
      assignedTo: null, // clear assignee on transfer
      teamId: null,
    });
    await storage.createTicketActivity({
      ticketId,
      actorType: "staff",
      actorId: sessionUserId(req),
      actorName: sessionUserName(req),
      action: "transferred",
      details: JSON.stringify({ departmentId }),
    });
    if (note) {
      await storage.createTicketMessage({
        ticketId,
        authorType: "staff",
        authorId: sessionUserId(req),
        authorName: sessionUserName(req),
        body: `[transfer] ${note}`,
        isInternal: true,
      });
    }
    res.json(updated);
  });

  // Status change shortcut (logs activity, handles closed/resolved emails)
  app.post("/api/tickets/:id/status", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    const { status } = req.body || {};
    const ticket = await storage.getTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    const patch: Partial<Ticket> = { status };
    if (status === "closed" || status === "resolved") patch.closedAt = new Date();
    const updated = await storage.updateTicket(ticketId, patch);
    await storage.createTicketActivity({
      ticketId,
      actorType: "staff",
      actorId: sessionUserId(req),
      actorName: sessionUserName(req),
      action: "status_changed",
      details: status,
    });
    if (status === "resolved" && updated) void sendResolvedNotice(updated);
    res.json(updated);
  });

  // Apply a canned response to a ticket (renders + posts as message)
  app.post("/api/tickets/:id/apply-canned/:cannedId", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    const cannedId = parseInt(req.params.cannedId);
    const ticket = await storage.getTicket(ticketId);
    const canned = await storage.getCannedResponse(cannedId);
    if (!ticket || !canned) return res.status(404).json({ error: "Not found" });
    const body = canned.body
      .replace(/{{\s*ticket_number\s*}}/gi, ticket.ticketNumber || String(ticket.id))
      .replace(/{{\s*requester_name\s*}}/gi, ticket.requesterName || "there")
      .replace(/{{\s*subject\s*}}/gi, ticket.subject)
      .replace(/{{\s*priority\s*}}/gi, ticket.priority)
      .replace(/{{\s*status\s*}}/gi, ticket.status);
    const uid = sessionUserId(req);
    const msg = await storage.createTicketMessage({
      ticketId,
      authorType: "staff",
      authorId: uid,
      authorName: sessionUserName(req),
      body,
      isInternal: !!req.body.internal,
      cannedResponseId: cannedId,
    });
    await storage.createTicketActivity({
      ticketId,
      actorType: "staff",
      actorId: uid,
      actorName: sessionUserName(req),
      action: req.body.internal ? "note" : "reply",
      details: `Canned response: ${canned.name}`,
    });
    if (!req.body.internal) void sendReplyNotice(ticket, body);
    res.status(201).json(msg);
  });

  // ====== REPORTS ======
  app.get("/api/helpdesk/reports/summary", async (_req, res) => {
    const all = await storage.getTickets();
    const overdue = await storage.getOverdueTickets();
    const depts = await storage.getTicketDepartments();
    const topics = await storage.getTicketHelpTopics();

    const byStatus: Record<string, number> = {};
    const byDepartment: Record<string, number> = {};
    const byTopic: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const byAssignee: Record<string, number> = {};

    const deptName = (id: number | null | undefined) =>
      id ? depts.find((d) => d.id === id)?.name || `Dept ${id}` : "Unassigned";
    const topicName = (id: number | null | undefined) =>
      id ? topics.find((t) => t.id === id)?.name || `Topic ${id}` : "Untagged";

    for (const t of all) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byDepartment[deptName(t.departmentId)] = (byDepartment[deptName(t.departmentId)] || 0) + 1;
      byTopic[topicName(t.helpTopicId)] = (byTopic[topicName(t.helpTopicId)] || 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
      const key = t.assignedTo ? `user-${t.assignedTo}` : "unassigned";
      byAssignee[key] = (byAssignee[key] || 0) + 1;
    }
    res.json({
      total: all.length,
      open: all.filter((t) => t.status !== "closed" && t.status !== "resolved").length,
      overdue: overdue.length,
      byStatus,
      byDepartment,
      byTopic,
      byPriority,
      byAssignee,
    });
  });

  // Overdue scanner (returns + sends alerts for any not yet alerted)
  app.post("/api/helpdesk/sla/check-overdue", async (_req, res) => {
    const settings = await storage.getTicketSettings();
    if (settings && !settings.overdueAlertEnabled) return res.json({ alerted: 0 });
    const overdue = await storage.getOverdueTickets();
    let alerted = 0;
    for (const t of overdue) {
      if (t.overdueAlertSent) continue;
      void sendOverdueAlert(t);
      await storage.updateTicket(t.id, { overdueAlertSent: true });
      await storage.createTicketActivity({
        ticketId: t.id,
        actorType: "system",
        actorName: "System",
        action: "sla_breach",
        details: t.slaDueAt ? new Date(t.slaDueAt).toISOString() : null,
      });
      alerted++;
    }
    res.json({ overdue: overdue.length, alerted });
  });

  // ====== PUBLIC CUSTOMER PORTAL ======
  app.post("/api/portal/tickets", async (req, res) => {
    try {
      const data = portalNewTicketSchema.parse(req.body);
      const created = await storage.createTicket({
        subject: data.subject,
        description: data.description,
        priority: data.priority || "medium",
        status: "open",
        requesterName: data.requesterName,
        requesterEmail: data.requesterEmail,
        requesterPhone: data.requesterPhone || null,
        helpTopicId: data.helpTopicId || null,
        source: "portal",
      } as any);
      const enriched = await enrichNewTicket(created);
      // Return the bits the customer needs to access it later
      res.status(201).json({
        ticketNumber: enriched.ticketNumber,
        accessToken: enriched.accessToken,
        id: enriched.id,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });

  app.post("/api/portal/tickets/lookup", async (req, res) => {
    try {
      const data = portalLookupSchema.parse(req.body);
      const ticket = await storage.getTicketByNumber(data.ticketNumber);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      if (ticket.requesterEmail?.toLowerCase() !== data.email.toLowerCase()) {
        return res.status(403).json({ error: "Email does not match this ticket" });
      }
      // accessToken acts as a second factor — required unless the caller can
      // prove ownership some other way. Skip token check only if it was never set.
      if (ticket.accessToken && data.accessToken !== ticket.accessToken) {
        return res.status(403).json({ error: "Invalid access token" });
      }
      // Return ticket + public messages + attachments (sanitized)
      const messages = (await storage.getTicketMessages(ticket.id, { includeInternal: false }));
      const attachments = await storage.getTicketAttachments(ticket.id);
      res.json({
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          createdAt: ticket.createdAt,
          dueAt: ticket.dueAt,
          requesterName: ticket.requesterName,
          requesterEmail: ticket.requesterEmail,
        },
        messages: messages.map((m) => ({
          id: m.id,
          authorType: m.authorType,
          authorName: m.authorName,
          body: m.body,
          createdAt: m.createdAt,
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          createdAt: a.createdAt,
        })),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });

  app.post("/api/portal/tickets/reply", async (req, res) => {
    try {
      const data = portalReplySchema.parse(req.body);
      const ticket = await storage.getTicketByEmailAndToken(data.email, data.accessToken);
      if (!ticket || ticket.ticketNumber !== data.ticketNumber) {
        return res.status(403).json({ error: "Invalid credentials" });
      }
      const msg = await storage.createTicketMessage({
        ticketId: ticket.id,
        authorType: "customer",
        authorName: ticket.requesterName || data.email,
        authorEmail: data.email,
        body: data.body,
        isInternal: false,
      });
      // Re-open the ticket if previously closed/resolved
      if (ticket.status === "closed" || ticket.status === "resolved") {
        await storage.updateTicket(ticket.id, { status: "open", closedAt: null });
      }
      await storage.createTicketActivity({
        ticketId: ticket.id,
        actorType: "customer",
        actorName: ticket.requesterName || data.email,
        action: "reply",
        details: data.body.length > 200 ? data.body.slice(0, 200) + "…" : data.body,
      });
      res.status(201).json({ id: msg.id });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Bad request" });
    }
  });

  // ====== INBOUND EMAIL WEBHOOK ======
  // Accepts a SendGrid Inbound Parse style payload OR a generic
  // { from, fromName, to, subject, body, inReplyTo? } JSON body.
  // If subject (or inReplyTo) references an existing ticket number,
  // the body is appended as a customer reply; otherwise a new ticket
  // is created.
  app.post("/api/helpdesk/email/inbound", async (req, res) => {
    try {
      const from = (req.body.from || req.body.envelope?.from || "").toString();
      const fromName = (req.body.fromName || req.body.from_name || "").toString();
      const subject = (req.body.subject || "").toString();
      const body = (req.body.text || req.body.body || req.body.html || "").toString();
      const inReplyTo = (req.body.inReplyTo || req.body["in-reply-to"] || "").toString();
      if (!from || !subject) {
        return res.status(400).json({ error: "from and subject required" });
      }
      const emailMatch = from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      const requesterEmail = emailMatch ? emailMatch[0] : from;

      // Detect ticket number in subject / in-reply-to (e.g. "[CSD-2026-0001]")
      const numMatch = (subject + " " + inReplyTo).match(/[A-Z]{2,5}-\d{4}-\d{4,}/);
      if (numMatch) {
        const existing = await storage.getTicketByNumber(numMatch[0]);
        if (existing) {
          await storage.createTicketMessage({
            ticketId: existing.id,
            authorType: "customer",
            authorName: fromName || requesterEmail,
            authorEmail: requesterEmail,
            body,
            isInternal: false,
          });
          if (existing.status === "closed" || existing.status === "resolved") {
            await storage.updateTicket(existing.id, { status: "open", closedAt: null });
          }
          await storage.createTicketActivity({
            ticketId: existing.id,
            actorType: "customer",
            actorName: fromName || requesterEmail,
            action: "reply",
            details: "via email",
          });
          return res.json({ kind: "reply", ticketId: existing.id });
        }
      }
      const created = await storage.createTicket({
        subject,
        description: body,
        priority: "medium",
        status: "open",
        requesterName: fromName || requesterEmail,
        requesterEmail,
        source: "email",
      } as any);
      const enriched = await enrichNewTicket(created);
      res.status(201).json({ kind: "new", ticketId: enriched.id, ticketNumber: enriched.ticketNumber });
    } catch (err: any) {
      console.error("Inbound email error:", err);
      res.status(500).json({ error: err?.message || "Internal error" });
    }
  });
}
