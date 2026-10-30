import type { Response } from "express";
import type { A2PStatusResult } from "./a2p-status";

/**
 * Tiny in-process SSE event bus for A2P 10DLC status changes.
 *
 * The background monitor in `server/a2p-monitor.ts` calls
 * `publishA2PStatusChange` whenever it sees the verdict or rejection set
 * change. Connected EventSource clients on the Messages page get a `status`
 * event and refresh the banner immediately, instead of waiting up to 5
 * minutes for the next poll cycle.
 *
 * Kept intentionally minimal — no Redis, no fanout, no message replay.
 * Single-process is fine because the monitor and the HTTP server share the
 * same Node process; if that ever changes we'd swap this for a shared bus.
 */

type SseClient = {
  id: number;
  res: Response;
  cleanup: () => void;
};

const clients = new Set<SseClient>();
let nextClientId = 1;

function safeWrite(res: Response, payload: string): boolean {
  try {
    return res.write(payload);
  } catch {
    return false;
  }
}

export function addA2PEventClient(
  res: Response,
  heartbeatIntervalMs = 25_000,
): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // Flush headers so the browser actually opens the stream right away.
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as Response & { flushHeaders?: () => void }).flushHeaders!();
  }
  safeWrite(res, `retry: 10000\n\n`);
  safeWrite(res, `event: hello\ndata: {"ok":true}\n\n`);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cleanedUp = false;
  const client: SseClient = {
    id: nextClientId++,
    res,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat) clearInterval(heartbeat);
      clients.delete(client);
      try {
        res.end();
      } catch {
        // socket already closed — nothing to do
      }
    },
  };
  clients.add(client);

  // Heartbeat every 25s so proxies don't close the idle stream and the
  // client can detect a dead connection.
  heartbeat = setInterval(() => {
    if (!safeWrite(res, `: ping\n\n`)) {
      client.cleanup();
    }
  }, heartbeatIntervalMs);

  return client.cleanup;
}

/**
 * Deterministic fingerprint of the parts of an A2PStatusResult that the
 * banner actually renders. Used to decide whether to push an update.
 */
export function fingerprintA2PResult(result: A2PStatusResult): string {
  const brands = (result.brands || [])
    .map((b) => `${b.sid}:${b.status}:${b.failureReason || ""}`)
    .sort()
    .join("|");
  const campaigns = (result.campaigns || [])
    .map((c) => `${c.sid}:${c.campaignStatus}:${c.failureReason || ""}`)
    .sort()
    .join("|");
  const rejections = (result.bundleRejections || [])
    .map((r) => `${r.bundleSid}:${r.section}:${r.field || ""}:${r.failureReason}`)
    .sort()
    .join("|");
  return [result.status, result.error || "", brands, campaigns, rejections].join("##");
}

export function publishA2PStatusChange(result: A2PStatusResult): void {
  if (clients.size === 0) return;
  const payload = `event: status\ndata: ${JSON.stringify({
    status: result.status,
    at: new Date().toISOString(),
  })}\n\n`;
  for (const client of Array.from(clients)) {
    if (!safeWrite(client.res, payload)) {
      client.cleanup();
    }
  }
}

export function a2pEventClientCount(): number {
  return clients.size;
}
