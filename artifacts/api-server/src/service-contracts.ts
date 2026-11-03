import type { Express, Request } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { rateLimit } from "./security";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const documentHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signingLimiter = rateLimit({ windowMs: 60_000, max: 20, message: "Too many signing requests. Please wait and try again." });

const createSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  signerName: z.string().trim().optional().default(""),
  signerTitle: z.string().trim().optional().default(""),
  signerEmail: z.string().trim().email().optional().or(z.literal("")).default(""),
  contractType: z.string().trim().min(1).default("Yearly with Monthly Installments"),
  annualValueCents: z.coerce.number().int().min(0),
  monthlyPaymentCents: z.coerce.number().int().min(0),
  effectiveDate: z.string().date(),
  renewalType: z.enum(["auto_annual", "ends", "month_to_month"]).default("auto_annual"),
  responseTimeSla: z.string().trim().min(1),
  supportHours: z.string().trim().min(1),
  terms: z.object({
    includedSupport: z.string().trim().default("Remote helpdesk and proactive network monitoring as selected by the parties."),
    deviceLimits: z.string().trim().default("To be completed before sending."),
    onsiteWork: z.string().trim().default("Onsite work is billed separately unless expressly listed as included."),
    backups: z.string().trim().default("Provider manages and monitors configured backup software; Client retains ownership and responsibility for its data and recovery objectives."),
  }),
});

const signSchema = z.object({
  signerName: z.string().trim().min(2).max(160),
  signerTitle: z.string().trim().min(2).max(160),
  signerEmail: z.string().trim().email(),
  signatureText: z.string().trim().min(2).max(160),
  consent: z.literal(true),
});
const updateTermsSchema = z.object({
  includedSupport: z.string().trim().min(10),
  deviceLimits: z.string().trim().min(3),
  onsiteWork: z.string().trim().min(10),
  backups: z.string().trim().min(10),
});
const termsAreComplete = (terms: Record<string, unknown>) =>
  ["includedSupport", "deviceLimits", "onsiteWork", "backups"].every((key) => {
    const value = String(terms?.[key] || "").trim();
    return value.length >= 3 && !/to be completed/i.test(value);
  });

function ipFrom(req: Request) {
  return String(req.ip || req.socket.remoteAddress || "").slice(0, 120);
}

