import { useEffect, useState } from 'react';
import { AdSlot } from '../AdSlot';
import type { LogEvent, SetupStepStatus } from '../../../shared/ipc-types';

const ICONS: Record<SetupStepStatus['status'], string> = {
  pending: '○',
  running: '◐',
  pass: '✅',
  fail: '❌',
  warn: '⚠',
};

interface Props {
  steps: SetupStepStatus[];
  onContinue: () => void;
}

export function SetupWizard({ steps, onContinue }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    window.openEmu.onLog((event: LogEvent) => {
      setLog((prev) => [...prev.slice(-200), `${event.stream === 'stderr' ? '! ' : ''}${event.line}`]);
    });
  }, []);

  const settled = steps.length > 0 && steps.every((s) => s.status !== 'pending' && s.status !== 'running');
  const blockingOk = steps.length > 0 && steps.filter((s) => s.blocking).every((s) => s.status === 'pass');

  async function runFix(id: string) {
    setBusyId(id);
    try {
      await window.openEmu.runSetupFix(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="setup-wizard">
      <h1>Setting up open-emulator</h1>
      <ul className="steps">
        {steps.map((step) => (
          <li key={step.id} className={`step step-${step.status}`}>
            <span className="icon">{ICONS[step.status]}</span>
            <span className="label">{step.label}</span>
            <span className="detail">{step.detail}</span>
            {step.status === 'fail' && (
              <button disabled={busyId === step.id} onClick={() => runFix(step.id)}>
                {busyId === step.id ? 'Fixing…' : 'Fix'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <pre className="log">{log.join('\n')}</pre>
      {/* The SDK fetch and AVD provision run for minutes behind this wizard — that dwell is the
          least intrusive inventory in the product, because nothing else wants the user's attention. */}
      <AdSlot slot="wizard-footer" />
      <button className="continue" disabled={!settled || !blockingOk} onClick={onContinue}>
        Continue to app
      </button>
    </div>
  );
}
