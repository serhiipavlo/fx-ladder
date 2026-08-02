// Wire protocol v1. The full frame model (SNAPSHOT/DELTA, records, seq
// semantics) lands with v0.1.0 (T-0.1.4); the skeleton needs the negotiated
// subprotocol name and the heartbeat frame.

/** WebSocket subprotocol negotiated at the /feed handshake (architecture §6.1). */
export const FX_SUBPROTOCOL = 'fx.v1';

/**
 * Frame header shape per architecture §6.1. A heartbeat carries no records:
 * `count` is 0 and `firstSeq` holds the last assigned seq so a silent channel
 * still proves both liveness and completeness (§6.3).
 */
export interface HeartbeatFrame {
  frameType: 'HEARTBEAT';
  count: 0;
  firstSeq: number;
  /** Milliseconds since server start (architecture §6.1). */
  serverTs: number;
}

export function heartbeatFrame(lastSeq: number, serverTs: number): HeartbeatFrame {
  return { frameType: 'HEARTBEAT', count: 0, firstSeq: lastSeq, serverTs };
}

export function encodeFrame(frame: HeartbeatFrame): string {
  return JSON.stringify(frame);
}
