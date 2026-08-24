import { forwardRef } from 'react';
import type { AccountState } from '../../../shared/account-types';

interface Props {
  state: AccountState | null;
  open?: boolean;
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
export const AccountChip = forwardRef<HTMLButtonElement, Props>(function AccountChip(
  { state, open = false, onOpen },
  ref,
) {
  if (!state) return null;

  const signedIn = state.guest.state === 'signed-in';

  return (
    <button
      ref={ref}
      type="button"
      className={`account-chip ${signedIn ? 'account-chip-on' : ''} ${open ? 'is-open' : ''}`}
      onClick={onOpen}
      aria-expanded={open}
      aria-controls="account-page"
      aria-haspopup="dialog"
      title={signedIn ? 'Account — signed in on this device' : 'Account'}
    >
      <span className="account-avatar" aria-hidden="true">
        {initial(state)}
      </span>
      <span className="account-caption">{caption(state)}</span>
    </button>
  );
});
