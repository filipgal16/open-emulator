import { useEffect, useState } from 'react';
import type { AccountState } from '../../../shared/account-types';

interface Props {
  state: AccountState;
  onChange: (state: AccountState) => void;
  onClose: () => void;
}

function guestSummary(state: AccountState): string {
  switch (state.guest.state) {
    case 'signed-in':
      return `Signed in as ${state.guest.accounts.map((account) => account.name).join(', ')}`;
    case 'signed-out':
      return 'No Google account on this guest yet';
    case 'guest-unavailable':
      return 'Android is not running, or is not answering adb';
    case 'unknown':
      return 'Checking…';
  }
}

/**
 * The device-wide account, and assisted sign-in.
 *
 * The honest framing matters here and is reflected in the copy: this cannot silently log anyone
 * into Google. Google's sign-in is deliberately resistant to automation, and defeating that would
 * be both fragile and wrong. What it does instead is remember who you are across every guest the
 * shell manages, notice when a guest is already signed in (the usual case, since the account
 * survives in the snapshot), and offer to type a credential you chose to store into Google's own
 * screen — leaving every challenge to you.
 */
export function SignInDialog({ state, onChange, onClose }: Props) {
  const [email, setEmail] = useState(state.profile.email ?? '');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.openEmu.accountRefresh(true).then(onChange);
  }, [onChange]);

  async function act(label: string, action: () => Promise<void>) {
    setBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Account</h2>
        <p className={state.guest.state === 'signed-in' ? 'account-ok' : 'modal-note'}>{guestSummary(state)}</p>

        <label className="account-field">
          <span>Google address</span>
          <input
            className="field-input"
            type="email"
            autoComplete="off"
            placeholder="you@gmail.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => void window.openEmu.accountSetEmail(email).then(onChange)}
          />
        </label>

        {state.vaultAvailable ? (
          <label className="account-field">
            <span>Password (optional)</span>
            <input
              className="field-input"
              type="password"
              autoComplete="off"
              placeholder={state.profile.hasStoredPassword ? '•••••••• saved in the OS keychain' : 'Not saved'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        ) : (
          <p className="modal-note">
            The OS keychain is unavailable, so no password can be stored. Sign in on the guest screen
            instead — it only has to be done once per guest.
          </p>
        )}

        {state.vaultAvailable && (
          <div className="account-actions-row">
            <button
              type="button"
              disabled={busy || password.length === 0}
              onClick={() =>
                void act('Saving…', async () => {
                  onChange(await window.openEmu.accountSetPassword(password));
                  setPassword('');
                  setStatus('Password saved to the OS keychain.');
                })
              }
            >
              Save password
            </button>
            {state.profile.hasStoredPassword && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act('Clearing…', async () => {
                    onChange(await window.openEmu.accountSetPassword(null));
                    setStatus('Stored password removed.');
                  })
                }
              >
                Forget password
              </button>
            )}
          </div>
        )}

        {state.profile.hasStoredPassword && (
          <label className="account-toggle">
            <input
              type="checkbox"
              checked={state.profile.autoFill}
              onChange={(event) => void window.openEmu.accountSetAutofill(event.target.checked).then(onChange)}
            />
            <span>
              Let the shell type the saved password into the guest&apos;s sign-in screen. Off by
              default — a stored Google password is a real risk, and this is the only thing that
              uses it.
            </span>
          </label>
        )}

        <h3 className="account-subhead">Sign in on this guest</h3>
        <p className="modal-note">
          Opens Google&apos;s own add-account screen in the guest. Fill the fields from here if you
          like; you complete the flow, including any two-factor or verification step, on the Screen
          tab. Once it is done, <code>open-emu provision</code> folds it into the snapshot and the
          guest comes back signed in on every later start.
        </p>

        <div className="account-actions-row">
          <button
            type="button"
            className="setup-primary"
            disabled={busy}
            onClick={() =>
              void act('Opening…', async () => {
                const result = await window.openEmu.accountBeginSignIn();
                setStatus(result.message);
              })
            }
          >
            Open sign-in in guest
          </button>
          <button
            type="button"
            disabled={busy || !state.profile.email}
            onClick={() =>
              void act('Typing…', async () => {
                const result = await window.openEmu.accountFill('email');
                setStatus(result.message);
              })
            }
          >
            Fill address
          </button>
          <button
            type="button"
            disabled={busy || !state.profile.autoFill}
            onClick={() =>
              void act('Typing…', async () => {
                const result = await window.openEmu.accountFill('password');
                setStatus(result.message);
              })
            }
          >
            Fill password
          </button>
        </div>

        {status && <p className="account-status">{status}</p>}

        <div className="modal-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act('Clearing…', async () => {
                onChange(await window.openEmu.accountSignOut());
                setEmail('');
                setStatus('Cleared on this machine. The guest keeps its own account until you remove it there.');
              })
            }
          >
            Forget account
          </button>
          <button type="button" onClick={() => void window.openEmu.accountRefresh(true).then(onChange)}>
            Re-check guest
          </button>
          <button type="button" className="modal-btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
