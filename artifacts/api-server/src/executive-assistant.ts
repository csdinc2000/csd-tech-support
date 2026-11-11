import type { Express, Request } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { logger } from "./lib/logger";
import { isSalesAiConfigured, promptSafe, runSalesAi } from "./sales-ai";
import { bucketTask } from "./sales-agents-core";
import { getSpeedToLeadQueue } from "./speed-to-lead";
import { getStaffAccess, getStaffAssignmentScope, type StaffAssignmentScope } from "./staff-access";

/**
 * Executive Assistant: personal tasks/reminders plus a daily briefing that
 * pulls together what needs attention today. Aria uses the same functions as
 * tools (see aria-tools.ts), so "what's on my plate?" in Aria and the
 * Executive Assistant page always agree.
 *
 * Tasks are private to the staff member who owns them. Briefing sections only
 * appear when the user has the matching staff feature (crm, scheduling,
 * helpdesk), mirroring the API gates for that data.
 */

const TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/New_York";

export type AssistantActor = {
  userId: string;
  features: Partial<Record<string, boolean>>;
  scope: StaffAssignmentScope;
};

export const taskInput = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).nullish(),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  leadId: z.number().int().positive().nullish(),
  contactId: z.number().int().positive().nullish(),
});
const taskPatch = taskInput.partial().extend({ status: z.enum(["open", "done"]).optional() });

function publicTask(r: any, now = new Date()) {
  const dueAt = r.due_at ? new Date(r.due_at) : null;
  return {
    id: Number(r.id), title: r.title, notes: r.notes, dueAt: dueAt?.toISOString() ?? null, priority: r.priority,
    status: r.status, leadId: r.lead_id, contactId: r.contact_id, createdVia: r.created_via,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    bucket: r.status === "done" ? "done" : bucketTask(dueAt, now, TIMEZONE),
  };
}
export type AssistantTask = ReturnType<typeof publicTask>;

export async function listTasks(userId: string, status: "open" | "done" | "all" = "open") {
  const { rows } = await pool.query(
    `SELECT * FROM assistant_tasks WHERE owner_user_id=$1 AND ($2 = 'all' OR status=$2)
      ORDER BY status, due_at NULLS LAST, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 200`, [userId, status]);
  const now = new Date();
  return rows.map((r: any) => publicTask(r, now));
}

export async function createTask(actor: AssistantActor, raw: unknown, via: "app" | "aria" = "app") {
  const input = taskInput.parse(raw);
  if ((input.leadId || input.contactId) && !actor.features.crm) throw new Error("CRM access is required to link a task to a lead or contact");
  const { rows } = await pool.query(
    `INSERT INTO assistant_tasks (owner_user_id, title, notes, due_at, priority, lead_id, contact_id, created_via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [actor.userId, input.title, input.notes ?? null, input.dueAt ?? null, input.priority, input.leadId ?? null, input.contactId ?? null, via],
  );
  return publicTask(rows[0]);
}

export async function updateTask(actor: AssistantActor, taskId: number, raw: unknown) {
  const input = taskPatch.parse(raw);
  const current = (await pool.query("SELECT * FROM assistant_tasks WHERE id=$1 AND owner_user_id=$2", [taskId, actor.userId])).rows[0];
  if (!current) return null;
  const next = {
    title: input.title ?? current.title,
    notes: input.notes !== undefined ? input.notes : current.notes,
    due_at: input.dueAt !== undefined ? input.dueAt : current.due_at,
    priority: input.priority ?? current.priority,
    status: input.status ?? current.status,
    lead_id: input.leadId !== undefined ? input.leadId : current.lead_id,
    contact_id: input.contactId !== undefined ? input.contactId : current.contact_id,
  };
  const { rows } = await pool.query(
    `UPDATE assistant_tasks SET title=$3, notes=$4, due_at=$5, priority=$6, status=$7, lead_id=$8, contact_id=$9,
        completed_at = CASE WHEN $7='done' AND status<>'done' THEN NOW() WHEN $7='open' THEN NULL ELSE completed_at END,
        updated_at=NOW()
      WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
    [taskId, actor.userId, next.title, next.notes, next.due_at, next.priority, next.status, next.lead_id, next.contact_id],
  );
  return rows[0] ? publicTask(rows[0]) : null;
}

