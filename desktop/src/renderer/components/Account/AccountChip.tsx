import type { AccountState } from '../../../shared/account-types';

interface Props {
  state: AccountState | null;
  onOpen: () => void;
}

function initial(state: AccountState): string {
  const source = state.profile.displayName || state.profile.email || state.guest.accounts[0]?.name || '?';
  return source.slice(0, 1).toUpperCase();
}

function caption(state: AccountState): string {
  if (state.guest.state === 'signed-in') {
    return state.guest.accounts[0]?.name ?? 'Signed in';
  }
  if (state.profile.email) return state.profile.email;
  return 'Sign in';
}

/**
 * The device-wide account, in the title bar.
 *
 * Shows the guest's actual signed-in address when there is one, and the saved profile otherwise —
 * those can legitimately differ (a profile set up before the guest was ever started), and showing
 * the guest's answer first keeps the chip honest about the state that matters.
 */
export function AccountChip({ state, onOpen }: Props) {
  if (!state) return null;

  const signedIn = state.guest.state === 'signed-in';

  return (
    <button
      type="button"
      className={`account-chip ${signedIn ? 'account-chip-on' : ''}`}
      onClick={onOpen}
      title={signedIn ? 'Account — signed in on this guest' : 'Account'}
    >
      <span className="account-avatar" aria-hidden="true">
        {initial(state)}
      </span>
      <span className="account-caption">{caption(state)}</span>
    </button>
  );
}
