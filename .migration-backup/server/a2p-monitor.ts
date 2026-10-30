import { promises as fs } from "fs";
import path from "path";
import sgMail from "@sendgrid/mail";
import { storage } from "./storage";
import { getA2PStatus, collectFailureReasons, type A2PStatus, type A2PStatusResult } from "./a2p-status";
import { publishA2PStatusChange, fingerprintA2PResult } from "./a2p-events";

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Test seam: allow tests to swap out the Twilio status fetcher, the storage
// singleton, and the SendGrid client without touching prod call sites. In
// production these always reference the real imports above.
interface MonitorDeps {
  getA2PStatus: typeof getA2PStatus;
  storage: typeof storage;
  sgMail: typeof sgMail;
}
const deps: MonitorDeps = { getA2PStatus, storage, sgMail };
export function __setA2PMonitorDepsForTests(overrides: Partial<MonitorDeps> | null): void {
  if (!overrides) {
    deps.getA2PStatus = getA2PStatus;
    deps.storage = storage;
    deps.sgMail = sgMail;
    return;
  }
  Object.assign(deps, overrides);
}

const STATE_FILE = path.join(process.cwd(), ".local", "a2p-monitor-state.json");
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly
// Don't re-page the owner more than once a day for the same persistent
// rejection. Twilio reviews can take 24-48h, so spamming is unhelpful.
const REALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Require the same `failed` (lookup) verdict twice in a row before paging, so
// a single transient Twilio API hiccup doesn't fire a high-priority alert.
const LOOKUP_FAILURE_THRESHOLD = 2;

type AlertKind = "rejected" | "lookup_failed";

interface MonitorState {
  lastStatus: A2PStatus | null;
  lastAlertAt: string | null;
  lastAlertKind: AlertKind | null;
  consecutiveLookupFailures: number;
  // Owner-initiated snooze: while `Date.now() < snoozeUntil`, the monitor
  // will not create new alert rows and will not send notification email.
  // Cleared by an explicit unsnooze, by the timestamp passing, or when
  // Twilio reports a healthy recovery.
  snoozeUntil: string | null;
  snoozeStartedAt: string | null;
  snoozeStartedBy: string | null;
  // Fingerprint of the last status payload we pushed over SSE. Used to
  // suppress duplicate "status changed" pushes when Twilio returns the
  // same verdict + rejection set as last cycle.
  lastFingerprint: string | null;
}

const EMPTY_STATE: MonitorState = {
  lastStatus: null,
  lastAlertAt: null,
  lastAlertKind: null,
  consecutiveLookupFailures: 0,
  snoozeUntil: null,
  snoozeStartedAt: null,
  snoozeStartedBy: null,
  lastFingerprint: null,
};

async function loadState(): Promise<MonitorState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<MonitorState>;
    return {
      lastStatus: (parsed.lastStatus as A2PStatus) || null,
      lastAlertAt: parsed.lastAlertAt || null,
      lastAlertKind: (parsed.lastAlertKind as AlertKind) || null,
      consecutiveLookupFailures: parsed.consecutiveLookupFailures || 0,
      snoozeUntil: parsed.snoozeUntil || null,
      snoozeStartedAt: parsed.snoozeStartedAt || null,
      snoozeStartedBy: parsed.snoozeStartedBy || null,
      lastFingerprint: parsed.lastFingerprint || null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function isSnoozeActive(state: Pick<MonitorState, "snoozeUntil">): boolean {
  if (!state.snoozeUntil) return false;
  const until = Date.parse(state.snoozeUntil);
  if (Number.isNaN(until)) return false;
  return Date.now() < until;
}

export interface A2PSnoozeStatus {
  active: boolean;
  snoozeUntil: string | null;
  snoozeStartedAt: string | null;
  snoozeStartedBy: string | null;
}

export async function getA2PSnoozeStatus(): Promise<A2PSnoozeStatus> {
  const state = await loadState();
  const active = isSnoozeActive(state);
  return {
    active,
    snoozeUntil: active ? state.snoozeUntil : null,
    snoozeStartedAt: active ? state.snoozeStartedAt : null,
    snoozeStartedBy: active ? state.snoozeStartedBy : null,
  };
}

const MAX_SNOOZE_HOURS = 72;

export async function snoozeA2PAlerts(
  hours: number,
  startedBy: string | null,
): Promise<A2PSnoozeStatus> {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("Snooze duration must be a positive number of hours");
  }
  const clamped = Math.min(hours, MAX_SNOOZE_HOURS);
  const now = new Date();
  const until = new Date(now.getTime() + clamped * 60 * 60 * 1000);
  const state = await loadState();
  const next: MonitorState = {
    ...state,
    snoozeUntil: until.toISOString(),
    snoozeStartedAt: now.toISOString(),
    snoozeStartedBy: startedBy,
  };
  await saveState(next);
  console.log(
    `[a2p-monitor] alerts snoozed for ${clamped}h (until ${next.snoozeUntil})` +
      (startedBy ? ` by ${startedBy}` : ""),
  );
  return {
    active: true,
    snoozeUntil: next.snoozeUntil,
    snoozeStartedAt: next.snoozeStartedAt,
    snoozeStartedBy: next.snoozeStartedBy,
  };
}

