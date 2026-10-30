import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// crm-pipeline -> ./db throws unless DATABASE_URL is present at import time.
// The test seam swaps every dependency for a fake, so no real DB connection is
// ever opened — but the env var must exist before the import chain runs.
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

type CrmDeal = import("@shared/schema").CrmDeal;
type Ticket = import("@shared/schema").Ticket;

const pipeline = await import("../crm-pipeline");
const {
  changeDealStage,
  getDealTimeline,
  getPipelineStats,
  linkItemToDeal,
  isDealStage,
  __setCrmPipelineDepsForTests,
} = pipeline;

function makeDeal(overrides: Partial<CrmDeal> = {}): CrmDeal {
  return {
    id: 1,
    title: "Full MSP Onboarding",
    companyName: "Acme Corporation",
    stage: "proposal",
    estimatedMrr: "1500.00",
    oneTimeFee: "500.00",
    primaryContactId: 7,
    leadId: 3,
    assignedTechnicianId: null,
    notes: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 42,
    subject: "Onboarding: Acme Corporation",
    ticketNumber: "CSD-2026-0042",
    status: "open",
    priority: "high",
    associatedDealId: 1,
    ...overrides,
  } as Ticket;
}

type Recorded = {
  updates: Array<{ id: number; update: Partial<CrmDeal> }>;
  ticketsCreated: any[];
  interactions: any[];
  events: any[];
  queries: Array<{ text: string; params?: unknown[] }>;
};

function installFakes(opts: {
  deal?: CrmDeal | undefined;
  enrichFails?: boolean;
  queryRows?: any[][];
} = {}): { recorded: Recorded; restore: () => void } {
  const recorded: Recorded = {
    updates: [],
    ticketsCreated: [],
    interactions: [],
    events: [],
    queries: [],
  };
  const deal = "deal" in opts ? opts.deal : makeDeal();
  let queryCall = 0;
  const restore = __setCrmPipelineDepsForTests({
    getCrmDeal: async () => deal,
    updateCrmDeal: async (id, update) => {
      recorded.updates.push({ id, update });
      return deal ? ({ ...deal, ...update } as CrmDeal) : undefined;
    },
    createTicket: async (t) => {
      recorded.ticketsCreated.push(t);
      return makeTicket({ ticketNumber: null }) as Ticket;
    },
    createCrmInteraction: async (i) => {
      recorded.interactions.push(i);
      return { id: 1, ...i, createdAt: new Date() } as any;
    },
    enrichNewTicket: async (t) => {
      if (opts.enrichFails) throw new Error("enrichment boom");
      return { ...t, ticketNumber: "CSD-2026-0042" };
    },
    publishPipelineEvent: (e) => {
      recorded.events.push(e);
    },
    query: async (text, params) => {
      recorded.queries.push({ text, params });
      const rows = opts.queryRows?.[queryCall++] ?? [];
      return { rows };
    },
  });
  return { recorded, restore };
}

let restoreDeps: (() => void) | null = null;
beforeEach(() => {
  if (restoreDeps) {
    restoreDeps();
    restoreDeps = null;
  }
});

// ---------------------------------------------------------------------------
// isDealStage
// ---------------------------------------------------------------------------

test("isDealStage accepts pipeline stages and rejects anything else", () => {
  for (const s of ["lead", "discovery", "proposal", "won", "lost"]) {
    assert.equal(isDealStage(s), true, s);
  }
  assert.equal(isDealStage("Won"), false);
  assert.equal(isDealStage(""), false);
  assert.equal(isDealStage(42), false);
  assert.equal(isDealStage(undefined), false);
});

// ---------------------------------------------------------------------------
// changeDealStage
// ---------------------------------------------------------------------------

test("moving a deal to won auto-creates a linked onboarding ticket", async () => {
  const { recorded, restore } = installFakes();
  restoreDeps = restore;

  const result = await changeDealStage(1, "won", { performedBy: "tech@csd.com" });

  assert.ok(result);
  assert.equal(result.deal.stage, "won");
  assert.ok(result.onboardingTicket, "expected an onboarding ticket");
  assert.equal(result.onboardingTicket!.ticketNumber, "CSD-2026-0042");

  assert.equal(recorded.ticketsCreated.length, 1);
  const ticket = recorded.ticketsCreated[0];
  assert.equal(ticket.subject, "Onboarding: Acme Corporation");
  assert.equal(ticket.associatedDealId, 1);
  assert.equal(ticket.status, "open");

  // Stage change is broadcast to connected technicians.
  assert.deepEqual(recorded.events, [{ type: "deal_stage_changed", dealId: 1, stage: "won" }]);
});

test("moving an already-won deal to won does NOT create a second ticket", async () => {
  const { recorded, restore } = installFakes({ deal: makeDeal({ stage: "won" }) });
  restoreDeps = restore;

  const result = await changeDealStage(1, "won");

  assert.ok(result);
  assert.equal(result.onboardingTicket, null);
  assert.equal(recorded.ticketsCreated.length, 0);
});

test("non-won stage moves create no ticket but still broadcast + log activity", async () => {
  const { recorded, restore } = installFakes();
  restoreDeps = restore;

  const result = await changeDealStage(1, "discovery");

  assert.ok(result);
  assert.equal(result.onboardingTicket, null);
  assert.equal(recorded.ticketsCreated.length, 0);
  assert.equal(recorded.events.length, 1);
  assert.equal(recorded.events[0].stage, "discovery");

  // Interaction recorded against the deal's lead/contact.
  assert.equal(recorded.interactions.length, 1);
  assert.equal(recorded.interactions[0].type, "status_change");
  assert.match(recorded.interactions[0].summary, /proposal → discovery/);
  assert.equal(recorded.interactions[0].contactId, 7);
  assert.equal(recorded.interactions[0].leadId, 3);
});

