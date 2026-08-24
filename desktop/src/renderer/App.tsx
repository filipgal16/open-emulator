import { useCallback, useEffect, useRef, useState } from 'react';
import { SetupWizard } from './components/SetupWizard/SetupWizard';
import { AndroidScreen } from './components/AndroidScreen';
import { DeviceBar } from './components/DeviceBar';
import { AppLibrary } from './components/AppLibrary';
import { StoreView } from './components/Store/StoreView';
import { AccountChip } from './components/Account/AccountChip';
import { SignInDialog } from './components/Account/SignInDialog';
import { IconSprite } from './components/Icon';
import { NavRail, type WorkspaceId } from './components/NavRail';
import { SettingsView } from './components/Settings/SettingsView';
import { ToolRail } from './components/ToolRail';
import type { AccountState } from '../shared/account-types';
import { INITIAL_DEVICE_STATE, type DeviceState } from '../shared/device-types';
import type { SetupStepStatus } from '../shared/ipc-types';
import { isTypingTarget, WORKSPACE_SHORTCUTS } from './keyboard';
import { applyDocumentTheme } from './theme';

export function App() {
  const [steps, setSteps] = useState<SetupStepStatus[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<WorkspaceId>('screen');
  const [account, setAccount] = useState<AccountState | null>(null);
  const [booted, setBooted] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [theater, setTheater] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [device, setDevice] = useState<DeviceState>(INITIAL_DEVICE_STATE);
  const accountBtnRef = useRef<HTMLButtonElement>(null);
  const theaterBtnRef = useRef<HTMLButtonElement>(null);

  const updateAccount = useCallback((next: AccountState) => setAccount(next), []);

  const closeAccount = useCallback(() => {
    setShowAccount(false);
    accountBtnRef.current?.focus();
  }, []);

  const exitTheater = useCallback(() => {
    setTheater(false);
    theaterBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    window.openEmu.getSetupSteps().then(setSteps);
    window.openEmu.onSetupStep((status) => {
      setSteps((prev) => prev.map((s) => (s.id === status.id ? status : s)));
    });
    // Auto, not just check: the first run repairs whatever it can without being driven.
    window.openEmu.runSetupAuto();
    window.openEmu.accountState().then(setAccount);
    // Theme has to land on <html> before Settings is ever opened, or a saved choice dies at restart.
    window.openEmu.settingsState().then((state) => applyDocumentTheme(state.settings.theme));
  }, []);

  // The guest is only worth asking about once it has actually painted, and the answer is what the
  // chip shows — so this is deliberately tied to first frame rather than to app start.
  useEffect(() => {
    if (booted) void window.openEmu.accountRefresh(true).then(setAccount);
  }, [booted]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (theater) {
          exitTheater();
          event.preventDefault();
          return;
        }
        if (showAccount) {
          closeAccount();
          event.preventDefault();
        }
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && !isTypingTarget(event.target)) {
        const workspace = WORKSPACE_SHORTCUTS.find((entry) => event.key === entry.digit);
        if (workspace) {
          setShowAccount(false);
          setTab(workspace.id);
          event.preventDefault();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [theater, showAccount, closeAccount, exitTheater]);

  if (!ready) {
    return (
      <>
        <IconSprite />
        <SetupWizard steps={steps} onContinue={() => setReady(true)} />
      </>
    );
  }

  const live = device.phase === 'running';

  function selectWorkspace(id: WorkspaceId) {
    setShowAccount(false);
    setTab(id);
  }

  return (
    <>
      <IconSprite />
      <div className={theater ? 'app app-theater' : 'app'}>
        <header className="titlebar">
          <span className="titlebar-brand">
            <span className="titlebar-logo" aria-hidden="true" />
            open-emulator
          </span>
          <span className="titlebar-spacer" />
          <AccountChip
            ref={accountBtnRef}
            state={account}
            open={showAccount}
            onOpen={() => setShowAccount(true)}
          />
        </header>

        <div className="workspace">
          <NavRail active={tab} onSelect={selectWorkspace} />

          <main className="stage">
            {showAccount && account ? (
              <SignInDialog state={account} onChange={updateAccount} onClose={closeAccount} />
            ) : tab === 'screen' ? (
              <div className={rotation ? `viewport is-rot-${rotation}` : 'viewport'}>
                <AndroidScreen device={device} onFirstFrame={() => setBooted(true)} />
              </div>
            ) : tab === 'apps' ? (
              <AppLibrary onOpenStore={() => selectWorkspace('store')} />
            ) : tab === 'store' ? (
              <StoreView />
            ) : (
              <SettingsView />
            )}
          </main>

          <ToolRail
            live={live}
            theater={theater}
            theaterButtonRef={theaterBtnRef}
            onToggleTheater={() => (theater ? exitTheater() : setTheater(true))}
            onRotate={() => setRotation((deg) => (deg + 90) % 360)}
          />
        </div>

        <DeviceBar onState={setDevice} />
      </div>
    </>
  );
}
