import type { Response } from "express";

/**
 * Tiny in-process SSE event bus for CRM pipeline changes.
 *
 * The pipeline routes in `server/routes/crm.ts` call `publishPipelineEvent`
 * whenever a deal is created, moved between stages, or deleted. Connected
 * EventSource clients (the Pipeline board and its live stat badges) refresh
 * immediately instead of polling.
 *
 * Kept intentionally minimal — same pattern as `server/a2p-events.ts`:
 * no Redis, no fanout, no message replay. Single-process is fine because the
 * mutations and the HTTP server share the same Node process.
 */

export type PipelineEvent = {
  type: "deal_created" | "deal_updated" | "deal_stage_changed" | "deal_deleted" | "deal_linked";
  dealId: number;
  stage?: string;
};

type SseClient = {
  id: number;
  res: Response;
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

export function addPipelineEventClient(res: Response): () => void {
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

  const client: SseClient = { id: nextClientId++, res };
  clients.add(client);

  // Heartbeat every 25s so proxies don't close the idle stream and the
  // client can detect a dead connection.
  const heartbeat = setInterval(() => {
    if (!safeWrite(res, `: ping\n\n`)) {
      cleanup();
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
    try {
      res.end();
    } catch {
      // socket already closed — nothing to do
    }
  };

  return cleanup;
}

export function publishPipelineEvent(event: PipelineEvent): void {
  if (clients.size === 0) return;
  const payload = `event: pipeline\ndata: ${JSON.stringify({
    ...event,
    at: new Date().toISOString(),
  })}\n\n`;
  for (const client of Array.from(clients)) {
    if (!safeWrite(client.res, payload)) {
      clients.delete(client);
    }
  }
}

export function pipelineEventClientCount(): number {
  return clients.size;
}
