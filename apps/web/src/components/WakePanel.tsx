import { useSyncExternalStore } from 'react';

import type { FeedStore } from '../stream/store';

// The free Render instance sleeps after ~15 min idle (ADR-11 revision), and a
// sleeping server looks exactly like a broken one. This panel appears only
// while the socket is down and says which of the two it is: a cold start the
// visitor can knock awake, or an ending the reaction table called final.

/** The sub-line under the button: the server's own reason, or the cold-start note. */
/** Writes the sub-line under the button: the server's reason, or the cold-start note. */
interface WakeHintBuilder {
  (store: FeedStore): string;
}

export const wakeHint: WakeHintBuilder = (store) => {
  if (!store.terminal()) return 'free instance sleeps after ~15 min idle; waking takes up to a minute';
  const close = store.lastClose();
  return close?.reason || (close?.decision.label ?? 'stopped');
};

export interface WakePanelProps {
  store: FeedStore;
  /** A knock is in flight; the button waits rather than queueing another. */
  waking: boolean;
  onWake: () => void;
}

interface WakePanelComponent {
  (props: WakePanelProps): React.JSX.Element | null;
}

export const WakePanel: WakePanelComponent = ({ store, waking, onWake }) => {
  useSyncExternalStore(store.subscribe, () => store.version());
  if (store.socketState() !== 'closed') return null;

  // A knock in flight, an ending the table called final, or a server that is
  // merely asleep — three states, and the button says which one it is.
  let label = 'Wake the server';
  if (waking) {
    label = 'waking the server…';
  } else if (store.terminal()) {
    label = 'Reconnect';
  }

  let cursor = 'pointer';
  if (waking) {
    cursor = 'wait';
  }

  return (
    <p>
      <button
        onClick={onWake}
        disabled={waking}
        data-testid="wake"
        style={{ font: 'inherit', padding: '0.4rem 1rem', cursor }}
      >
        {label}
      </button>
      <br />
      <small data-testid="wake-hint">{wakeHint(store)}</small>
    </p>
  );
};
