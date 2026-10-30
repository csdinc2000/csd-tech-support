/**
 * Live-subscription logic for the A2P status banner on the Messages page.
 *
 * This is deliberately UI-free so it can be unit-tested without a DOM. The
 * banner component (`A2pStatusBanner` in `client/src/pages/messages.tsx`)
 * wires a real `EventSource` and React state setters into `subscribeA2PLive`;
 * tests drive it with a fake EventSource.
 *
 * Behaviour contract:
 *  - Opens the stream and flips the "live" indicator to connected once the
 *    server's `hello` (or native `onopen`) arrives.
 *  - Refreshes the banner when a `status` event arrives, instead of waiting
 *    for the 5-minute poll fallback that react-query keeps running.
 *  - On a connection error while the socket is not OPEN (reconnecting or
 *    gave up), flips the indicator back to "not connected" so the banner
 *    shows the poll-fallback mode. The native EventSource auto-reconnects and
 *    the poll covers any extended outage.
 *  - The returned cleanup closes the stream and prevents any late callbacks.
 */

/** EventSource.OPEN — the numeric readyState for an open stream. */
export const ES_READYSTATE_OPEN = 1;

/** Minimal EventSource surface used by the banner. */
export interface A2PEventSource {
  addEventListener(type: "status" | "hello", listener: () => void): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close(): void;
}

export interface SubscribeA2PLiveOptions {
  /** Factory for the stream. May throw if EventSource can't be constructed. */
  createEventSource: () => A2PEventSource;
  /** Called when a `status` event arrives — should refetch banner data. */
  onStatus: () => void;
  /** Called with the current live-connected state for the indicator. */
  onConnectedChange: (connected: boolean) => void;
  /** readyState value that means OPEN. Defaults to EventSource.OPEN (1). */
  openState?: number;
}

/**
 * Subscribe to the A2P status SSE stream. Returns a cleanup function that
 * closes the stream and suppresses any further callbacks (call on unmount).
 */
export function subscribeA2PLive(opts: SubscribeA2PLiveOptions): () => void {
  const openState = opts.openState ?? ES_READYSTATE_OPEN;
  let cancelled = false;
  let es: A2PEventSource | null = null;

  // Assume not-yet-connected until the server confirms the stream is live.
  opts.onConnectedChange(false);

  try {
    es = opts.createEventSource();
  } catch {
    // Couldn't even construct the stream — stay on the poll fallback.
    return () => {
      cancelled = true;
    };
  }

  const refresh = () => {
    if (cancelled) return;
    opts.onStatus();
  };
  es.addEventListener("status", refresh);

  // `hello` is sent immediately after the stream opens — a stronger signal
  // than `onopen` that bytes actually reached us (some proxies open the
  // socket but never forward data).
  es.addEventListener("hello", () => {
    if (!cancelled) opts.onConnectedChange(true);
  });
  es.onopen = () => {
    if (!cancelled) opts.onConnectedChange(true);
  };

  // Connection errors are non-fatal: EventSource reconnects on its own and
  // the poll covers extended outages. While not OPEN, show the poll-fallback
  // mode so the indicator is accurate.
  es.onerror = () => {
    if (cancelled) return;
    if (es && es.readyState !== openState) {
      opts.onConnectedChange(false);
    }
  };

  return () => {
    cancelled = true;
    try {
      es?.close();
    } catch {
      /* ignore */
    }
  };
}