test("missing deal returns undefined and touches nothing", async () => {
  const { recorded, restore } = installFakes({ deal: undefined });
  restoreDeps = restore;

  const result = await changeDealStage(999, "won");

  assert.equal(result, undefined);
  assert.equal(recorded.updates.length, 0);
  assert.equal(recorded.ticketsCreated.length, 0);
  assert.equal(recorded.events.length, 0);
});

test("enrichment failure still returns the bare onboarding ticket (won is not undone)", async () => {
  const { recorded, restore } = installFakes({ enrichFails: true });
  restoreDeps = restore;

  const result = await changeDealStage(1, "won");

  assert.ok(result);
  assert.ok(result.onboardingTicket, "bare ticket should survive enrichment failure");
  assert.equal(result.onboardingTicket!.ticketNumber, null);
  assert.equal(recorded.ticketsCreated.length, 1);
  assert.equal(recorded.events.length, 1, "event still published");
});

test("technicianId is applied to the deal on stage change", async () => {
  const { recorded, restore } = installFakes();
  restoreDeps = restore;

  await changeDealStage(1, "proposal", { technicianId: 12 });

  assert.equal(recorded.updates.length, 1);
  assert.equal(recorded.updates[0].update.assignedTechnicianId, 12);
});

test("deal without lead/contact skips the interaction log", async () => {
  const { recorded, restore } = installFakes({
    deal: makeDeal({ primaryContactId: null, leadId: null }),
  });
  restoreDeps = restore;

  await changeDealStage(1, "discovery");

  assert.equal(recorded.interactions.length, 0);
});

// ---------------------------------------------------------------------------
// getDealTimeline
// ---------------------------------------------------------------------------

test("timeline maps union rows and passes deal/lead/contact params", async () => {
  const now = new Date("2026-07-15T18:30:00Z");
  const { recorded, restore } = installFakes({
    queryRows: [
      [
        {
          interaction_type: "call",
          item_id: 5,
          timestamp: now,
          duration_seconds: 240,
          description: "inbound call from +19545550123 (completed)",
          asset_url: "https://api.twilio.com/rec/1",
        },
        {
          interaction_type: "ticket",
          item_id: 42,
          timestamp: now,
          duration_seconds: null,
          description: "Ticket CSD-2026-0042 [open] Onboarding: Acme Corporation",
          asset_url: null,
        },
      ],
    ],
  });
  restoreDeps = restore;

  const items = await getDealTimeline(makeDeal());

  assert.equal(items.length, 2);
  assert.equal(items[0].interactionType, "call");
  assert.equal(items[0].durationSeconds, 240);
  assert.equal(items[0].timestamp, now.toISOString());
  assert.equal(items[1].assetUrl, null);

  assert.equal(recorded.queries.length, 1);
  assert.deepEqual(recorded.queries[0].params, [1, 3, 7]);
  assert.match(recorded.queries[0].text, /associated_deal_id = \$1/);
  assert.match(recorded.queries[0].text, /crm_interactions/);
});

// ---------------------------------------------------------------------------
// linkItemToDeal
// ---------------------------------------------------------------------------

test("linkItemToDeal targets the right table per item type", async () => {
  const { recorded, restore } = installFakes({ queryRows: [[{ id: 9 }], [{ id: 9 }], [{ id: 9 }]] });
  restoreDeps = restore;

  assert.equal(await linkItemToDeal("ticket", 9, 1), true);
  assert.equal(await linkItemToDeal("call", 9, 1), true);
  assert.equal(await linkItemToDeal("voicemail", 9, null), true);

  assert.match(recorded.queries[0].text, /UPDATE tickets SET/);
  assert.match(recorded.queries[1].text, /UPDATE call_log SET/);
  assert.match(recorded.queries[2].text, /UPDATE voicemails SET/);
  // detach passes null
  assert.deepEqual(recorded.queries[2].params, [null, 9]);
});

test("linkItemToDeal returns false when the target row does not exist", async () => {
  const { restore } = installFakes({ queryRows: [[]] });
  restoreDeps = restore;

  assert.equal(await linkItemToDeal("ticket", 12345, 1), false);
});

// ---------------------------------------------------------------------------
// getPipelineStats
// ---------------------------------------------------------------------------

test("pipeline stats map headline scalars and per-stage rollups", async () => {
  const { restore } = installFakes({
    queryRows: [
      [
        {
          open_tickets: 14,
          active_deals: 6,
          pipeline_mrr: 8200,
          won_this_month: 3,
          won_mrr_this_month: 4500,
        },
      ],
      [
        { stage: "lead", count: 2, mrr: 1200 },
        { stage: "won", count: 3, mrr: 4500 },
      ],
    ],
  });
  restoreDeps = restore;

  const stats = await getPipelineStats();

  assert.equal(stats.openTickets, 14);
  assert.equal(stats.activeDeals, 6);
  assert.equal(stats.pipelineMrr, 8200);
  assert.equal(stats.wonThisMonth, 3);
  assert.equal(stats.wonMrrThisMonth, 4500);
  assert.deepEqual(stats.byStage, [
    { stage: "lead", count: 2, mrr: 1200 },
    { stage: "won", count: 3, mrr: 4500 },
  ]);
});

test("pipeline stats tolerate an empty headline row", async () => {
  const { restore } = installFakes({ queryRows: [[], []] });
  restoreDeps = restore;

  const stats = await getPipelineStats();

  assert.equal(stats.openTickets, 0);
  assert.equal(stats.pipelineMrr, 0);
  assert.deepEqual(stats.byStage, []);
});
