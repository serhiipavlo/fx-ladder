// sim-core stays pure: no Node imports, no DOM, no timers, no ambient time or
// randomness — time and entropy always arrive as arguments (architecture §4).
export * from './prng';
