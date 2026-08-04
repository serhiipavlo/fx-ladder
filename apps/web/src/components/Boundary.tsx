import { Component, type ReactNode } from 'react';

// AC-12 (NFR-09): a rendering error in one widget must not crash the page.
// React still spells error boundaries as a class; this is the one class in
// the codebase, and it earns its keep — the ladder keeps ticking while a
// broken blotter says so in place instead of taking the page down with it.

interface BoundaryProps {
  /** Widget name for the fallback line, e.g. "ladder". */
  name: string;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

export class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <p style={{ color: '#dc322f' }} data-testid="widget-error">
          the {this.props.name} widget failed to render: <code>{this.state.error.message}</code> — the rest of the
          page lives on; reload to restore it
        </p>
      );
    }
    return this.props.children;
  }
}