export async function clearA2PSnooze(): Promise<A2PSnoozeStatus> {
  const state = await loadState();
  if (!state.snoozeUntil && !state.snoozeStartedAt) {
    return { active: false, snoozeUntil: null, snoozeStartedAt: null, snoozeStartedBy: null };
  }
  const next: MonitorState = {
    ...state,
    snoozeUntil: null,
    snoozeStartedAt: null,
    snoozeStartedBy: null,
  };
  await saveState(next);
  console.log("[a2p-monitor] snooze cleared");
  return { active: false, snoozeUntil: null, snoozeStartedAt: null, snoozeStartedBy: null };
}

async function saveState(state: MonitorState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("[a2p-monitor] failed to persist state:", (err as Error)?.message);
  }
}

function appBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return process.env.APP_BASE_URL || "http://localhost:5000";
}

function ownerEmail(): string | null {
  // Only use addresses explicitly designated as a recipient. We deliberately
  // do NOT fall back to MAIL_FROM/CSD_FROM_EMAIL since those typically point
  // to a no-reply sender mailbox and alerts would go unread.
  return (
    process.env.A2P_ALERT_EMAIL ||
    process.env.CSD_ADMIN_EMAIL ||
    null
  );
}

async function sendOwnerEmail(subject: string, body: string): Promise<boolean> {
  const to = ownerEmail();
  if (!to) {
    console.log("[a2p-monitor] no owner email configured; skipping email notification");
    return false;
  }
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[a2p-monitor] SendGrid not configured — would email ${to}: ${subject}`);
    return false;
  }
  const from = {
    email: process.env.MAIL_FROM || process.env.CSD_FROM_EMAIL || "no-reply@csdpro.com",
    name: process.env.MAIL_FROM_NAME || process.env.CSD_FROM_NAME || "RMM Platform",
  };
  try {
    await deps.sgMail.send({
      to,
      from,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    });
    return true;
  } catch (err) {
    console.error("[a2p-monitor] email send failed:", (err as Error)?.message);
    return false;
  }
}

function buildAlertContent(
  result: A2PStatusResult,
  kind: AlertKind,
): { title: string; description: string; body: string; severity: "high" } {
  const reasons = collectFailureReasons(result);
  const reasonText = reasons.length > 0 ? reasons.join("\n- ") : "No specific reason returned by Twilio.";
  const link = `${appBaseUrl()}/messages`;
  const headline =
    kind === "rejected"
      ? "A2P 10DLC registration was rejected"
      : "A2P 10DLC status check is failing";
  const impactLine =
    kind === "rejected"
      ? "Outbound SMS may be blocked by carriers with error 30034 until this is resolved."
      : "We can't confirm A2P 10DLC status from Twilio. Outbound SMS may be affected — please verify in the Twilio console.";
  const description =
    `${headline}. ${impactLine}\n\n` +
    `Failure details:\n- ${reasonText}\n\n` +
    `Open the Messages page to review and re-submit: ${link}`;
  const body =
    `${headline}.\n\n` +
    `${impactLine}\n\n` +
    `Failure details:\n- ${reasonText}\n\n` +
    `Review and fix: ${link}\n`;
  const severity = "high" as const;
  return { title: headline, description, body, severity };
}

async function autoResolveOpenA2PAlerts(
  previousStatus: A2PStatus | null,
  currentStatus: A2PStatus,
): Promise<void> {
  let openAlerts: Awaited<ReturnType<typeof storage.getActiveAlerts>> = [];
  try {
    const active = await deps.storage.getActiveAlerts();
    openAlerts = active.filter((a) => a.alertSource === "a2p-monitor");
  } catch (err) {
    console.error("[a2p-monitor] failed to fetch active alerts for recovery:", (err as Error)?.message);
    return;
  }
  if (openAlerts.length === 0) return;

  const resolvedAt = new Date();
  let resolvedCount = 0;
  for (const alert of openAlerts) {
    try {
      await deps.storage.updateAlert(alert.id, {
        status: "resolved",
        resolvedAt,
      });
      resolvedCount += 1;
    } catch (err) {
      console.error(`[a2p-monitor] failed to auto-resolve alert ${alert.id}:`, (err as Error)?.message);
    }
  }
  if (resolvedCount === 0) return;
  console.log(`[a2p-monitor] auto-resolved ${resolvedCount} open A2P alert(s)`);

  const headline = "A2P 10DLC registration is healthy again";
  const link = `${appBaseUrl()}/messages`;
  const body =
    `${headline}.\n\n` +
    `Twilio now reports status: ${currentStatus} (previously ${previousStatus ?? "unknown"}).\n` +
    `Outbound texting should be flowing through the approved campaign again.\n\n` +
    `${resolvedCount} open A2P alert${resolvedCount === 1 ? "" : "s"} ` +
    `${resolvedCount === 1 ? "was" : "were"} auto-resolved.\n\n` +
    `Review: ${link}\n`;
  await sendOwnerEmail(`[RMM] ${headline}`, body);
}

function shouldFireAlert(
  state: MonitorState,
  kind: AlertKind,
): boolean {
  // Always fire if we've never alerted, or if the kind changed (e.g. it went
  // from lookup_failed to a real rejection — that's a new piece of info).
  if (!state.lastAlertAt || state.lastAlertKind !== kind) return true;
  const last = Date.parse(state.lastAlertAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= REALERT_COOLDOWN_MS;
}

/**
 * Run one polling cycle. Exported so tests / manual triggers can call it.
 */
export async function runA2PMonitorOnce(): Promise<void> {
  let result: A2PStatusResult;
  try {
    result = await deps.getA2PStatus();
  } catch (err) {
    console.error("[a2p-monitor] status lookup threw:", (err as Error)?.message);
    return;
  }

  const state = await loadState();
  const nextState: MonitorState = { ...state, lastStatus: result.status };

  // Push to any connected Messages page banners as soon as the
  // verdict/rejection set changes. Done before the alerting branches so a
  // status flip surfaces in the UI even on a cycle where we suppress an
  // alert (snooze active, cooldown active, etc.).
  const fingerprint = fingerprintA2PResult(result);
  if (fingerprint !== state.lastFingerprint) {
    nextState.lastFingerprint = fingerprint;
    try {
      publishA2PStatusChange(result);
    } catch (err) {
      console.error("[a2p-monitor] failed to publish status change:", (err as Error)?.message);
    }
  }

  if (!result.configured) {
    // Twilio isn't wired yet — there's nothing meaningful to alert on.
    nextState.consecutiveLookupFailures = 0;
    await saveState(nextState);
    return;
  }

  // The helper conflates "registration was actually rejected/failed by Twilio"
  // with "we couldn't reach Twilio to ask" — both surface as a bad status. We
  // split them so a transient API blip doesn't open a high-priority alert.
  // - `rejected` is always real rejection (brand SUSPENDED/FAILED or campaign
  //   FAILED based on response data).
  // - `failed` only when `result.error` is set means an upstream lookup error.
  const isRealRejection = result.status === "rejected";
  const isLookupFailure = result.status === "failed" && Boolean(result.error);

  let alertKind: AlertKind | null = null;
  if (isRealRejection) {
    alertKind = "rejected";
    nextState.consecutiveLookupFailures = 0;
  } else if (isLookupFailure) {
    nextState.consecutiveLookupFailures = state.consecutiveLookupFailures + 1;
    if (nextState.consecutiveLookupFailures >= LOOKUP_FAILURE_THRESHOLD) {
      alertKind = "lookup_failed";
    } else {
      console.log(
        `[a2p-monitor] transient lookup failure (${nextState.consecutiveLookupFailures}/${LOOKUP_FAILURE_THRESHOLD}); not alerting yet`,
      );
    }
  } else {
    // Anything that isn't a real rejection or a lookup failure: this could
    // be a true recovery (`approved`/`pending`) OR an indeterminate state
    // like `not_registered`. Only the explicit healthy verdicts should
    // close out an open A2P alert — otherwise we'd send a "healthy again"
    // email when registration is actually missing.
    // Only an explicit `approved` from Twilio counts as recovery — `pending`
    // shows up during flaps (rejected -> pending -> rejected) and would
    // otherwise reset cooldowns and clear an owner-initiated snooze,
    // re-paging during the exact scenario snooze is meant to silence.
    const isHealthyRecovery = result.status === "approved";
    const hadDegradedState = state.consecutiveLookupFailures > 0 || Boolean(state.lastAlertKind);

    if (isHealthyRecovery) {
      if (hadDegradedState) {
        console.log(`[a2p-monitor] status recovered: ${state.lastStatus ?? "unknown"} -> ${result.status}`);
        await autoResolveOpenA2PAlerts(state.lastStatus, result.status);
      }
      nextState.consecutiveLookupFailures = 0;
      nextState.lastAlertKind = null;
      // Clear the cooldown timestamp too so a future regression can re-alert
      // immediately instead of being suppressed by the previous incident.
      nextState.lastAlertAt = null;
      // The incident is over — drop any owner snooze so future regressions
      // page immediately instead of being silenced by stale mute state.
      if (state.snoozeUntil || state.snoozeStartedAt) {
        console.log("[a2p-monitor] clearing snooze on healthy recovery");
        nextState.snoozeUntil = null;
        nextState.snoozeStartedAt = null;
        nextState.snoozeStartedBy = null;
      }
    } else {
      // Non-healthy, non-failing status (e.g. `not_registered`). Reset the
      // lookup-failure streak (the lookup itself worked) but leave any
      // open alert and cooldown in place — nothing has actually recovered.
      nextState.consecutiveLookupFailures = 0;
      if (state.lastAlertKind) {
        console.log(
          `[a2p-monitor] status is "${result.status}" (was "${state.lastStatus ?? "unknown"}"); ` +
          `leaving open alert in place — not a confirmed recovery`,
        );
      }
    }
  }

  const snoozeActive = isSnoozeActive(state);
  if (alertKind && snoozeActive) {
    console.log(
      `[a2p-monitor] suppressing ${alertKind} alert — snoozed until ${state.snoozeUntil}`,
    );
  }

  if (alertKind && !snoozeActive && shouldFireAlert(state, alertKind)) {
    const { title, description, body, severity } = buildAlertContent(result, alertKind);
    let alertCreated = false;
    try {
      await deps.storage.createAlert({
        title,
        description,
        severity,
        category: "messaging",
        status: "active",
        alertSource: "a2p-monitor",
        businessImpact: "high",
        isEmergency: false,
      });
      alertCreated = true;
    } catch (err) {
      console.error("[a2p-monitor] failed to create alert record:", (err as Error)?.message);
    }
    const emailed = await sendOwnerEmail(`[RMM] ${title}`, body);
    // Only start the 24h cooldown if at least one channel actually
    // delivered. Otherwise we'd suppress retries even though the owner was
    // never notified.
    if (alertCreated || emailed) {
      nextState.lastAlertAt = new Date().toISOString();
      nextState.lastAlertKind = alertKind;
      console.log(`[a2p-monitor] alert fired (${alertKind}): ${state.lastStatus ?? "unknown"} -> ${result.status}`);
    } else {
      console.error(`[a2p-monitor] alert (${alertKind}) attempted but no channel delivered; will retry next cycle`);
    }
  } else if (alertKind && !snoozeActive) {
    // Cooldown-suppression log. The snooze case is already logged above,
    // so we only reach here when shouldFireAlert returned false. Guard
    // against a missing/invalid lastAlertAt (in theory shouldFireAlert
    // would have returned true in that case, but the formatter shouldn't
    // be the thing that crashes the monitor cycle either way).
    const lastAt = state.lastAlertAt ? Date.parse(state.lastAlertAt) : NaN;
    const untilStr = Number.isFinite(lastAt)
      ? new Date(lastAt + REALERT_COOLDOWN_MS).toISOString()
      : "unknown";
    console.log(
      `[a2p-monitor] suppressing repeat ${alertKind} alert (cooldown active until ${untilStr})`,
    );
  }

  await saveState(nextState);
}

let started = false;

/**
 * Start the background poller. Safe to call multiple times — only the first
 * call schedules the interval.
 */
export function startA2PMonitor(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (started) return;
  started = true;
  // Stagger initial run so it doesn't fight other startup work.
  setTimeout(() => {
    runA2PMonitorOnce().catch((err) =>
      console.error("[a2p-monitor] initial run failed:", (err as Error)?.message),
    );
  }, 30_000);
  setInterval(() => {
    runA2PMonitorOnce().catch((err) =>
      console.error("[a2p-monitor] scheduled run failed:", (err as Error)?.message),
    );
  }, intervalMs);
  console.log(`[a2p-monitor] started, polling every ${Math.round(intervalMs / 1000)}s`);
}
