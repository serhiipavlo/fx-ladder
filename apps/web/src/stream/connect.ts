import { FX_SUBPROTOCOL } from '@fx/protocol';

import { createStreamCore, type StreamCore, type StreamEvent } from './core';

// The thin shell around the sans-I/O core: it owns the socket, the watchdog
// timer and the reconnect policy, and nothing else. Any resync event drops
// the connection — the fresh snapshot of the next one IS the recovery
// (ADR-08). Fixed 1 s retry for v0.1; backoff + jitter arrive with the
// close-code table in v0.2.

export type SocketState = 'connecting' | 'open' | 'closed';

export interface FeedStreamHandle {
  core: StreamCore;
  socketState(): SocketState;
  lastResync(): StreamEvent | null;
  close(): void;
}

const RECONNECT_MS = 1000;
const WATCHDOG_TICK_MS = 500;

export function connectFeedStream(url: string, onChange: () => void): FeedStreamHandle {
  const core = createStreamCore();
  let ws: WebSocket | null = null;
  let socketState: SocketState = 'connecting';
  let lastResync: StreamEvent | null = null;
  let closed = false;
  let reconnectTimer: number | null = null;

  const now = (): number => performance.now();

  function handleEvents(events: StreamEvent[]): void {
    const event = events[0];
    if (event === undefined) return;
    lastResync = event;
    ws?.close(); // onclose schedules the reconnect
    onChange();
  }

  function open(): void {
    if (closed) return;
    socketState = 'connecting';
    const socket = new WebSocket(url, FX_SUBPROTOCOL);
    ws = socket;
    socket.onopen = () => {
      socketState = 'open';
      onChange();
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      handleEvents(core.onMessage(event.data, now()));
      onChange();
    };
    socket.onclose = () => {
      ws = null;
      socketState = 'closed';
      onChange();
      if (!closed) reconnectTimer = window.setTimeout(open, RECONNECT_MS);
    };
    onChange();
  }

  const watchdog = window.setInterval(() => handleEvents(core.onTick(now())), WATCHDOG_TICK_MS);
  open();

  return {
    core,
    socketState: () => socketState,
    lastResync: () => lastResync,
    close() {
      closed = true;
      window.clearInterval(watchdog);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
