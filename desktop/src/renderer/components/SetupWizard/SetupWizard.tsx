import { useEffect, useRef, useState } from 'react';
import type { LogEvent, SetupStepStatus } from '../../../shared/ipc-types';
import { Icon, type IconName } from '../Icon';

const STEP_ICONS: Record<SetupStepStatus['status'], IconName> = {
  pending: 'circle',
  running: 'loader',
  pass: 'check',
  fail: 'x',
  warn: 'alert',
};

interface Props {
  steps: SetupStepStatus[];
  onContinue: () => void;
}

/** sdkmanager and the emulator both print their own percentages; borrow them when they appear. */
const PERCENT_RE = /(\d{1,3})%/;

/**
 * First run.
 *
 * Everything here happens on its own. The previous version listed six technical checks with a
 * "Fix" button beside each failure — accurate, and useless to anyone who did not already know what
 * an AVD was. Every step could already repair itself; nothing was calling them.
 *
 * So: one progress bar, one sentence about what is happening, and the log behind a toggle for the
 * times it matters. When there is nothing to do — every launch after the first — this passes in a
 * few seconds and hands over without being clicked.
 */
export function SetupWizard({ steps, onContinue }: Props) {
  const [log, setLog] = useState<string[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [subPercent, setSubPercent] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const handedOver = useRef(false);

  useEffect(() => {
    window.openEmu.onLog((event: LogEvent) => {
      setLog((prev) => [...prev.slice(-400), `${event.stream === 'stderr' ? '! ' : ''}${event.line}`]);
      const match = PERCENT_RE.exec(event.line);
      setSubPercent(match ? Math.min(100, Number(match[1])) : null);
    });
  }, []);

  useEffect(() => {
    if (showDetails && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, showDetails]);

  const total = steps.length || 1;
  const settled = steps.length > 0 && steps.every((s) => s.status !== 'pending' && s.status !== 'running');
  const blockingOk = steps.length > 0 && steps.filter((s) => s.blocking).every((s) => s.status === 'pass');
  const running = steps.find((s) => s.status === 'running') ?? null;
  const failed = steps.find((s) => s.status === 'fail' && s.blocking) ?? null;
  const finished = steps.filter((s) => s.status === 'pass' || s.status === 'warn').length;

  // Hand over by itself once everything passes. On every launch after the first this is the whole
  // interaction: a few seconds of branded progress, then the app.
  useEffect(() => {
    if (!settled || !blockingOk || handedOver.current) return;
    handedOver.current = true;
    const timer = window.setTimeout(onContinue, 500);
    return () => window.clearTimeout(timer);
  }, [settled, blockingOk, onContinue]);

  const fraction = Math.min(1, (finished + (running && subPercent !== null ? subPercent / 100 : 0)) / total);
  const percent = Math.round(fraction * 100);

  const headline = failed
    ? 'Setup could not finish'
    : settled && blockingOk
      ? 'Ready'
      : (running?.label ?? 'Getting things ready');

  const note = failed
    ? failed.detail
    : settled && blockingOk
      ? 'Starting open-emulator…'
      : (running?.detail ?? 'Checking what this PC already has…');

  async function retry() {
    setRetrying(true);
    try {
      await window.openEmu.runSetupAuto();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-brand">
          <span className="setup-logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="26" height="26">
              <rect x="9" y="5" width="14" height="22" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="13" y="8" width="6" height="1.5" rx="0.75" fill="currentColor" />
              <circle cx="16" cy="23.5" r="1.4" fill="currentColor" />
            </svg>
          </span>
          <div>
            <h1>open-emulator</h1>
            <p className="setup-tagline">Android on your PC</p>
          </div>
        </div>

        <div className={`setup-bar ${running && subPercent === null && !failed ? 'setup-bar-pulsing' : ''}`}>
          <span className={`setup-bar-fill ${failed ? 'setup-bar-failed' : ''}`} style={{ width: `${percent}%` }} />
        </div>

        <div className="setup-status">
          <span className="setup-headline">{headline}</span>
          {!failed && <span className="setup-percent">{percent}%</span>}
        </div>
        <p className="setup-note">{note}</p>

        {failed && (
          <div className="setup-actions">
            <button type="button" className="setup-primary" disabled={retrying} onClick={() => void retry()}>
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
            <button type="button" className="setup-secondary" onClick={() => setShowDetails(true)}>
              See what happened
            </button>
          </div>
        )}

        {settled && blockingOk && (
          <div className="setup-actions">
            <button type="button" className="setup-primary" onClick={onContinue}>
              Start
            </button>
          </div>
        )}

        <button
          type="button"
          className="setup-details-toggle"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? 'Hide details' : 'Details'}
        </button>

        {showDetails && (
          <div className="setup-details">
            <ul className="steps">
              {steps.map((step) => (
                <li key={step.id} className={`step step-${step.status}`}>
                  <span className="icon">
                    <Icon name={STEP_ICONS[step.status]} size={14} />
                  </span>
                  <span className="label">{step.label}</span>
                  <span className="detail">{step.detail}</span>
                </li>
              ))}
            </ul>
            <pre className="log" ref={logRef}>
              {log.join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
