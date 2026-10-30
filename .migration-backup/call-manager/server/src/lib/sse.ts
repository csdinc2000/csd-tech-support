import type { Response } from 'express';

interface Client {
  id: number;
  res: Response;
  userId: string;
}

const clients = new Set<Client>();
let nextId = 1;

export function addSseClient(res: Response, userId: string): () => void {
  const id = nextId++;
  const client: Client = { id, res, userId };
  clients.add(client);

  // Heartbeat keeps proxies from closing the connection
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, 25_000);

  function cleanup() {
    clearInterval(heartbeat);
    clients.delete(client);
    try { res.end(); } catch { /* noop */ }
  }

  res.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

export function broadcastSse(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}
