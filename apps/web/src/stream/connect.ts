import { PREFERRED_SUBPROTOCOLS } from '@fx/protocol';

import { createStreamCore, type StreamCore, type StreamEvent } from './core';
import { reconnectDecision, type ReconnectDecision } from './reconnect';

// The thin shell around the sans-I/O core: it owns the socket, the watchdog
// timer and the reconnect policy, and nothing else. A resync event drops the
// connection deliberately — the fresh snapshot of the next one IS the
// recovery (ADR-08) — and that self-inflicted close bypasses the per-code
// table: the table judges the server's endings, not our own.

export type SocketState = 'connecting' | 'open' | 'closed';

export interface CloseInfo {
  code: number;
  reason: string;
  decision: ReconnectDecision;
}

/**
 * What the transport says about the connection. The store forwards every
 * member of this verbatim, so it is declared once here and extended twice —
 * by the handle below and by `FeedStore`.
 */
export interface FeedTransportView {
  core: StreamCore;
  socketState(): SocketState;
  lastResync(): StreamEvent | null;
  /** Last server-judged close; null after a healthy open. */
  lastClose(): CloseInfo | null;
  /** True when the policy said stop — resume() is the only way back. */
  terminal(): boolean;
  /** Manual restart after a terminal close (the "continue" affordance). */
  resume(): void;
  /** The subprotocol the server picked at the handshake; null before open. */
  wire(): string | null;
  close(): void;
}

export interface FeedStreamHandle extends FeedTransportView {
  /**
   * Change the offered subprotocols and reconnect deliberately — the demo's
   * live v2↔v1 contrast (ADR-12). The self-close rides the resync path: our
   * own drop, judged by nobody's close-code table.
   */
  setProtocols(protocols: readonly string[]): void;
}

/** Self-initiated resync closes skip the table and come back quickly. */
const RESYNC_RETRY_MS = 250;
const WATCHDOG_TICK_MS = 500;

/** Opens the feed socket and returns the handle that owns it. */
interface FeedStreamConnector {
  (url: string, onChange: () => void): FeedStreamHandle;
}

export const connectFeedStream: FeedStreamConnector = (url, onChange) => {
  const core = createStreamCore();
  let ws: WebSocket | null = null;
  let socketState: SocketState = 'connecting';
  let lastResync: StreamEvent | null = null;
  let lastClose: CloseInfo | null = null;
  let terminal = false;
  let resyncing = false;
  let attempt = 0;
  let closed = false;
  let reconnectTimer: number | null = null;
  let protocols: readonly string[] = PREFERRED_SUBPROTOCOLS;
  let wire: string | null = null;

  const now = (): number => performance.now();

  // `open` is referenced above its own definition, but only from inside these
  // bodies — by the time either runs, the const below is initialised.
  const scheduleOpen = (delayMs: number): void => {
    reconnectTimer = window.setTimeout(open, delayMs);
  };

  const handleEvents = (events: StreamEvent[]): void => {
    const event = events[0];
    if (event === undefined) return;
    lastResync = event;
    resyncing = true; // our own deliberate drop — not the server's ending
    ws?.close();
    onChange();
  };

  const open = (): void => {
    if (closed) return;
    socketState = 'connecting';
    const socket = new WebSocket(url, [...protocols]);
    socket.binaryType = 'arraybuffer'; // fx.v2 frames arrive as ArrayBuffer
    ws = socket;
    socket.onopen = () => {
      socketState = 'open';
      wire = socket.protocol; // what the server actually picked
      attempt = 0;
      lastClose = null;
      onChange();
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      handleEvents(core.onMessage(event.data, now()));
      onChange();
    };
    socket.onclose = (event: CloseEvent) => {
      ws = null;
      socketState = 'closed';
      if (closed) {
        onChange();
        return;
      }
      if (resyncing) {
        resyncing = false;
        scheduleOpen(RESYNC_RETRY_MS);
        onChange();
        return;
      }
      const decision = reconnectDecision(event.code, attempt, Math.random());
      lastClose = { code: event.code, reason: event.reason, decision };
      if (decision.action === 'retry') {
        attempt += 1;
        scheduleOpen(decision.delayMs ?? RESYNC_RETRY_MS);
      } else {
        terminal = true;
      }
      onChange();
    };
    onChange();
  };

  const watchdog = window.setInterval(() => handleEvents(core.onTick(now())), WATCHDOG_TICK_MS);
  open();

  return {
    core,
    socketState: () => socketState,
    lastResync: () => lastResync,
    lastClose: () => lastClose,
    terminal: () => terminal,
    resume() {
      if (closed || ws !== null) return;
      terminal = false;
      attempt = 0;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      open();
    },
    wire: () => wire,
    setProtocols(next) {
      protocols = next;
      if (closed || terminal) return;
      if (ws !== null) {
        // Our own deliberate drop: skip the close-code table, come back fast,
        // take the fresh snapshot — the ordinary recovery (ADR-08).
        resyncing = true;
        ws.close();
        return;
      }
      // Between attempts: the pending reopen will already use the new offer.
    },
    close() {
      closed = true;
      window.clearInterval(watchdog);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
};
