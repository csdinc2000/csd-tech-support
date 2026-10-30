import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { registerServiceContractRoutes } from "./service-contracts";

const marker = `agreement-test-${process.pid}-${Date.now()}`;
const contractIds: number[] = [];
let clientId: number;
let server: Server;
let baseUrl: string;

const terms = {
  includedSupport: "Remote support is included.",
  deviceLimits: "Up to five devices.",
  onsiteWork: "Onsite work is separately billed.",
  backups: "Configured backups are monitored.",
};
const signature = {
  signerName: "Test Signer", signerTitle: "Owner", signerEmail: "signer@example.invalid",
  signatureText: "Test Signer", consent: true,
};

before(async () => {
  clientId = Number((await pool.query(
    "INSERT INTO clients(name,contact_email) VALUES($1,$2) RETURNING id",
    [marker, `${marker}@example.invalid`],
  )).rows[0].id);
  const app = express();
  app.use(express.json());
  registerServiceContractRoutes(app);
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (contractIds.length) await pool.query("DELETE FROM service_contracts WHERE id = ANY($1::int[])", [contractIds]);
  if (clientId) await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await pool.end();
});

async function post(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tokenFrom(path: unknown): string {
  assert.equal(typeof path, "string");
  assert.match(path as string, /^\/sign\/contract\/[A-Za-z0-9_-]{40,}$/);
  const token = (path as string).split("/").at(-1)!;
  assert.notEqual(token, "undefined");
  return token;
}

async function createAgreement() {
  const response = await post("/api/service-contracts", {
    clientId, annualValueCents: 12000, monthlyPaymentCents: 1000,
    effectiveDate: "2026-10-01", responseTimeSla: "One business day",
    supportHours: "Weekdays", terms,
  });
  assert.equal(response.status, 201, response.status === 201 ? undefined : await response.text());
  const data = await response.json() as { id: number; status: string; signingPath: unknown };
  contractIds.push(data.id);
  assert.equal(data.status, "sent");
  return { id: data.id as number, token: tokenFrom(data.signingPath) };
}

async function publicAgreement(token: string) {
  return fetch(`${baseUrl}/api/public/contracts/${token}`);
}

test("a fresh signing URL resolves, replacement revokes the old URL, and signing prevents another rotation", async () => {
  const { id, token } = await createAgreement();
  const fresh = await publicAgreement(token);
  assert.equal(fresh.status, 200, fresh.status === 200 ? undefined : await fresh.text());
  assert.equal(((await fresh.json()) as { id: number }).id, id);

  const replacement = await post(`/api/service-contracts/${id}/signing-link`);
  assert.equal(replacement.status, 200, replacement.status === 200 ? undefined : await replacement.text());
  const nextToken = tokenFrom(((await replacement.json()) as { signingPath: unknown }).signingPath);
  assert.notEqual(token, nextToken);
  assert.equal((await publicAgreement(token)).status, 404);
  const current = await publicAgreement(nextToken);
  assert.equal(current.status, 200, current.status === 200 ? undefined : await current.text());
  assert.equal(((await current.json()) as { id: number }).id, id);

  const signed = await post(`/api/public/contracts/${nextToken}/sign`, signature);
  assert.equal(signed.status, 200, signed.status === 200 ? undefined : await signed.text());
  assert.equal((await post(`/api/service-contracts/${id}/signing-link`)).status, 409);
  assert.equal((await publicAgreement(nextToken)).status, 200);
  assert.equal((await publicAgreement(token)).status, 404);
});

async function raceViewWith(action: "sign" | "replace") {
  const { id, token } = await createAgreement();
  const hash = createHash("sha256").update(token).digest("hex");
  let releaseView!: () => void;
  const viewGate = new Promise<void>((resolve) => { releaseView = resolve; });
  let updateReached!: () => void;
  const updateGate = new Promise<void>((resolve) => { updateReached = resolve; });
  const originalQuery = pool.query;
  const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<unknown>;
  let pauseUpdate = true;
  let viewTransitionRowCount: number | null = null;
  pool.query = (async (sql: string, values?: unknown[]) => {
    if (pauseUpdate && sql.startsWith("UPDATE service_contracts SET status='viewed'") && values?.[0] === hash) {
      pauseUpdate = false;
      updateReached();
      await viewGate;
      const result = await query(sql, values) as { rowCount: number };
      viewTransitionRowCount = result.rowCount;
      return result;
    }
    return query(sql, values);
  }) as typeof pool.query;
  let viewRequest: Promise<Response> | undefined;
  try {
    viewRequest = publicAgreement(token);
    await updateGate;
    const winningResponse = action === "sign"
      ? await post(`/api/public/contracts/${token}/sign`, signature)
      : await post(`/api/service-contracts/${id}/signing-link`);
    assert.equal(winningResponse.status, 200, winningResponse.status === 200 ? undefined : await winningResponse.text());
    const nextToken = action === "replace"
      ? tokenFrom(((await winningResponse.json()) as { signingPath: unknown }).signingPath)
      : null;
    releaseView();
    const viewResponse = await viewRequest;
    assert.equal(viewTransitionRowCount, 0, "The losing view must not transition the agreement");
    if (action === "sign") {
      assert.equal(viewResponse.status, 200);
      const contract = await viewResponse.json() as {
        id: number; status: string; signedAt: string; signatureText: string;
      };
      assert.equal(contract.id, id);
      assert.equal(contract.status, "signed");
      assert.ok(contract.signedAt);
      assert.equal(contract.signatureText, signature.signatureText);
      const signedState = (await pool.query(
        "SELECT status,signature_text FROM service_contracts WHERE id=$1", [id],
      )).rows[0];
      assert.equal(signedState.status, "signed");
      assert.equal(signedState.signature_text, signature.signatureText);
      const events = await pool.query(
        "SELECT event_type FROM service_contract_events WHERE contract_id=$1 ORDER BY id", [id],
      );
      assert.deepEqual(events.rows.map((event) => event.event_type), ["sent", "signed"]);
    } else {
      assert.equal(viewResponse.status, 404);
    }
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM service_contract_events WHERE contract_id=$1 AND event_type='viewed'",
      [id],
    )).rows[0].count, 0);
    if (nextToken) {
      const freshView = await publicAgreement(nextToken);
      assert.equal(freshView.status, 200);
      assert.equal(((await freshView.json()) as { status: string }).status, "viewed");
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM service_contract_events WHERE contract_id=$1 AND event_type='viewed'",
        [id],
      )).rows[0].count, 1);
    }
  } finally {
    releaseView();
    pool.query = originalQuery;
    if (viewRequest) await viewRequest;
  }
}

