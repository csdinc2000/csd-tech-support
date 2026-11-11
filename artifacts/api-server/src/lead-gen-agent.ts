import type { Express, Request } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { logger } from "./lib/logger";
import { isSalesAiConfigured, isSalesWebSearchEnabled, promptSafe, runSalesAi, SalesAiUnavailableError } from "./sales-ai";
import { clampScore, normalizeProspectPhone, normalizeWebsite, prospectDedupeKey } from "./sales-agents-core";

/**
 * Lead Generation Agent.
 *
 * Staff describe the businesses they want (e.g. "dental offices with 5-30
 * staff") and an area. Claude researches the public web and returns real
 * businesses with a fit score, reasons, suggested CSD services, and the pages it
 * used. Results are SUGGESTIONS ONLY: nothing is contacted, and nothing reaches
 * the CRM until a staff member imports a prospect. Imported leads carry
 * source `lead_gen_agent`, which Speed to Lead always excludes (no consent).
 */

const SYSTEM = `You are the Lead Generation Agent for Computer Systems Depot Inc (CSD), an IT services company at 5601 NW 13 Street, Lauderhill, FL 33313 serving Broward, Miami-Dade and Palm Beach counties.

CSD sells: managed IT services and maintenance contracts, remote/on-site support, computer and Mac repair, network setup (wired/wireless/VPN), security cameras, data backup and recovery, cybersecurity and virus removal, Microsoft 365/email setup, office setup and relocation, hardware sales (new/refurbished/custom), web design/hosting and local SEO.

Your job: find REAL, currently operating businesses that match the staff member's target and would plausibly buy CSD's services. Use web search to find and verify them (business directories, Google Business listings, the companies' own websites, chamber of commerce pages).

Rules:
- Only include businesses you found evidence for in your searches. Never invent a business, phone number, email or website. If a field is not on a page you saw, use null.
- Only public business contact details (main line, general inbox). Never personal cell numbers or personal emails.
- Prefer businesses inside the requested area. Skip national chains and franchises with corporate IT departments.
- fitScore 0-100: how likely they need and can pay for CSD's services (size, industry IT dependence, compliance needs like HIPAA, outdated or missing website, multiple locations, growth signals).
- fitReasons: 1-3 short concrete sentences grounded in what you saw.
- suggestedServices: 1-4 CSD services from the list above.
- openingLine: one natural sentence a CSD rep could open a call or email with, referencing something specific about the business. No fake familiarity.
- sources: the URLs you used for that business.

When done, reply with ONLY this JSON object and nothing else:
{"summary":"one or two sentences about the search and market","prospects":[{"businessName":"","website":null,"phone":null,"email":null,"address":null,"city":null,"industry":"","employeeEstimate":null,"fitScore":0,"fitReasons":"","suggestedServices":[""],"openingLine":"","sources":[""]}]}`;

const ProspectOut = z.object({
  businessName: z.string().trim().min(1).max(200),
  website: z.string().max(500).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().max(254).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  employeeEstimate: z.string().max(60).nullable().optional(),
  fitScore: z.number(),
  fitReasons: z.string().max(1200).default(""),
  suggestedServices: z.array(z.string().max(120)).max(8).default([]),
  openingLine: z.string().max(600).default(""),
  sources: z.array(z.string().max(1000)).max(12).default([]),
});
const RunOut = z.object({
  summary: z.string().max(1500).default(""),
  prospects: z.array(ProspectOut).max(40),
});

const runInput = z.object({
  target: z.string().trim().min(3).max(400),
  location: z.string().trim().min(2).max(160).default("Lauderhill, FL (Broward County)"),
  maxResults: z.number().int().min(3).max(25).default(10),
}).strict();

const lastRunByUser = new Map<string, number>();
const RUN_COOLDOWN_MS = 30_000;