export async function deleteTask(userId: string, taskId: number): Promise<boolean> {
  const result = await pool.query("DELETE FROM assistant_tasks WHERE id=$1 AND owner_user_id=$2", [taskId, userId]);
  return (result.rowCount ?? 0) > 0;
}

function dayBounds(now: Date) {
  // Start/end of "today" in the business time zone, as UTC instants.
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const probe = new Date(`${ymd}T12:00:00Z`);
  const tzHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "numeric", hourCycle: "h23" }).format(probe));
  const offsetHours = tzHour - 12; // e.g. -5 for New York in winter
  const start = new Date(`${ymd}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() - offsetHours);
  return { start, end: new Date(start.getTime() + 24 * 3_600_000), ymd };
}

export async function buildBriefing(actor: AssistantActor, now = new Date()) {
  const { start, end, ymd } = dayBounds(now);
  const tasks = await listTasks(actor.userId, "open");
  const briefing: Record<string, any> = {
    date: ymd,
    generatedAt: now.toISOString(),
    timezone: TIMEZONE,
    tasks: {
      overdue: tasks.filter((t) => t.bucket === "overdue"),
      today: tasks.filter((t) => t.bucket === "today"),
      upcoming: tasks.filter((t) => t.bucket === "upcoming").slice(0, 10),
      someday: tasks.filter((t) => t.bucket === "someday").length,
    },
  };

  if (actor.features.crm) {
    try {
      const queue = await getSpeedToLeadQueue(100);
      briefing.speedToLead = {
        enabled: queue.settings.enabled,
        targetMinutes: queue.settings.targetMinutes,
        waiting: queue.leads.filter((l) => l.firstContactAt == null).slice(0, 10)
          .map((l) => ({ leadId: l.leadId, name: l.name, serviceType: l.serviceType, waitingMinutes: l.waitingMinutes, overdue: l.overdue })),
        metrics: queue.metrics,
      };
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "assistant: speed-to-lead section failed");
    }
    const newLeads = await pool.query(
      `SELECT l.id, l.service_type, l.source, l.status, l.created_at, c.full_name, c.company
         FROM crm_leads l LEFT JOIN crm_contacts c ON c.id=l.contact_id
        WHERE l.created_at > NOW() - INTERVAL '24 hours' ORDER BY l.created_at DESC LIMIT 15`);
    const openLeads = await pool.query(
      `SELECT count(*)::int AS n FROM crm_leads WHERE status IN ('new','contacted','qualified','quoted')`);
    const prospects = await pool.query(`SELECT count(*)::int AS n FROM lead_gen_prospects WHERE status='new'`);
    const briefs = await pool.query(
      `SELECT b.lead_id, b.brief->>'headline' AS headline, b.finished_at, c.full_name
         FROM lead_research_briefs b JOIN crm_leads l ON l.id=b.lead_id LEFT JOIN crm_contacts c ON c.id=l.contact_id
        WHERE b.status='completed' AND b.finished_at > NOW() - INTERVAL '48 hours' ORDER BY b.finished_at DESC LIMIT 5`);
    briefing.leads = {
      newLast24h: newLeads.rows.map((r: any) => ({
        leadId: r.id, name: r.full_name || `Lead #${r.id}`, company: r.company, serviceType: r.service_type,
        source: r.source, status: r.status, createdAt: new Date(r.created_at).toISOString(),
      })),
      openPipeline: openLeads.rows[0].n,
      prospectsToReview: prospects.rows[0].n,
      recentBriefs: briefs.rows.map((r: any) => ({ leadId: r.lead_id, name: r.full_name, headline: r.headline })),
    };
  }

  if (actor.features.scheduling) {
    try {
      const appts = await pool.query(
        `SELECT a.reference, a.customer_name, a.starts_at, a.ends_at, a.status, a.contact_id, s.name AS service_name
           FROM appointments a LEFT JOIN services s ON s.id=a.service_id
          WHERE a.starts_at >= $1 AND a.starts_at < $2 AND a.status NOT IN ('cancelled','no_show')
          ORDER BY a.starts_at LIMIT 30`, [start, end]);
      const visible = appts.rows.filter((a: any) => actor.scope.unrestricted || (a.contact_id && actor.scope.contactIds.has(a.contact_id)));
      briefing.appointments = visible.map((a: any) => ({
        reference: a.reference, customerName: a.customer_name, service: a.service_name,
        startsAt: new Date(a.starts_at).toISOString(), endsAt: a.ends_at ? new Date(a.ends_at).toISOString() : null, status: a.status,
      }));
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "assistant: appointments section failed");
    }
  }

  if (actor.features.helpdesk) {
    try {
      const tickets = await pool.query(
        `SELECT count(*) FILTER (WHERE status NOT IN ('closed','resolved'))::int AS open,
                count(*) FILTER (WHERE status NOT IN ('closed','resolved') AND priority IN ('high','urgent','critical'))::int AS urgent
           FROM tickets`);
      briefing.tickets = tickets.rows[0];
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "assistant: tickets section failed");
    }
  }
  return briefing;
}