test("a signing-page GET cannot mark a concurrently signed agreement as viewed", async () => {
  await raceViewWith("sign");
});

test("a signing-page GET cannot mark a concurrently replaced link as viewed", async () => {
  await raceViewWith("replace");
});

test("a concurrent signature and link replacement cannot leave a signed agreement with a rotated token", async () => {
  const { id, token } = await createAgreement();
  const oldHash = createHash("sha256").update(token).digest("hex");
  let releaseSign!: () => void;
  const signGate = new Promise<void>((resolve) => { releaseSign = resolve; });
  let lookupSeen!: () => void;
  const lookupGate = new Promise<void>((resolve) => { lookupSeen = resolve; });
  const originalQuery = pool.query;
  const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<unknown>;
  pool.query = (async (sql: string, values?: unknown[]) => {
    const result = await query(sql, values);
    if (sql.startsWith("SELECT * FROM service_contracts WHERE signing_token_hash=") && values?.[0] === oldHash) {
      lookupSeen();
      await signGate;
    }
    return result;
  }) as typeof pool.query;
  let signRequest: Promise<Response> | undefined;
  try {
    signRequest = post(`/api/public/contracts/${token}/sign`, signature);
    await lookupGate;
    const rotateResponse = await post(`/api/service-contracts/${id}/signing-link`);
    assert.equal(rotateResponse.status, 200, rotateResponse.status === 200 ? undefined : await rotateResponse.text());
    const nextToken = tokenFrom(((await rotateResponse.json()) as { signingPath: unknown }).signingPath);
    releaseSign();
    const signResponse = await signRequest;
    assert.equal(signResponse.status, 409, signResponse.status === 409 ? undefined : await signResponse.text());
    const state = (await pool.query(
      "SELECT status, signing_token_hash FROM service_contracts WHERE id=$1",
      [id],
    )).rows[0];
    assert.equal(state.status, "sent");
    assert.equal(state.signing_token_hash, createHash("sha256").update(nextToken).digest("hex"));
    assert.equal((await publicAgreement(token)).status, 404);
    assert.equal((await publicAgreement(nextToken)).status, 200);
  } finally {
    releaseSign();
    pool.query = originalQuery;
    if (signRequest) await signRequest;
  }
});

