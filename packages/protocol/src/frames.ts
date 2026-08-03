import { z } from 'zod';

// Wire protocol v1 (architecture §6.1–6.3): frames, not messages. A frame is
// a small header plus an array of same-shaped records; every record is a full
// upsert of one book level, so applying it twice is safe and applying only
// the last of several is legal. Sequence numbers are dense on the wire by
// construction — assembleFrame assigns them as the last step before encoding
// (§6.2), which is what makes the client's gap detector arithmetic, not
// heuristic.

/** The JSON wire — v1 of the /feed subprotocol (architecture §6.1). */
export const FX_SUBPROTOCOL = 'fx.v1';

/** The binary wire — v2, fixed-length records over DataView (ADR-12). */
export const FX_SUBPROTOCOL_V2 = 'fx.v2';

/**
 * What a client offers at the handshake, best first: the server picks the
 * newest wire it speaks, and an old server that only knows v1 still answers.
 * Version negotiation is the subprotocol mechanism doing its actual job.
 */
export const PREFERRED_SUBPROTOCOLS: readonly string[] = [FX_SUBPROTOCOL_V2, FX_SUBPROTOCOL];

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

/** Runtime schema of one wire record — also feeds the generated API docs. */
export const wireRecordSchema = z.strictObject({
  pairId: z.number().int().min(0),
  side: z.enum(['bid', 'ask']),
  level: z.number().int().min(0),
  price: z.number().int().positive(),
  size: z.number().int().min(0),
  seq: z.number().int().min(0),
});

/** Runtime schema of the frame envelope — also feeds the generated API docs. */
export const frameEnvelopeSchema = z.strictObject({
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

// ---------------------------------------------------------------------------
// The binary wire — fx.v2 (ADR-12). Same frames, same semantics, a seventh of
// the bytes. Layout, all little-endian:
//
//   header, 16 bytes:
//     u8   wire version, always 2 — a loud guard, not a negotiator
//     u8   frameType: 0 SNAPSHOT · 1 DELTA · 2 HEARTBEAT
//     u16  count
//     u32  firstSeq
//     f64  serverTs
//   record, 12 bytes × count:
//     u8   pairId
//     u8   side: 0 bid · 1 ask
//     u8   level
//     u8   reserved, always 0
//     i32  price (integer pipettes, ADR-06)
//     u32  size (thousands of base; 0 = level gone)
//
// Per-record seq is NOT on the wire: v2 cannot even express a frame that is
// not dense — decode reconstructs `firstSeq + i`, which is §6.2 by
// construction and four bytes per record saved. Frame-to-frame density stays
// the client core's arithmetic, exactly as on v1.
// ---------------------------------------------------------------------------

const BINARY_VERSION = 2;
const HEADER_BYTES = 16;
const RECORD_BYTES = 12;
const FRAME_TYPE_CODES: readonly FrameType[] = ['SNAPSHOT', 'DELTA', 'HEARTBEAT'];

/** DataView truncates silently; a codec must be loud instead (§6.1 spirit). */
function checkRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} ${value} does not fit the fx.v2 wire ([${min}, ${max}])`);
  }
}

export function encodeFrameBinary(frame: Frame): ArrayBuffer {
  const typeCode = FRAME_TYPE_CODES.indexOf(frame.frameType);
  if (typeCode < 0) throw new Error(`unknown frame type: ${frame.frameType}`);
  checkRange('count', frame.count, 0, 0xffff);
  checkRange('firstSeq', frame.firstSeq, 0, 0xffff_ffff);

  const buffer = new ArrayBuffer(HEADER_BYTES + frame.records.length * RECORD_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, BINARY_VERSION);
  view.setUint8(1, typeCode);
  view.setUint16(2, frame.count, true);
  view.setUint32(4, frame.firstSeq, true);
  view.setFloat64(8, frame.serverTs, true);
  for (let i = 0; i < frame.records.length; i += 1) {
    const record = frame.records[i]!;
    checkRange('pairId', record.pairId, 0, 0xff);
    checkRange('level', record.level, 0, 0xff);
    checkRange('price', record.price, -0x8000_0000, 0x7fff_ffff);
    checkRange('size', record.size, 0, 0xffff_ffff);
    const at = HEADER_BYTES + i * RECORD_BYTES;
    view.setUint8(at, record.pairId);
    view.setUint8(at + 1, record.side === 'bid' ? 0 : 1);
    view.setUint8(at + 2, record.level);
    view.setUint8(at + 3, 0);
    view.setInt32(at + 4, record.price, true);
    view.setUint32(at + 8, record.size, true);
  }
  return buffer;
}

/**
 * Decode one binary frame. Throws on structural damage — wrong version byte,
 * a length that disagrees with `count`, a side byte that names no side
 * (protocol-error territory, close code 4002). Returns `null` for a
 * well-formed frame of an unknown type code, mirroring the v1 rule: new
 * frame types do not bump the wire version and old clients skip them.
 */
export function decodeFrameBinary(buffer: ArrayBuffer): Frame | null {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`frame shorter than its header: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== BINARY_VERSION) throw new Error(`wire version ${version} is not ${BINARY_VERSION}`);
  const typeCode = view.getUint8(1);
  const count = view.getUint16(2, true);
  const firstSeq = view.getUint32(4, true);
  const serverTs = view.getFloat64(8, true);
  if (buffer.byteLength !== HEADER_BYTES + count * RECORD_BYTES) {
    throw new Error(`count ${count} does not match ${buffer.byteLength} bytes`);
  }
  if (typeCode >= FRAME_TYPE_CODES.length) return null; // unknown type: skip silently
  const frameType = FRAME_TYPE_CODES[typeCode]!;

  const records: WireRecord[] = new Array<WireRecord>(count);
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_BYTES + i * RECORD_BYTES;
    const sideByte = view.getUint8(at + 1);
    if (sideByte > 1) throw new Error(`side byte ${sideByte} names no side at record ${i}`);
    records[i] = {
      pairId: view.getUint8(at),
      side: sideByte === 0 ? 'bid' : 'ask',
      level: view.getUint8(at + 2),
      price: view.getInt32(at + 4, true),
      size: view.getUint32(at + 8, true),
      // Density by construction: the wire cannot say otherwise (§6.2).
      seq: firstSeq + i,
    };
  }
  return { frameType, count, firstSeq, serverTs, records };
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