function safeEmail(value: string | null | undefined): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** Validates and normalizes model output; drops duplicates (within the run, vs the CRM, vs earlier prospects). */
export async function prepareProspects(prospects: z.infer<typeof ProspectOut>[], maxResults: number) {
  const seen = new Set<string>();
  const prepared = [];
  for (const p of prospects) {
    const website = normalizeWebsite(p.website);
    const key = prospectDedupeKey(p.businessName, website);
    if (seen.has(key)) continue;
    seen.add(key);
    prepared.push({
      businessName: p.businessName.trim(),
      website,
      phone: normalizeProspectPhone(p.phone),
      email: safeEmail(p.email),
      address: p.address?.trim() || null,
      city: p.city?.trim() || null,
      industry: p.industry?.trim() || null,
      employeeEstimate: p.employeeEstimate?.trim() || null,
      fitScore: clampScore(p.fitScore),
      fitReasons: p.fitReasons.trim(),
      suggestedServices: p.suggestedServices.map((s) => s.trim()).filter(Boolean).join(", "),
      openingLine: p.openingLine.trim(),
      sources: p.sources.filter((u) => /^https?:\/\//i.test(u)).slice(0, 8),
      dedupeKey: key,
    });
  }
  if (!prepared.length) return [];
  // Skip businesses already in the CRM (company name or website domain) or already suggested.
  const existing = await pool.query(
    "SELECT dedupe_key FROM lead_gen_prospects WHERE dedupe_key = ANY($1::text[])",
    [prepared.map((p) => p.dedupeKey)],
  );
  const known = new Set<string>(existing.rows.map((r: any) => r.dedupe_key));
  const companies = await pool.query("SELECT DISTINCT company FROM crm_contacts WHERE company IS NOT NULL AND company <> ''");
  for (const row of companies.rows) known.add(prospectDedupeKey(row.company, null));
  return prepared
    .filter((p) => !known.has(p.dedupeKey))
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, maxResults);
}

export type LeadGenResearcher = (input: { target: string; location: string; maxResults: number }) =>
  Promise<{ summary: string; prospects: z.infer<typeof ProspectOut>[]; model: string }>;

const claudeResearcher: LeadGenResearcher = async ({ target, location, maxResults }) => {
  const result = await runSalesAi({
    system: SYSTEM,
    schema: RunOut,
    webSearches: Math.min(10, Math.max(4, Math.ceil(maxResults / 2) + 2)),
    maxTokens: 16000,
    prompt: `Target businesses: ${promptSafe(target, 400)}
Area: ${promptSafe(location, 160)}
Find up to ${maxResults + 5} candidates so duplicates can be removed; return the best ones first.`,
  });
  return { summary: result.data.summary, prospects: result.data.prospects, model: result.model };
};

