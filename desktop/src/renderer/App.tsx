import { useCallback, useEffect, useState } from 'react';
import { SetupWizard } from './components/SetupWizard/SetupWizard';
import { AndroidScreen } from './components/AndroidScreen';
import { DeviceBar } from './components/DeviceBar';
import { AppLibrary } from './components/AppLibrary';
import { StoreView } from './components/Store/StoreView';
import { AccountChip } from './components/Account/AccountChip';
import { SignInDialog } from './components/Account/SignInDialog';
import { AdSlot } from './components/AdSlot';
import { AdInterstitial } from './components/AdInterstitial';
import { ConsentDialog } from './components/ConsentDialog';
import { LicenseDialog } from './components/LicenseDialog';
import type { AccountState } from '../shared/account-types';
import { ADS_ENABLED } from '../shared/ads-types';
import type { AdsState } from '../shared/ads-types';
import type { SetupStepStatus } from '../shared/ipc-types';

type Tab = 'screen' | 'apps' | 'store';

export function App() {
  const [steps, setSteps] = useState<SetupStepStatus[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('screen');
  const [ads, setAds] = useState<AdsState | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [booted, setBooted] = useState(false);
  const [skippedInterstitial, setSkippedInterstitial] = useState(false);
  const [showLicense, setShowLicense] = useState(false);
  const [showAccount, setShowAccount] = useState(false);

  const updateAccount = useCallback((next: AccountState) => setAccount(next), []);

  useEffect(() => {
    window.openEmu.getSetupSteps().then(setSteps);
    window.openEmu.onSetupStep((status) => {
      setSteps((prev) => prev.map((s) => (s.id === status.id ? status : s)));
    });
    // Auto, not just check: the first run repairs whatever it can without being driven.
    window.openEmu.runSetupAuto();
    // Not merely ignored when ads are off — not asked for. The handler isn't registered in an
    // ad-free build, so invoking it would reject.
    if (ADS_ENABLED) window.openEmu.adsState().then(setAds);
    window.openEmu.accountState().then(setAccount);
  }, []);

  // The guest is only worth asking about once it has actually painted, and the answer is what the
  // chip shows — so this is deliberately tied to first frame rather than to app start.
  useEffect(() => {
    if (booted) void window.openEmu.accountRefresh(true).then(setAccount);
  }, [booted]);

  if (!ready) {
    return <SetupWizard steps={steps} onContinue={() => setReady(true)} />;
  }

  // With ads off there is nothing to put over the boot wait, and nothing needs to: the Screen tab
  // already says "Waiting for first frame…" until the guest paints.
  const showInterstitial = ADS_ENABLED && tab === 'screen' && !booted && !skippedInterstitial;
  const canBuyRemoval = ADS_ENABLED && ads?.configured === true && !ads.adsRemoved;

  return (
    <div className="app">
      <nav className="tabs">
        <span className="tabs-logo" aria-hidden="true" />
        <div className="tabs-list">
          <button type="button" className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
            Screen
          </button>
          <button type="button" className={tab === 'apps' ? 'on' : ''} onClick={() => setTab('apps')}>
            Apps
          </button>
          <button type="button" className={tab === 'store' ? 'on' : ''} onClick={() => setTab('store')}>
            Store
          </button>
        </div>
        <span className="tabs-spacer" />
        <AccountChip state={account} onOpen={() => setShowAccount(true)} />
        {canBuyRemoval && (
          <button type="button" className="remove-ads" onClick={() => setShowLicense(true)}>
            Remove ads
          </button>
        )}
      </nav>

      <DeviceBar />

      {/* The rail sits beside the mirrored screen, never over it — shell chrome is monetizable,
          the guest's own display is not. */}
      <div className="stage">
        {tab === 'screen' && <AndroidScreen onFirstFrame={() => setBooted(true)} />}
        {tab === 'apps' && <AppLibrary />}
        {tab === 'store' && <StoreView />}
        {ADS_ENABLED && <AdSlot slot="rail" />}
      </div>

      {showInterstitial && <AdInterstitial onSkip={() => setSkippedInterstitial(true)} />}
      {ADS_ENABLED && ads?.consent === 'pending' && <ConsentDialog onResolved={setAds} />}
      {showLicense && (
        <LicenseDialog onClose={() => setShowLicense(false)} onActivated={setAds} />
      )}
      {showAccount && account && (
        <SignInDialog state={account} onChange={updateAccount} onClose={() => setShowAccount(false)} />
      )}
    </div>
  );
}
