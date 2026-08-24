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

/**
 * A single step that has been running this long is a wait, not a check. Below this, the screen
 * stays a splash so a two-second launch does not feel like a form you sit through.
 */
const HOLD_MS = 2200;

interface Props {
  steps: SetupStepStatus[];
  onContinue: () => void;
}

/** sdkmanager and the emulator both print their own percentages; borrow them when they appear. */
const PERCENT_RE = /(\d{1,3})%/;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function trackClass(status: SetupStepStatus['status']): string {
  switch (status) {
    case 'pass':
      return 'is-done';
    case 'running':
      return 'is-now';
    case 'fail':
      return 'is-fail';
    case 'warn':
      return 'is-warn';
    default:
      return 'is-pending';
  }
}

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
  const [held, setHeld] = useState(false);
  const [elapsed, setElapsed] = useState(0);
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
  const ready = settled && blockingOk;

  // Hand over by itself once everything passes. On every launch after the first this is the whole
  // interaction: a few seconds of branded progress, then the app.
  useEffect(() => {
    if (!settled || !blockingOk || handedOver.current) return;
    handedOver.current = true;
    const timer = window.setTimeout(onContinue, 500);
    return () => window.clearTimeout(timer);
  }, [settled, blockingOk, onContinue]);

  useEffect(() => {
    if (failed) {
      setHeld(true);
      return;
    }
    if (!running || ready) return;
    const timer = window.setTimeout(() => setHeld(true), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [failed, running?.id, ready]);

  const stepStarted = useRef(Date.now());
  useEffect(() => {
    stepStarted.current = Date.now();
    setElapsed(0);
  }, [running?.id]);

  useEffect(() => {
    if (!held || failed || ready) return;
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - stepStarted.current) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [held, failed, ready, running?.id]);

  const fraction = Math.min(1, (finished + (running && subPercent !== null ? subPercent / 100 : 0)) / total);
  const percent = Math.round(fraction * 100);

  const compact = !held && !failed;
  const nextStep = (() => {
    const from = running ? steps.findIndex((s) => s.id === running.id) : finished - 1;
    return steps.slice(Math.max(0, from + 1)).find((s) => s.status === 'pending') ?? null;
  })();

  const headline = failed
    ? 'Setup could not finish'
    : ready
      ? 'Ready'
      : compact
        ? 'Checking this PC'
        : (running?.label ?? 'Getting things ready');

  const note = failed
    ? failed.detail
    : ready
      ? 'Starting open-emulator…'
      : compact
        ? null
        : (running?.detail ?? 'Checking what this PC already has…');

  const barPulsing = compact ? !ready && !failed : Boolean(running && subPercent === null && !failed);
  const barWidth = compact && !ready ? 100 : percent;

  async function retry() {
    setRetrying(true);
    try {
      await window.openEmu.runSetupAuto();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className={`setup ${compact ? 'is-compact' : 'is-held'} ${failed ? 'is-failed' : ''} ${ready ? 'is-ready' : ''}`}>
      <div className="setup-frame">
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
            {compact && <p className="setup-tagline">Android on your PC</p>}
          </div>
        </div>

        <div
          className={`setup-bar ${barPulsing ? 'setup-bar-pulsing' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={compact && !ready ? undefined : percent}
          aria-label={headline}
        >
          <span className={`setup-bar-fill ${failed ? 'setup-bar-failed' : ''}`} style={{ width: `${barWidth}%` }} />
        </div>

        {failed ? (
          <div className="setup-fail" role="alert">
            <p className="setup-fail-title">{headline}</p>
            <p className="setup-fail-step">{failed.label}</p>
            <p className="setup-fail-detail">{failed.detail}</p>
            <p className="setup-fail-hint">
              Nothing already finished is lost. Try again — setup continues from here. If Windows
              asked for a restart, do that first.
            </p>
          </div>
        ) : (
          <>
            <div className="setup-status">
              <span className="setup-headline">{headline}</span>
              {!compact && (
                <span className="setup-metrics">
                  {held && !ready && (
                    <span className="setup-elapsed" aria-live="polite">
                      {formatElapsed(elapsed)}
                    </span>
                  )}
                  <span className="setup-percent">{percent}%</span>
                </span>
              )}
            </div>
            {note && <p className="setup-note">{note}</p>}
            {!compact && nextStep && !ready && (
              <p className="setup-next">Then {nextStep.label}</p>
            )}
          </>
        )}

        {failed && (
          <div className="setup-actions">
            <button type="button" className="setup-primary" disabled={retrying} onClick={() => void retry()}>
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
            {!showDetails && (
              <button type="button" className="setup-secondary" onClick={() => setShowDetails(true)}>
                See what happened
              </button>
            )}
          </div>
        )}

        {ready && (
          <div className="setup-actions">
            <button type="button" className="setup-primary" onClick={onContinue}>
              Start
            </button>
          </div>
        )}

        {!compact && steps.length > 0 && (
          <ol className="setup-track" aria-label="Setup steps">
            {steps.map((step) => (
              <li key={step.id} className={`setup-track-item ${trackClass(step.status)}`}>
                <span className="setup-track-pip" aria-hidden="true" />
                <span className="setup-track-label">{step.label}</span>
              </li>
            ))}
          </ol>
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
