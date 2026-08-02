import { FX_SUBPROTOCOL } from '@fx/protocol';

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

export interface FeedStreamHandle {
  core: StreamCore;
  socketState(): SocketState;
  lastResync(): StreamEvent | null;
  /** Last server-judged close; null after a healthy open. */
  lastClose(): CloseInfo | null;
  /** True when the policy said stop — resume() is the only way back. */
  terminal(): boolean;
  /** Manual restart after a terminal close (the "continue" affordance). */
  resume(): void;
  close(): void;
}

/** Self-initiated resync closes skip the table and come back quickly. */
const RESYNC_RETRY_MS = 250;
const WATCHDOG_TICK_MS = 500;

export function connectFeedStream(url: string, onChange: () => void): FeedStreamHandle {
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

  const now = (): number => performance.now();

  function scheduleOpen(delayMs: number): void {
    reconnectTimer = window.setTimeout(open, delayMs);
  }

  function handleEvents(events: StreamEvent[]): void {
    const event = events[0];
    if (event === undefined) return;
    lastResync = event;
    resyncing = true; // our own deliberate drop — not the server's ending
    ws?.close();
    onChange();
  }

  function open(): void {
    if (closed) return;
    socketState = 'connecting';
    const socket = new WebSocket(url, FX_SUBPROTOCOL);
    ws = socket;
    socket.onopen = () => {
      socketState = 'open';
      attempt = 0;
      lastClose = null;
      onChange();
    };
    socket.onmessage = (event: MessageEvent<string>) => {
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
  }

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
    close() {
      closed = true;
      window.clearInterval(watchdog);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
