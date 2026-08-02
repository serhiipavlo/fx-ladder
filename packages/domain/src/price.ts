import type { Instrument } from './instruments';

// Prices are integers in pipettes everywhere except the render formatter
// (ADR-06). Parsing and formatting therefore work on decimal *strings* —
// no float ever touches a price.

function assertPrecision(precision: number): void {
  if (!Number.isInteger(precision) || precision < 1 || precision > 8) {
    throw new Error(`unsupported precision: ${precision}`);
  }
}

/**
 * Exact decimal-string → integer pipettes. Accepts up to `precision` fraction
 * digits (shorter fractions are zero-padded); rejects anything else loudly.
 */
export function toPipettes(price: string, precision: number): number {
  assertPrecision(precision);
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(price);
  if (m === null) throw new Error(`invalid price literal: "${price}"`);
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (frac.length > precision) {
    throw new Error(`"${price}" has more than ${precision} fraction digits`);
  }
  const value = Number(whole + frac.padEnd(precision, '0'));
  if (!Number.isSafeInteger(value)) throw new Error(`"${price}" is out of safe integer range`);
  return value;
}

/** Integer pipettes → canonical decimal string with exactly `precision` fraction digits. */
export function formatPrice(pipettes: number, precision: number): string {
  assertPrecision(precision);
  if (!Number.isSafeInteger(pipettes) || pipettes < 0) {
    throw new Error(`pipettes must be a non-negative safe integer, got ${pipettes}`);
  }
  const s = String(pipettes).padStart(precision + 1, '0');
  const cut = s.length - precision;
  return `${s.slice(0, cut)}.${s.slice(cut)}`;
}

/**
 * How many pipettes one pip is for this instrument — 10 for every pair in the
 * current catalogue (pipette = the digit one past the pip, §5.2).
 */
export function pipettesPerPip(instrument: Pick<Instrument, 'precision' | 'pipDigit'>): number {
  return 10 ** (instrument.precision - instrument.pipDigit);
}