test("a concurrent incomplete coverage edit prevents a draft from receiving a signing link", async () => {
  const { id, token } = await createAgreement();
  // Start with complete coverage on a draft: the state after staff completes
  // an initially incomplete agreement, before sending its first signing link.
  await pool.query("UPDATE service_contracts SET status='draft',sent_at=NULL WHERE id=$1", [id]);
  const beforeRotation = (await pool.query(
    "SELECT status,signing_token_hash,token_expires_at,sent_at FROM service_contracts WHERE id=$1", [id],
  )).rows[0];
  const incompleteTerms = { ...terms, deviceLimits: "To be completed before sending." };
  let releaseRotation!: () => void;
  const rotationGate = new Promise<void>((resolve) => { releaseRotation = resolve; });
  let updateReached!: () => void;
  const updateGate = new Promise<void>((resolve) => { updateReached = resolve; });
  const originalQuery = pool.query;
  const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<unknown>;
  let pauseUpdate = true;
  pool.query = (async (sql: string, values?: unknown[]) => {
    if (pauseUpdate && sql.includes("SET signing_token_hash=$2") && values?.[0] === id) {
      pauseUpdate = false;
      updateReached();
      await rotationGate;
    }
    return query(sql, values);
  }) as typeof pool.query;
  let rotationRequest: Promise<Response> | undefined;
  try {
    rotationRequest = post(`/api/service-contracts/${id}/signing-link`);
    // The route has read and checked complete coverage, but not rotated yet.
    await updateGate;
    const editResponse = await patch(`/api/service-contracts/${id}`, { terms: incompleteTerms });
    assert.equal(editResponse.status, 200, editResponse.status === 200 ? undefined : await editResponse.text());
    releaseRotation();
    const rotationResponse = await rotationRequest;
    assert.equal(rotationResponse.status, 409, rotationResponse.status === 409 ? undefined : await rotationResponse.text());
    assert.equal((await rotationResponse.json() as { signingPath?: string }).signingPath, undefined);
    const state = (await pool.query(
      "SELECT status,signing_token_hash,token_expires_at,sent_at,terms FROM service_contracts WHERE id=$1", [id],
    )).rows[0];
    assert.deepEqual(state, { ...beforeRotation, terms: incompleteTerms });
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM service_contract_events WHERE contract_id=$1 AND event_type='signing_link_regenerated'", [id],
    )).rows[0].count, 0);
    assert.equal((await publicAgreement(token)).status, 409);
    assert.equal((await post(`/api/service-contracts/${id}/signing-link`)).status, 409);

    const repair = await patch(`/api/service-contracts/${id}`, { terms });
    assert.equal(repair.status, 200);
    const retry = await post(`/api/service-contracts/${id}/signing-link`);
    assert.equal(retry.status, 200, retry.status === 200 ? undefined : await retry.text());
    const nextToken = tokenFrom((await retry.json() as { signingPath: unknown }).signingPath);
    assert.notEqual(nextToken, token);
    assert.equal((await publicAgreement(token)).status, 404);
    assert.equal((await publicAgreement(nextToken)).status, 200);
  } finally {
    releaseRotation();
    pool.query = originalQuery;
    if (rotationRequest) await rotationRequest;
  }
});

test("a coverage edit during signing cannot leave a signed record with stale terms", async () => {
  const { id, token } = await createAgreement();
  const signingTokenHash = createHash("sha256").update(token).digest("hex");
  const editedTerms = { ...terms, deviceLimits: "Up to ten devices." };
  let releaseSign!: () => void;
  const signGate = new Promise<void>((resolve) => { releaseSign = resolve; });
  let lookupSeen!: () => void;
  const lookupGate = new Promise<void>((resolve) => { lookupSeen = resolve; });
  const originalQuery = pool.query;
  const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<unknown>;
  let pauseLookup = true;
  pool.query = (async (sql: string, values?: unknown[]) => {
    const result = await query(sql, values);
    if (pauseLookup && sql.startsWith("SELECT * FROM service_contracts WHERE signing_token_hash=") && values?.[0] === signingTokenHash) {
      pauseLookup = false;
      lookupSeen();
      await signGate;
    }
    return result;
  }) as typeof pool.query;
  let signRequest: Promise<Response> | undefined;
  try {
    signRequest = post(`/api/public/contracts/${token}/sign`, signature);
    await lookupGate;
    const editResponse = await patch(`/api/service-contracts/${id}`, { terms: editedTerms });
    assert.equal(editResponse.status, 200, editResponse.status === 200 ? undefined : await editResponse.text());
    releaseSign();
    const signResponse = await signRequest;
    assert.equal(signResponse.status, 409, signResponse.status === 409 ? undefined : await signResponse.text());
    const state = (await pool.query(
      "SELECT status, terms, signed_document_hash FROM service_contracts WHERE id=$1", [id],
    )).rows[0];
    assert.equal(state.status, "sent");
    assert.deepEqual(state.terms, editedTerms);
    assert.equal(state.signed_document_hash, null);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM service_contract_events WHERE contract_id=$1 AND event_type='signed'", [id],
    )).rows[0].count, 0);

    const retry = await post(`/api/public/contracts/${token}/sign`, signature);
    assert.equal(retry.status, 200, retry.status === 200 ? undefined : await retry.text());
    const signed = (await pool.query(
      "SELECT status, terms, signed_document_hash FROM service_contracts WHERE id=$1", [id],
    )).rows[0];
    assert.equal(signed.status, "signed");
    assert.deepEqual(signed.terms, editedTerms);
    assert.equal(signed.signed_document_hash, (await retry.json() as { documentHash: string }).documentHash);
    assert.equal((await patch(`/api/service-contracts/${id}`, { terms })).status, 409);
  } finally {
    releaseSign();
    pool.query = originalQuery;
    if (signRequest) await signRequest;
  }
});