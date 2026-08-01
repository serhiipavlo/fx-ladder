import { expect, it } from 'vitest';

import { PKG } from './index';

it('exports the package marker', () => {
  expect(PKG).toBe('@fx/domain');
});
