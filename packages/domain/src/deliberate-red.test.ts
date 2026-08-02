import { expect, it } from 'vitest';

// Deliberately red: proves the PR gate turns red on a broken test
// (T-0.0.5 done-when). Reverted in the next commit.
it('deliberate red', () => {
  expect(true).toBe(false);
});
