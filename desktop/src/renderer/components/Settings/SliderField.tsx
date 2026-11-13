import { useEffect, useId, useState, type CSSProperties } from 'react';

interface Props {
  label: string;
  /** The saved value, in the slider's own units. Null is Automatic. */
  value: number | null;
  /** What Automatic resolves to. Shown as a tick on the track, and as the value while the switch is on. */
  automatic: number;
  min: number;
  max: number;
  step: number;
  /** After the number box: "cores", "GB", "dpi". */
  unit: string;
  /** Slider units to the number in the box and back — megabytes are stored, gigabytes are typed. */
  toShown?: (value: number) => number;
  fromShown?: (shown: number) => number;
  /** The value in words, read out with the slider: "6 cores", "4 GB". */
  describe: (value: number) => string;
  /** The ends of the track, where numbers alone do not say which way is which. */
  minLabel?: string;
  maxLabel?: string;
  /** Under the control. A function, so it can speak about the value being dragged, not the saved one. */
  hint: (value: number, automatic: boolean) => { text: string; warn?: boolean };
  onCommit: (value: number | null) => void;
}

const same = (value: number) => value;

/**
 * One number, three ways to set it: leave it to the app, drag it, or type it.
 *
 * The switch comes first because Automatic is the right answer for most people, and a slider that
 * is always live reads as something that must be set. Turning it off starts from the automatic
 * value rather than from the end of the track — the first thing a person sees is what they already
 * had.
 *
 * Dragging and typing only change this component's own state; the value is saved when the gesture
 * ends — pointer up, a key released, the box left or Enter pressed. Saving on every tick of a drag
 * would write the settings file sixty times a second for one decision.
 */
export function SliderField({
  label,
  value,
  automatic,
  min,
  max,
  step,
  unit,
  toShown = same,
  fromShown = same,
  describe,
  minLabel,
  maxLabel,
  hint,
  onCommit,
}: Props) {
  const labelId = useId();
  const isAuto = value === null;
  const saved = snap(value ?? automatic, min, max, step);
  const [draft, setDraft] = useState(saved);
  const [text, setText] = useState(formatShown(toShown(saved)));

  // Follow the saved value whenever it changes from outside this control: a reload, the switch,
  // or the store correcting a number it would not accept.
  useEffect(() => {
    setDraft(saved);
    setText(formatShown(toShown(saved)));
    // Keyed on the saved value alone: `toShown` is a pure unit conversion, and following its
    // identity would reset the box on every render.
  }, [saved]);

  function move(next: number) {
    const snapped = snap(next, min, max, step);
    setDraft(snapped);
    setText(formatShown(toShown(snapped)));
  }

  function commit(next: number) {
    const snapped = snap(next, min, max, step);
    move(snapped);
    if (snapped !== value) onCommit(snapped);
  }

  function commitText() {
    const typed = Number(text.replace(',', '.'));
    // Not a number: put back what was there rather than guess.
    if (text.trim() === '' || !Number.isFinite(typed)) {
      move(draft);
      return;
    }
    commit(fromShown(typed));
  }

  const fill = max > min ? (draft - min) / (max - min) : 0;
  const mark = max > min ? (snap(automatic, min, max, step) - min) / (max - min) : 0;
  const shownHint = hint(draft, isAuto);

  return (
    <div className={`settings-field settings-slider-field${isAuto ? ' is-auto' : ''}`}>
      <div className="settings-slider-head">
        <p className="settings-field-label" id={labelId}>
          {label}
        </p>
        <span className="settings-slider-value" aria-hidden="true">
          {describe(draft)}
        </span>
        <label className="settings-auto">
          <span className="settings-auto-text">Automatic</span>
          <button
            type="button"
            role="switch"
            aria-checked={isAuto}
            aria-label={`${label}: choose automatically`}
            className={isAuto ? 'settings-toggle on' : 'settings-toggle'}
            onClick={() => onCommit(isAuto ? saved : null)}
          />
        </label>
      </div>

      <div className="settings-slider-row">
        <div className="settings-slider-wrap">
          <input
            type="range"
            className="settings-slider"
            min={min}
            max={max}
            step={step}
            value={draft}
            disabled={isAuto}
            aria-labelledby={labelId}
            aria-valuetext={describe(draft)}
            style={{ '--fill': `${(fill * 100).toFixed(2)}%` } as CSSProperties}
            onChange={(event) => move(Number(event.target.value))}
            onPointerUp={() => commit(draft)}
            onKeyUp={() => commit(draft)}
            onBlur={() => commit(draft)}
          />
          <span
            className="settings-slider-mark"
            style={{ '--at': mark.toFixed(4) } as CSSProperties}
            title={`Automatic: ${describe(snap(automatic, min, max, step))}`}
            aria-hidden="true"
          />
          {(minLabel || maxLabel) && (
            <div className="settings-slider-ends" aria-hidden="true">
              <span>{minLabel}</span>
              <span>{maxLabel}</span>
            </div>
          )}
        </div>

        <label className="settings-number">
          <input
            type="text"
            inputMode="decimal"
            className="settings-number-input"
            value={text}
            disabled={isAuto}
            aria-label={`${label}, in ${unit}`}
            onChange={(event) => setText(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitText();
              }
            }}
          />
          <span className="settings-number-unit">{unit}</span>
        </label>
      </div>

      <p className={shownHint.warn ? 'settings-hint is-warn' : 'settings-hint'}>{shownHint.text}</p>
    </div>
  );
}

/** The nearest value the slider can actually rest on, inside its range. */
function snap(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const stepped = min + Math.round((value - min) / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

/** "4" rather than "4.0", "4.5" rather than "4.50": what a person would type. */
function formatShown(shown: number): string {
  return String(Math.round(shown * 100) / 100);
}