export function registerServiceContractRoutes(app: Express) {
  app.get("/api/clients/:id/contracts", async (req, res) => {
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      res.status(400).json({ message: "Invalid client" });
      return;
    }
    const result = await pool.query(`SELECT id, client_id AS "clientId", title, status, annual_value_cents AS "annualValueCents", monthly_payment_cents AS "monthlyPaymentCents", effective_date AS "effectiveDate", signer_name AS "signerName", signer_title AS "signerTitle", signer_email AS "signerEmail", response_time_sla AS "responseTimeSla", support_hours AS "supportHours", terms, sent_at AS "sentAt", signed_at AS "signedAt", token_expires_at AS "tokenExpiresAt", created_at AS "createdAt" FROM service_contracts WHERE client_id=$1 ORDER BY created_at DESC`, [clientId]);
    res.json(result.rows);
  });

  app.post("/api/service-contracts", async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid contract" });
      return;
    }
    const input = parsed.data;
    const complete = termsAreComplete(input.terms);
    const client = await pool.query(
      `SELECT id,name,address,city,state,zip_code AS "zipCode" FROM clients WHERE id=$1`,
      [input.clientId],
    );
    if (!client.rowCount) {
      res.status(404).json({ message: "Client not found" });
      return;
    }
    const selectedClient = client.rows[0];
    const clientAddress = [
      selectedClient.address,
      selectedClient.city,
      selectedClient.state,
      selectedClient.zipCode,
    ].filter(Boolean).join(", ") || "Address to be completed";
    const token = randomBytes(32).toString("base64url");
    const result = await pool.query(
      `INSERT INTO service_contracts (client_id,title,status,contract_type,annual_value_cents,monthly_payment_cents,effective_date,renewal_type,response_time_sla,support_hours,provider_name,provider_address,client_name,client_address,signer_name,signer_title,signer_email,terms,signing_token_hash,token_expires_at,sent_at)
       VALUES ($1,$2,$17,$3,$4,$5,$6,$7,$8,$9,'Computer Systems Depot Inc.','5601 NW 13th Street, Lauderhill, Florida 33313',$10,$11,NULLIF($12,''),NULLIF($13,''),NULLIF($14,''),$15,$16,NOW()+INTERVAL '30 days',CASE WHEN $17='sent' THEN NOW() ELSE NULL END) RETURNING id,status,token_expires_at AS "tokenExpiresAt"`,
      [input.clientId, "Computer Systems Maintenance Agreement", input.contractType, input.annualValueCents, input.monthlyPaymentCents, input.effectiveDate, input.renewalType, input.responseTimeSla, input.supportHours, selectedClient.name, clientAddress, input.signerName, input.signerTitle, input.signerEmail, input.terms, tokenHash(token), complete ? "sent" : "draft"],
    );
    await pool.query(`INSERT INTO service_contract_events(contract_id,event_type,actor_type,actor_identity) VALUES($1,$2,'staff',$3)`, [result.rows[0].id, complete ? "sent" : "created", req.dbUser?.id ?? null]);
    res.status(201).json({ ...result.rows[0], signingPath: complete ? `/sign/contract/${token}` : null });
  });

  app.post("/api/service-contracts/:id/signing-link", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid contract" });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const current = await pool.query(`SELECT status,terms FROM service_contracts WHERE id=$1`, [id]);
    if (!current.rowCount) {
      res.status(404).json({ message: "Contract not found" });
      return;
    }
    if (current.rows[0].status === "signed") {
      res.status(409).json({ message: "Signed contracts cannot receive a new signing link" });
      return;
    }
    if (current.rows[0].status === "void") {
      res.status(409).json({ message: "Voided contracts cannot receive a new signing link" });
      return;
    }
    if (!termsAreComplete(current.rows[0].terms)) {
      res.status(409).json({ message: "Complete all service coverage fields before creating a signing link" });
      return;
    }
    const result = await pool.query(
      `UPDATE service_contracts
       SET signing_token_hash=$2, token_expires_at=NOW()+INTERVAL '30 days',
            status='sent', sent_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status IN ('draft','sent','viewed') AND terms=$3::jsonb
       RETURNING id,status,token_expires_at AS "tokenExpiresAt"`,
       [id, tokenHash(token), JSON.stringify(current.rows[0].terms)],
    );
    if (!result.rowCount) {
      res.status(409).json({ message: "This agreement can no longer receive a signing link" });
      return;
    }
    await pool.query(`INSERT INTO service_contract_events(contract_id,event_type,actor_type,actor_identity) VALUES($1,'signing_link_regenerated','staff',$2)`, [id, req.dbUser?.id ?? null]);
    res.json({ ...result.rows[0], signingPath: `/sign/contract/${token}` });
  });

  app.patch("/api/service-contracts/:id", async (req, res) => {
    const id = Number(req.params.id);
    const parsed = updateTermsSchema.safeParse(req.body?.terms);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid contract" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message || "Complete every service field" });
      return;
    }
    const result = await pool.query(`UPDATE service_contracts SET terms=$2,updated_at=NOW() WHERE id=$1 AND status <> 'signed' AND status <> 'void' RETURNING id,status,terms`, [id, parsed.data]);
    if (!result.rowCount) {
      res.status(409).json({ message: "Signed or voided contracts cannot be edited" });
      return;
    }
    await pool.query(`INSERT INTO service_contract_events(contract_id,event_type,actor_type,actor_identity) VALUES($1,'terms_updated','staff',$2)`, [id, req.dbUser?.id ?? null]);
    res.json(result.rows[0]);
  });

  app.get("/api/public/contracts/:token", signingLimiter, async (req, res) => {
    const hash = tokenHash(req.params.token);
    const fields = `id,title,status,contract_type AS "contractType",annual_value_cents AS "annualValueCents",monthly_payment_cents AS "monthlyPaymentCents",effective_date AS "effectiveDate",renewal_type AS "renewalType",response_time_sla AS "responseTimeSla",support_hours AS "supportHours",provider_name AS "providerName",provider_address AS "providerAddress",client_name AS "clientName",client_address AS "clientAddress",signer_name AS "signerName",signer_title AS "signerTitle",signer_email AS "signerEmail",terms,token_expires_at AS "tokenExpiresAt",signed_at AS "signedAt",signature_text AS "signatureText"`;
    const transitioned = await pool.query(
      `UPDATE service_contracts SET status='viewed',updated_at=NOW()
       WHERE signing_token_hash=$1 AND status='sent' AND token_expires_at >= NOW()
       RETURNING ${fields}`,
      [hash],
    );
    if (transitioned.rowCount) {
      await pool.query(`INSERT INTO service_contract_events(contract_id,event_type,actor_type,metadata) VALUES($1,'viewed','signer',$2)`, [transitioned.rows[0].id, { userAgent: String(req.headers["user-agent"] || "").slice(0, 240) }]);
    }
    const result = transitioned.rowCount
      ? transitioned
      : await pool.query(`SELECT ${fields} FROM service_contracts WHERE signing_token_hash=$1`, [hash]);
    if (!result.rowCount) {
      res.status(404).json({ message: "Contract not found" });
      return;
    }
    const contract = result.rows[0];
    if (contract.status === "draft") {
      res.status(409).json({ message: "This agreement is still being completed" });
      return;
    }
    if (new Date(contract.tokenExpiresAt) < new Date() && contract.status !== "signed") {
      res.status(410).json({ message: "This signing link has expired" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(contract);
  });

  app.post("/api/public/contracts/:token/sign", signingLimiter, async (req, res) => {
    const parsed = signSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid signature" });
      return;
    }
    const hashOfToken = tokenHash(String(req.params.token));
    const lookup = await pool.query(`SELECT * FROM service_contracts WHERE signing_token_hash=$1`, [hashOfToken]);
    if (!lookup.rowCount) {
      res.status(404).json({ message: "Contract not found" });
      return;
    }
    const contract = lookup.rows[0];
    if (contract.status === "signed") {
      res.status(409).json({ message: "This contract is already signed" });
      return;
    }
    if (contract.status === "void" || new Date(contract.token_expires_at) < new Date()) {
      res.status(410).json({ message: "This contract can no longer be signed" });
      return;
    }
    const snapshot = { ...contract, ...parsed.data, signedAt: new Date().toISOString() };
    const hash = documentHash(snapshot);
    // The status predicate locks out later coverage edits; the terms predicate
    // rejects a signature calculated from coverage edited since the lookup.
    const signed = await pool.query(`UPDATE service_contracts SET status='signed',signer_name=$2,signer_title=$3,signer_email=$4,signature_text=$5,signature_consent=TRUE,signed_at=NOW(),signed_document_hash=$6,signed_ip_address=$7,signed_user_agent=$8,updated_at=NOW()
      WHERE id=$1 AND signing_token_hash=$9 AND status IN ('sent','viewed') AND token_expires_at > NOW()
        AND terms=$10::jsonb RETURNING id`,
      [contract.id, parsed.data.signerName, parsed.data.signerTitle, parsed.data.signerEmail.toLowerCase(), parsed.data.signatureText, hash, ipFrom(req), String(req.headers["user-agent"] || "").slice(0, 500), hashOfToken, JSON.stringify(contract.terms)]);
    if (!signed.rowCount) {
      res.status(409).json({ message: "This signing link is no longer available" });
      return;
    }
    await pool.query(`INSERT INTO service_contract_events(contract_id,event_type,actor_type,actor_identity,metadata) VALUES($1,'signed','signer',$2,$3)`, [contract.id, parsed.data.signerEmail.toLowerCase(), { documentHash: hash }]);
    res.json({ status: "signed", signedAt: new Date().toISOString(), documentHash: hash });
  });
}