const NarrativeOut = z.object({
  greeting: z.string().max(300),
  narrative: z.string().max(2000),
  topPriorities: z.array(z.object({ title: z.string().max(200), why: z.string().max(400) })).max(5),
});

/** Aria-voiced spoken summary of the briefing data. */
export async function briefingNarrative(briefing: Record<string, any>, firstName: string) {
  const result = await runSalesAi({
    system: `You are Aria, the executive assistant for staff at Computer Systems Depot Inc. Turn the briefing JSON into a short spoken morning briefing for ${promptSafe(firstName, 40) || "the user"}: warm, direct, no filler, plain sentences. Then pick up to 5 top priorities, most urgent first (overdue tasks, leads waiting past target, today's appointments). Only use facts in the JSON; never invent names, numbers or events. Reply with ONLY JSON: {"greeting":"","narrative":"","topPriorities":[{"title":"","why":""}]}`,
    prompt: `BRIEFING DATA (JSON):\n${JSON.stringify(briefing).slice(0, 20_000)}`,
    schema: NarrativeOut,
    maxTokens: 2500,
  });
  return result.data;
}

export async function actorFromRequest(req: Request): Promise<AssistantActor | null> {
  if (!req.dbUser?.id) return null;
  const access = await getStaffAccess(req);
  return { userId: req.dbUser.id, features: access.features, scope: await getStaffAssignmentScope(req) };
}

export function registerExecutiveAssistantRoutes(app: Express): void {
  const withActor = (handler: (req: Request, res: any, actor: AssistantActor) => Promise<void>) => async (req: Request, res: any) => {
    try {
      const actor = await actorFromRequest(req);
      if (!actor) { res.status(401).json({ message: "Sign in required" }); return; }
      await handler(req, res, actor);
    } catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ message: "Check the task details and try again." }); return; }
      if ((error as Error).message?.startsWith("CRM access")) { res.status(403).json({ message: (error as Error).message }); return; }
      logger.error({ error }, "assistant: request failed");
      res.status(500).json({ message: "Something went wrong." });
    }
  };

  app.get("/api/assistant/briefing", withActor(async (_req, res, actor) => {
    res.json({ briefing: await buildBriefing(actor), aiConfigured: isSalesAiConfigured() });
  }));

  app.post("/api/assistant/briefing/narrative", withActor(async (req, res, actor) => {
    if (!isSalesAiConfigured()) { res.status(503).json({ message: "AI is not configured. Set ANTHROPIC_API_KEY." }); return; }
    const briefing = await buildBriefing(actor);
    const user: any = req.dbUser;
    res.json({ narrative: await briefingNarrative(briefing, user?.firstName || "") });
  }));

  app.get("/api/assistant/tasks", withActor(async (req, res, actor) => {
    const status = req.query.status === "done" || req.query.status === "all" ? req.query.status : "open";
    res.json({ tasks: await listTasks(actor.userId, status) });
  }));

  app.post("/api/assistant/tasks", withActor(async (req, res, actor) => {
    res.status(201).json({ task: await createTask(actor, req.body) });
  }));

  app.patch("/api/assistant/tasks/:id", withActor(async (req, res, actor) => {
    const task = await updateTask(actor, Number(req.params.id), req.body);
    if (!task) { res.status(404).json({ message: "Task not found" }); return; }
    res.json({ task });
  }));

  app.delete("/api/assistant/tasks/:id", withActor(async (req, res, actor) => {
    if (!(await deleteTask(actor.userId, Number(req.params.id)))) { res.status(404).json({ message: "Task not found" }); return; }
    res.json({ ok: true });
  }));
}
