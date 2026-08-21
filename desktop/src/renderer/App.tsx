import { useEffect, useState } from 'react';
import { SetupWizard } from './components/SetupWizard/SetupWizard';
import { AndroidScreen } from './components/AndroidScreen';
import { AppLibrary } from './components/AppLibrary';
import { AdSlot } from './components/AdSlot';
import { AdInterstitial } from './components/AdInterstitial';
import { ConsentDialog } from './components/ConsentDialog';
import { LicenseDialog } from './components/LicenseDialog';
import type { AdsState } from '../shared/ads-types';
import type { SetupStepStatus } from '../shared/ipc-types';

type Tab = 'screen' | 'apps';

export function App() {
  const [steps, setSteps] = useState<SetupStepStatus[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('screen');
  const [ads, setAds] = useState<AdsState | null>(null);
  const [booted, setBooted] = useState(false);
  const [skippedInterstitial, setSkippedInterstitial] = useState(false);
  const [showLicense, setShowLicense] = useState(false);

  useEffect(() => {
    window.openEmu.getSetupSteps().then(setSteps);
    window.openEmu.onSetupStep((status) => {
      setSteps((prev) => prev.map((s) => (s.id === status.id ? status : s)));
    });
    window.openEmu.runSetupChecks();
    window.openEmu.adsState().then(setAds);
  }, []);

  if (!ready) {
    return <SetupWizard steps={steps} onContinue={() => setReady(true)} />;
  }

  const showInterstitial = tab === 'screen' && !booted && !skippedInterstitial;
  const canBuyRemoval = ads?.configured === true && !ads.adsRemoved;

  return (
    <div className="app">
      <nav className="tabs">
        <button type="button" className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
          Screen
        </button>
        <button type="button" className={tab === 'apps' ? 'on' : ''} onClick={() => setTab('apps')}>
          Apps
        </button>
        <span className="tabs-spacer" />
        {canBuyRemoval && (
          <button type="button" className="remove-ads" onClick={() => setShowLicense(true)}>
            Remove ads
          </button>
        )}
      </nav>

      {/* The rail sits beside the mirrored screen, never over it — shell chrome is monetizable,
          the guest's own display is not. */}
      <div className="stage">
        {tab === 'screen' ? <AndroidScreen onFirstFrame={() => setBooted(true)} /> : <AppLibrary />}
        <AdSlot slot="rail" />
      </div>

      {showInterstitial && <AdInterstitial onSkip={() => setSkippedInterstitial(true)} />}
      {ads?.consent === 'pending' && <ConsentDialog onResolved={setAds} />}
      {showLicense && (
        <LicenseDialog onClose={() => setShowLicense(false)} onActivated={setAds} />
      )}
    </div>
  );
}
