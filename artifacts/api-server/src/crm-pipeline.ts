import { pool } from "./db";
import { storage } from "./storage";
import { enrichNewTicket } from "./routes/helpdesk";
import { publishPipelineEvent } from "./crm-events";
import { DEAL_STAGES, type CrmDeal, type DealStage, type Ticket } from "@workspace/db";

/**
 * CRM pipeline domain logic, kept out of the router so it can be unit-tested
 * with stubbed dependencies (same DI-seam pattern as `a2p-monitor.ts`).
 *
 * Responsibilities:
 *  - stage transitions, including the won → auto-onboarding-ticket rule
 *  - the 360° deal timeline (calls + voicemails + tickets + CRM interactions
 *    in one UNION query, so it stays a single DB roundtrip)
 *  - pipeline dashboard stats in a single roundtrip
 */

type Deps = {
  getCrmDeal: typeof storage.getCrmDeal;
  updateCrmDeal: typeof storage.updateCrmDeal;
  createTicket: typeof storage.createTicket;
  createCrmInteraction: typeof storage.createCrmInteraction;
  enrichNewTicket: (ticket: Ticket) => Promise<Ticket>;
  publishPipelineEvent: typeof publishPipelineEvent;
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

let deps: Deps = {
  getCrmDeal: (id) => storage.getCrmDeal(id),
  updateCrmDeal: (id, update) => storage.updateCrmDeal(id, update),
  createTicket: (t) => storage.createTicket(t),
  createCrmInteraction: (i) => storage.createCrmInteraction(i),
  enrichNewTicket,
  publishPipelineEvent,
  query: (text, params) => pool.query(text, params as any[]),
};

export function __setCrmPipelineDepsForTests(overrides: Partial<Deps>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = previous;
  };
}

export function isDealStage(value: unknown): value is DealStage {
  return typeof value === "string" && (DEAL_STAGES as readonly string[]).includes(value);
}

export type StageChangeResult = {
  deal: CrmDeal;
  /** The auto-generated onboarding ticket, when the transition was → won. */
  onboardingTicket: Ticket | null;
};

/**
 * Move a deal to a new stage. When a deal transitions INTO "won" (from any
 * other stage), an onboarding ticket is auto-created and linked back to the
 * deal, and the change is recorded as a CRM interaction on the deal's
 * lead/contact so it shows up in existing activity views.
 */
export async function changeDealStage(
  dealId: number,
  stage: DealStage,
  options: { technicianId?: number | null; performedBy?: string | null } = {},
): Promise<StageChangeResult | undefined> {
  const existing = await deps.getCrmDeal(dealId);
  if (!existing) return undefined;

  const update: Partial<CrmDeal> = { stage };
  if (options.technicianId !== undefined) {
    update.assignedTechnicianId = options.technicianId;
  }
  const deal = await deps.updateCrmDeal(dealId, update);
  if (!deal) return undefined;

  let onboardingTicket: Ticket | null = null;
  if (stage === "won" && existing.stage !== "won") {
    const base = await deps.createTicket({
      subject: `Onboarding: ${deal.companyName}`,
      description:
        `Automated ticket — deal "${deal.title}" for ${deal.companyName} was marked Won.` +
        ` Estimated MRR: $${deal.estimatedMrr}/mo, one-time fee: $${deal.oneTimeFee}.`,
      priority: "high",
      status: "open",
      source: "api",
      assignedTo: deal.assignedTechnicianId ?? null,
      associatedDealId: deal.id,
    });
    // Enrichment (ticket number, SLA, portal token) must not undo a won deal;
    // fall back to the bare ticket if it fails.
    try {
      onboardingTicket = await deps.enrichNewTicket(base);
    } catch (err: any) {
      console.error("Onboarding ticket enrichment failed:", err?.message ?? err);
      onboardingTicket = base;
    }
  }

  // Activity trail on the existing CRM entities, best-effort.
  if (deal.primaryContactId || deal.leadId) {
    try {
      await deps.createCrmInteraction({
        contactId: deal.primaryContactId ?? null,
        leadId: deal.leadId ?? null,
        jobId: null,
        type: "status_change",
        summary: `Deal "${deal.title}" moved ${existing.stage} → ${stage}`,
        details: onboardingTicket
          ? `Onboarding ticket ${onboardingTicket.ticketNumber ?? `#${onboardingTicket.id}`} auto-created`
          : null,
        performedBy: options.performedBy ?? null,
      });
    } catch (err: any) {
      console.error("CRM interaction log failed:", err?.message ?? err);
    }
  }

  deps.publishPipelineEvent({ type: "deal_stage_changed", dealId: deal.id, stage });
  return { deal, onboardingTicket };
}

export type TimelineItem = {
  interactionType: "call" | "voicemail" | "ticket" | "interaction" | "appointment" | "job";
  itemId: number;
  timestamp: string;
  durationSeconds: number | null;
  description: string;
  assetUrl: string | null;
};

/**
 * 360° interaction history for one deal: every call, voicemail, and ticket
 * linked via associated_deal_id, plus CRM interactions logged against the
 * deal's origin lead or primary contact. Single UNION query ordered newest
 * first — each branch is backed by the partial indexes from the
 * 2026-07-16-crm-pipeline migration.
 */
