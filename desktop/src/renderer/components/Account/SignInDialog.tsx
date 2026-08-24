import { useEffect, useState } from 'react';
import type { AccountState } from '../../../shared/account-types';
import { Icon } from '../Icon';

interface Props {
  state: AccountState;
  onChange: (state: AccountState) => void;
  onClose: () => void;
}

function guestTitle(state: AccountState): string {
  switch (state.guest.state) {
    case 'signed-in':
      return state.guest.accounts.map((account) => account.name).join(', ');
    case 'signed-out':
      return 'Not signed in on this device';
    case 'guest-unavailable':
      return 'Device isn’t running';
    case 'unknown':
      return 'Checking this device';
  }
}

function guestCopy(state: AccountState): string {
  switch (state.guest.state) {
    case 'signed-in':
      return 'Signed in to Google on this Android.';
    case 'signed-out':
      return 'Open Google’s sign-in below when you want this Android to use the account.';
    case 'guest-unavailable':
      return 'Start it to see whether this Android is signed in.';
    case 'unknown':
      return 'Asking the device who is signed in.';
  }
}

/**
 * The device-wide account, and assisted sign-in.
 *
 * Shown in the stage, never over the device viewport — a native child window will later paint
 * there. The honest framing matters and is reflected in the copy: this cannot silently log anyone
 * into Google. What it does instead is remember who you are across every guest the shell manages,
 * notice when a guest is already signed in, and offer to type a credential you chose to store
 * into Google's own screen — leaving every challenge to you.
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

  const signedIn = state.guest.state === 'signed-in';
  const guestKind =
    state.guest.state === 'signed-in'
      ? 'is-ok'
      : state.guest.state === 'signed-out'
        ? 'is-out'
        : 'is-idle';

  return (
    <section className="account" id="account-page" aria-labelledby="account-title">
      <div className="account-sheet">
        <button type="button" className="store-back" onClick={onClose}>
          <Icon name="back" size={16} />
          Close
        </button>

        <header className="account-head">
          <h2 id="account-title">Account</h2>
          <p className="account-lead">One Google account, used on every Android this app runs.</p>
        </header>

        <div className={`account-banner ${guestKind}`}>
          <span className="account-banner-icon" aria-hidden="true">
            <Icon
              name={signedIn ? 'check' : state.guest.state === 'unknown' ? 'loader' : 'device'}
              size={16}
            />
          </span>
          <div>
            <p className="account-banner-title">{guestTitle(state)}</p>
            <p className="account-banner-copy">{guestCopy(state)}</p>
          </div>
        </div>

        <div className="account-section">
          <h3 className="account-section-label">On this PC</h3>
          <label className="account-field" htmlFor="account-email">
            <span className="account-field-label">Google address</span>
            <input
              id="account-email"
              className="account-input"
              type="email"
              autoComplete="off"
              placeholder="you@gmail.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => void window.openEmu.accountSetEmail(email).then(onChange)}
            />
            <span className="account-field-hint">Saved here, filled into any guest you run.</span>
          </label>

          {state.vaultAvailable ? (
            <>
              <div className="account-field">
                <div className="account-field-head">
                  <label className="account-field-label" htmlFor="account-password">
                    Password
                  </label>
                  <span className="account-optional">Optional</span>
                </div>
                <input
                  id="account-password"
                  className="account-input"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    state.profile.hasStoredPassword
                      ? 'Saved in Windows Credential Manager'
                      : 'Not saved'
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="account-field-hint">
                  Windows Credential Manager, on this PC only. Off by default.
                </p>
                <div className="account-actions">
                  <button
                    type="button"
                    className="account-btn"
                    disabled={busy || password.length === 0}
                    onClick={() =>
                      void act('Saving…', async () => {
                        onChange(await window.openEmu.accountSetPassword(password));
                        setPassword('');
                        setStatus('Password saved to Windows Credential Manager.');
                      })
                    }
                  >
                    Save password
                  </button>
                  {state.profile.hasStoredPassword && (
                    <button
                      type="button"
                      className="account-btn"
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
              </div>

              {state.profile.hasStoredPassword && (
                <label className="account-switch">
                  <input
                    type="checkbox"
                    checked={state.profile.autoFill}
                    onChange={(event) =>
                      void window.openEmu.accountSetAutofill(event.target.checked).then(onChange)
                    }
                  />
                  <span className="account-switch-text">
                    <span className="account-switch-label">Fill the saved password into Google’s sign-in</span>
                    <span className="account-switch-hint">Off until you turn it on. The only thing that uses the password.</span>
                  </span>
                </label>
              )}
            </>
          ) : (
            <div className="account-vault">
              <span className="account-vault-icon" aria-hidden="true">
                <Icon name="key" size={18} />
              </span>
              <div>
                <p className="account-vault-title">No credential store on this PC</p>
                <p className="account-vault-copy">
                  A password cannot be kept here. This app will not write one to a file. Sign in on
                  the device instead — once per Android version.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="account-section">
          <h3 className="account-section-label">On this device</h3>
          <p className="account-copy">
            Opens Google’s own add-account screen. Fill the fields from here if you like; you finish
            any extra step on the device. Once it’s done, this Android stays signed in.
          </p>
          <div className="account-actions">
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
              Open sign-in
            </button>
            <button
              type="button"
              className="account-btn"
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
              className="account-btn"
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
          {status && (
            <p className="account-status" aria-live="polite">
              {status}
            </p>
          )}
        </div>

        <div className="account-foot">
          <button
            type="button"
            className="account-forget"
            disabled={busy}
            onClick={() =>
              void act('Clearing…', async () => {
                onChange(await window.openEmu.accountSignOut());
                setEmail('');
                setStatus('Cleared on this machine. The guest keeps its own account until you remove it there.');
              })
            }
          >
            Forget account on this PC
          </button>
          <button
            type="button"
            className="account-btn"
            onClick={() => void window.openEmu.accountRefresh(true).then(onChange)}
          >
            Re-check device
          </button>
        </div>
      </div>
    </section>
  );
}