export async function executeLeadGenRun(runId: number, input: z.infer<typeof runInput>, researcher: LeadGenResearcher = claudeResearcher) {
  try {
    const output = await researcher(input);
    const prospects = await prepareProspects(output.prospects, input.maxResults);
    for (const p of prospects) {
      await pool.query(
        `INSERT INTO lead_gen_prospects
           (run_id, business_name, website, phone, email, address, city, industry, employee_estimate,
            fit_score, fit_reasons, suggested_services, opening_line, sources, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [runId, p.businessName, p.website, p.phone, p.email, p.address, p.city, p.industry, p.employeeEstimate,
          p.fitScore, p.fitReasons, p.suggestedServices, p.openingLine, JSON.stringify(p.sources), p.dedupeKey],
      );
    }
    await pool.query(
      `UPDATE lead_gen_runs SET status='completed', summary=$2, prospect_count=$3, model=$4, finished_at=NOW() WHERE id=$1`,
      [runId, output.summary || null, prospects.length, output.model],
    );
  } catch (error) {
    const message = error instanceof SalesAiUnavailableError ? error.message : "The research run failed. Try a narrower target or try again later.";
    logger.warn({ runId, error: (error as Error).message }, "lead-gen: run failed");
    await pool.query(`UPDATE lead_gen_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`, [runId, message]);
  }
}

/** Starts a run in the background; returns its id immediately. */
export async function startLeadGenRun(userId: string, raw: unknown, researcher?: LeadGenResearcher): Promise<number> {
  const input = runInput.parse(raw);
  // Fail runs a crash left behind so the UI never spins forever.
  await pool.query(`UPDATE lead_gen_runs SET status='failed', error='Interrupted', finished_at=NOW()
                     WHERE status='running' AND created_at < NOW() - INTERVAL '15 minutes'`);
  const { rows } = await pool.query(
    `INSERT INTO lead_gen_runs (created_by, target, location, max_results) VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, input.target, input.location, input.maxResults],
  );
  const runId = Number(rows[0].id);
  void executeLeadGenRun(runId, input, researcher);
  return runId;
}

function publicProspect(r: any) {
  return {
    id: Number(r.id), runId: Number(r.run_id), businessName: r.business_name, website: r.website, phone: r.phone,
    email: r.email, address: r.address, city: r.city, industry: r.industry, employeeEstimate: r.employee_estimate,
    fitScore: r.fit_score, fitReasons: r.fit_reasons, suggestedServices: r.suggested_services,
    openingLine: r.opening_line, sources: r.sources ?? [], status: r.status,
    contactId: r.contact_id, leadId: r.lead_id, createdAt: new Date(r.created_at).toISOString(),
  };
}
function publicRun(r: any) {
  return {
    id: Number(r.id), target: r.target, location: r.location, maxResults: r.max_results, status: r.status,
    error: r.error, summary: r.summary, prospectCount: r.prospect_count,
    createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

export async function listProspects(opts: { status?: string; runId?: number; limit?: number } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM lead_gen_prospects
      WHERE ($1::text IS NULL OR status=$1) AND ($2::bigint IS NULL OR run_id=$2)
      ORDER BY created_at DESC, fit_score DESC LIMIT $3`,
    [opts.status ?? null, opts.runId ?? null, Math.min(opts.limit ?? 200, 500)],
  );
  return rows.map(publicProspect);
}

/** Creates a CRM contact + lead (status new, source lead_gen_agent) from a prospect, exactly once. */
export async function importProspect(prospectId: number, userId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = (await client.query("SELECT * FROM lead_gen_prospects WHERE id=$1 FOR UPDATE", [prospectId])).rows[0];
    if (!p) throw Object.assign(new Error("Prospect not found"), { status: 404 });
    if (p.status === "imported") { await client.query("COMMIT"); return publicProspect(p); }
    const contact = await client.query(
      `INSERT INTO crm_contacts (full_name, office_phone, email, company, address, city, notes, tags, contact_preference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'prospect, lead_gen_agent','call') RETURNING id`,
      [p.business_name, p.phone, p.email, p.business_name, p.address, p.city,
        [p.website ? `Website: ${p.website}` : null, p.industry ? `Industry: ${p.industry}` : null].filter(Boolean).join("\n") || null],
    );
    const contactId = Number(contact.rows[0].id);
    const notes = [
      `Fit score ${p.fit_score}/100. ${p.fit_reasons}`,
      p.opening_line ? `Opening line: ${p.opening_line}` : "",
      (p.sources ?? []).length ? `Sources:\n${(p.sources as string[]).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const lead = await client.query(
      `INSERT INTO crm_leads (contact_id, source, service_type, problem_description, status, priority, notes)
       VALUES ($1,'lead_gen_agent',$2,$3,'new',$4,$5) RETURNING id`,
      [contactId, (p.suggested_services || "Managed IT Services").split(",")[0].trim() || "Managed IT Services",
        `Outbound prospect: ${p.industry || "business"}. Suggested: ${p.suggested_services || "IT services"}`,
        p.fit_score >= 75 ? "high" : "normal", notes],
    );
    const leadId = Number(lead.rows[0].id);
    await client.query(
      `INSERT INTO crm_interactions (type, summary, contact_id, lead_id, details, performed_by)
       VALUES ('note', 'Imported from Lead Generation Agent', $1, $2, $3, $4)`,
      [contactId, leadId, notes, userId],
    );
    const updated = await client.query(
      `UPDATE lead_gen_prospects SET status='imported', contact_id=$2, lead_id=$3, reviewed_by=$4, reviewed_at=NOW()
        WHERE id=$1 RETURNING *`, [prospectId, contactId, leadId, userId]);
    await client.query("COMMIT");
    return publicProspect(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function userIdOf(req: Request): string | null {
  return req.dbUser?.id ?? null;
}

export function registerLeadGenRoutes(app: Express): void {
  app.get("/api/crm/lead-gen/status", (_req, res) => {
    res.json({ configured: isSalesAiConfigured(), webSearch: isSalesWebSearchEnabled() });
  });

  app.get("/api/crm/lead-gen/runs", async (_req, res) => {
    const { rows } = await pool.query("SELECT * FROM lead_gen_runs ORDER BY created_at DESC LIMIT 30");
    res.json({ runs: rows.map(publicRun) });
  });

  app.get("/api/crm/lead-gen/runs/:id", async (req, res) => {
    const id = Number(req.params.id);
    const run = (await pool.query("SELECT * FROM lead_gen_runs WHERE id=$1", [id])).rows[0];
    if (!run) { res.status(404).json({ message: "Run not found" }); return; }
    res.json({ run: publicRun(run), prospects: await listProspects({ runId: id }) });
  });

  app.post("/api/crm/lead-gen/runs", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) { res.status(401).json({ message: "Sign in required" }); return; }
    if (!isSalesAiConfigured()) { res.status(503).json({ message: "AI is not configured. Set ANTHROPIC_API_KEY." }); return; }
    const last = lastRunByUser.get(userId) ?? 0;
    if (Date.now() - last < RUN_COOLDOWN_MS) { res.status(429).json({ message: "Please wait a moment before starting another search." }); return; }
    const running = await pool.query("SELECT count(*)::int AS n FROM lead_gen_runs WHERE status='running' AND created_at > NOW() - INTERVAL '15 minutes'");
    if (running.rows[0].n >= 3) { res.status(429).json({ message: "Three searches are already running. Try again when one finishes." }); return; }
    try {
      lastRunByUser.set(userId, Date.now());
      const runId = await startLeadGenRun(userId, req.body);
      res.status(202).json({ runId });
    } catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ message: "Describe the target (3+ characters) and pick 3–25 results." }); return; }
      throw error;
    }
  });

  app.get("/api/crm/lead-gen/prospects", async (req, res) => {
    const status = typeof req.query.status === "string" && ["new", "imported", "dismissed"].includes(req.query.status) ? req.query.status : undefined;
    res.json({ prospects: await listProspects({ status }) });
  });

  app.post("/api/crm/lead-gen/prospects/:id/import", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) { res.status(401).json({ message: "Sign in required" }); return; }
    try {
      res.json({ prospect: await importProspect(Number(req.params.id), userId) });
    } catch (error: any) {
      if (error?.status === 404) { res.status(404).json({ message: "Prospect not found" }); return; }
      logger.error({ error }, "lead-gen: import failed");
      res.status(500).json({ message: "The prospect could not be imported." });
    }
  });

  app.post("/api/crm/lead-gen/prospects/:id/dismiss", async (req, res) => {
    const updated = await pool.query(
      `UPDATE lead_gen_prospects SET status='dismissed', reviewed_by=$2, reviewed_at=NOW()
        WHERE id=$1 AND status='new' RETURNING *`, [Number(req.params.id), userIdOf(req)]);
    if (!updated.rowCount) { res.status(409).json({ message: "Only new prospects can be dismissed." }); return; }
    res.json({ prospect: publicProspect(updated.rows[0]) });
  });
}