export async function getDealTimeline(deal: CrmDeal): Promise<TimelineItem[]> {
  const { rows } = await deps.query(
    `
    SELECT 'call' AS interaction_type, cl.id AS item_id, cl.created_at AS timestamp,
           cl.duration_seconds AS duration_seconds,
           COALESCE(cl.direction, 'inbound') || ' call from ' || cl.from_number || ' (' || cl.status || ')' AS description,
           cl.recording_url AS asset_url
    FROM call_log cl WHERE cl.associated_deal_id = $1
    UNION ALL
    SELECT 'voicemail', v.id, v.created_at, v.duration_seconds,
           'Voicemail from ' || v.from_number || COALESCE(' — "' || NULLIF(v.transcription, '') || '"', ''),
           v.recording_url
    FROM voicemails v WHERE v.associated_deal_id = $1
    UNION ALL
    SELECT 'ticket', t.id, t.created_at, NULL,
           'Ticket ' || COALESCE(t.ticket_number, '#' || t.id) || ' [' || t.status || '] ' || t.subject,
           NULL
    FROM tickets t WHERE t.associated_deal_id = $1
    UNION ALL
    SELECT 'interaction', i.id, i.created_at, NULL,
           i.type || ': ' || i.summary,
           NULL
    FROM crm_interactions i
    WHERE (i.lead_id = $2 AND $2 IS NOT NULL) OR (i.contact_id = $3 AND $3 IS NOT NULL)
    UNION ALL
    SELECT 'appointment', a.id, a.starts_at, NULL,
           'Appointment ' || a.reference || ' [' || a.status || '] ' || a.customer_name,
           NULL
    FROM appointments a WHERE a.contact_id = $3 AND $3 IS NOT NULL
    UNION ALL
    SELECT 'job', j.id, j.created_at, NULL,
           'Job ' || j.job_number || ' [' || j.status || '] ' || j.service_type,
           NULL
    FROM crm_jobs j WHERE (j.lead_id = $2 AND $2 IS NOT NULL) OR (j.contact_id = $3 AND $3 IS NOT NULL)
    ORDER BY timestamp DESC
    LIMIT 200
    `,
    [deal.id, deal.leadId ?? null, deal.primaryContactId ?? null],
  );
  return rows.map((r) => ({
    interactionType: r.interaction_type,
    itemId: r.item_id,
    timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
    durationSeconds: r.duration_seconds ?? null,
    description: r.description,
    assetUrl: r.asset_url ?? null,
  }));
}

export const LINKABLE_ITEM_TYPES = ["ticket", "call", "voicemail"] as const;
export type LinkableItemType = (typeof LINKABLE_ITEM_TYPES)[number];

const LINK_TABLES: Record<LinkableItemType, string> = {
  ticket: "tickets",
  call: "call_log",
  voicemail: "voicemails",
};

/**
 * Attach (or detach, with dealId = null) a call, voicemail, or ticket to a
 * deal's timeline by setting its associated_deal_id. Returns false when the
 * target row doesn't exist.
 */
export async function linkItemToDeal(
  itemType: LinkableItemType,
  itemId: number,
  dealId: number | null,
): Promise<boolean> {
  const table = LINK_TABLES[itemType];
  const { rows } = await deps.query(
    `UPDATE ${table} SET associated_deal_id = $1 WHERE id = $2 RETURNING id`,
    [dealId, itemId],
  );
  return rows.length > 0;
}

export type PipelineStats = {
  openTickets: number;
  activeDeals: number;
  pipelineMrr: number;
  wonThisMonth: number;
  wonMrrThisMonth: number;
  byStage: { stage: DealStage; count: number; mrr: number }[];
};

/** Dashboard metrics in two roundtrips (headline scalars + per-stage rollup). */
export async function getPipelineStats(): Promise<PipelineStats> {
  const [headline, perStage] = await Promise.all([
    deps.query(`
      SELECT
        (SELECT COUNT(*)::int FROM tickets WHERE status = 'open') AS open_tickets,
        (SELECT COUNT(*)::int FROM crm_deals WHERE stage IN ('lead','discovery','proposal')) AS active_deals,
        (SELECT COALESCE(SUM(estimated_mrr), 0)::float FROM crm_deals WHERE stage IN ('lead','discovery','proposal')) AS pipeline_mrr,
        (SELECT COUNT(*)::int FROM crm_deals WHERE stage = 'won' AND updated_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)) AS won_this_month,
        (SELECT COALESCE(SUM(estimated_mrr), 0)::float FROM crm_deals WHERE stage = 'won' AND updated_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)) AS won_mrr_this_month
    `),
    deps.query(`
      SELECT stage, COUNT(*)::int AS count, COALESCE(SUM(estimated_mrr), 0)::float AS mrr
      FROM crm_deals GROUP BY stage
    `),
  ]);
  const h = headline.rows[0] ?? {};
  return {
    openTickets: h.open_tickets ?? 0,
    activeDeals: h.active_deals ?? 0,
    pipelineMrr: h.pipeline_mrr ?? 0,
    wonThisMonth: h.won_this_month ?? 0,
    wonMrrThisMonth: h.won_mrr_this_month ?? 0,
    byStage: perStage.rows.map((r) => ({ stage: r.stage, count: r.count, mrr: r.mrr })),
  };
}
