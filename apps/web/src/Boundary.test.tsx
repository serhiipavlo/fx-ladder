// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Boundary } from './Boundary';

// AC-12 as a test: one widget's render error stays that widget's problem.

function Bomb(): never {
  throw new Error('formatter exploded');
}

afterEach(cleanup);

describe('Boundary (AC-12, NFR-09)', () => {
  it('a throwing widget renders its fallback while siblings live on', () => {
    // React logs caught render errors loudly; the catch IS the test here.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <main>
        <Boundary name="blotter">
          <Bomb />
        </Boundary>
        <Boundary name="positions">
          <p>positions alive</p>
        </Boundary>
      </main>,
    );
    spy.mockRestore();

    const fallback = screen.getByTestId('widget-error');
    expect(fallback.textContent).toContain('the blotter widget failed to render');
    expect(fallback.textContent).toContain('formatter exploded');
    expect(screen.getByText('positions alive')).toBeTruthy(); // the page survived
    expect(screen.getAllByTestId('widget-error')).toHaveLength(1); // only the bomb fell
  });

  it('a healthy subtree renders untouched', () => {
    render(
      <Boundary name="ladder">
        <p>ticking</p>
      </Boundary>,
    );
    expect(screen.getByText('ticking')).toBeTruthy();
    expect(screen.queryByTestId('widget-error')).toBeNull();
  });
});
