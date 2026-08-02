import { z } from 'zod';

// Wire protocol v1 (architecture §6.1–6.3): frames, not messages. A frame is
// a small header plus an array of same-shaped records; every record is a full
// upsert of one book level, so applying it twice is safe and applying only
// the last of several is legal. Sequence numbers are dense on the wire by
// construction — assembleFrame assigns them as the last step before encoding
// (§6.2), which is what makes the client's gap detector arithmetic, not
// heuristic.

/** WebSocket subprotocol negotiated at the /feed handshake (architecture §6.1). */
export const FX_SUBPROTOCOL = 'fx.v1';

export type FrameType = 'SNAPSHOT' | 'DELTA' | 'HEARTBEAT';

/** A level upsert before sequencing — what the simulator emits (§6.2). */
export interface LevelUpdate {
  pairId: number;
  side: 'bid' | 'ask';
  level: number;
  /** Integer pipettes (ADR-06). */
  price: number;
  /** Thousands of base; 0 = the level disappeared (§6.1). */
  size: number;
}

/** A level upsert as it rides the wire: sequenced. */
export interface WireRecord extends LevelUpdate {
  seq: number;
}

export interface Frame {
  frameType: FrameType;
  /** Number of records in this frame. */
  count: number;
  /** seq of the first record; in a heartbeat — the last assigned seq (§6.3). */
  firstSeq: number;
  /** Milliseconds since server start. */
  serverTs: number;
  records: WireRecord[];
}

const wireRecordSchema = z.strictObject({
  pairId: z.number().int().min(0),
  side: z.enum(['bid', 'ask']),
  level: z.number().int().min(0),
  price: z.number().int().positive(),
  size: z.number().int().min(0),
  seq: z.number().int().min(0),
});

const frameEnvelopeSchema = z.strictObject({
  frameType: z.string(),
  count: z.number().int().min(0),
  firstSeq: z.number().int().min(0),
  serverTs: z.number().int().min(0),
  records: z.array(wireRecordSchema),
});

const KNOWN_FRAME_TYPES: readonly string[] = ['SNAPSHOT', 'DELTA', 'HEARTBEAT'];

/**
 * Assign dense sequence numbers and wrap records into a frame — the one and
 * only place seq is born, immediately before encoding (architecture §6.2).
 * Returns the frame plus the seq the next assembly must start from.
 */
export function assembleFrame(
  frameType: 'SNAPSHOT' | 'DELTA',
  updates: readonly LevelUpdate[],
  firstSeq: number,
  serverTs: number,
): { frame: Frame; nextSeq: number } {
  const records = updates.map((update, i) => ({ ...update, seq: firstSeq + i }));
  return {
    frame: { frameType, count: records.length, firstSeq, serverTs, records },
    nextSeq: firstSeq + records.length,
  };
}

/** Heartbeat: zero records, carries the last assigned seq so silence still proves completeness (§6.3). */
export function heartbeatFrame(lastSeq: number, serverTs: number): Frame {
  return { frameType: 'HEARTBEAT', count: 0, firstSeq: lastSeq, serverTs, records: [] };
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Decode one wire frame. Throws on anything structurally invalid (malformed
 * JSON, bad envelope, count/seq inconsistencies — protocol-error territory,
 * close code 4002). Returns `null` for a well-formed frame of an unknown
 * type: new frame types do not bump the protocol version and old clients
 * skip them silently (§6.1).
 */
export function decodeFrame(text: string): Frame | null {
  const envelope = frameEnvelopeSchema.parse(JSON.parse(text));
  if (envelope.count !== envelope.records.length) {
    throw new Error(`count ${envelope.count} does not match ${envelope.records.length} records`);
  }
  for (let i = 0; i < envelope.records.length; i += 1) {
    const expected = envelope.firstSeq + i;
    if (envelope.records[i]!.seq !== expected) {
      throw new Error(`seq not dense: expected ${expected}, got ${envelope.records[i]!.seq} at index ${i}`);
    }
  }
  if (!KNOWN_FRAME_TYPES.includes(envelope.frameType)) return null;
  return envelope as Frame;
}
