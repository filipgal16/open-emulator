/**
 * Resizing the guest's display to follow the app window.
 *
 * Two things could be meant by "scale Android with the window", and they are not the same:
 *
 *   **Scale the picture.** The guest keeps its 1080x1920 panel and the mirrored image is stretched
 *   to fit. Cheap, and wrong: a wide window gets thick black bars, and upscaling is blurry.
 *
 *   **Scale the display.** The guest's *logical* display really becomes the window's size, so
 *   Android re-lays out at that geometry and apps use the whole area. This is what LDPlayer does,
 *   and it is what this module implements.
 *
 * The panel itself (`hw.lcd.*`) is hardware, fixed when the AVD boots. What can change at runtime
 * is the logical display, via `wm size` and `wm density` — so that is the lever, and it works
 * identically on both runtimes because it is a guest-side command.
 */

export interface Size {
  width: number;
  height: number;
}

export interface DisplayGeometry extends Size {
  density: number;
}

/**
 * Bounds, each guarding a real failure rather than a matter of taste.
 *
 * `MIN_EDGE` — below roughly this, Android's own system UI stops fitting and the launcher starts
 * dropping rows. `MAX_EDGE` — the guest renders every pixel for real, so an unbounded 4K display
 * costs frame rate for detail nobody can see on a scaled-down mirror.
 *
 * `MAX_ASPECT` is the load-bearing one. Android assumes a plausible phone or tablet shape; give it
 * a 5:1 letterbox and app layouts genuinely break — dialogs overflow, bottom bars vanish. 2.4
 * clears every shipping phone aspect (21:9 is 2.33), and anything wider than that letterboxes in
 * the viewport instead, which is the lesser evil.
 */
const MIN_EDGE = 360;
const MAX_EDGE = 2560;
const MAX_ASPECT = 2.4;
const MIN_DENSITY = 120;
const MAX_DENSITY = 640;

/** Android's reference density: 160dpi is 1dp = 1px. */
const BASELINE_DPI = 160;

export interface ResolveInput {
  /** The viewport's size in real device pixels — CSS pixels times the display scale factor. */
  viewport: Size;
  /** The guest's physical panel, as reported by `wm size` / `wm density`. */
  base: DisplayGeometry;
}

/**
 * The logical display to ask the guest for, given a viewport to fill.
 *
 * Density is not carried over unchanged, and that is the whole trick. Ask for 900x600 at the
 * panel's own 440dpi and Android sees a 327dp x 218dp display — shorter than almost any app's
 * minimum, and layouts collapse. Instead the **smallest width in dp is preserved**: whatever
 * shape the window takes, the guest keeps reporting the same `sw` bucket it booted with, so apps
 * stay in the layout they were designed for and simply get more room along the long axis.
 *
 * The alternative — a fixed density — makes apps jump between phone and tablet layouts as the
 * window is dragged, which looks like a bug even though it is Android working correctly.
 */
export function resolveDisplayGeometry(input: ResolveInput): DisplayGeometry {
  const { viewport, base } = input;

  const baseShortEdge = Math.min(base.width, base.height);
  const baseSwDp = (baseShortEdge * BASELINE_DPI) / base.density;

  let width = clamp(Math.round(viewport.width), MIN_EDGE, MAX_EDGE);
  let height = clamp(Math.round(viewport.height), MIN_EDGE, MAX_EDGE);

  // Trim the long edge rather than padding the short one: growing a dimension would ask the guest
  // to render pixels the window has nowhere to show.
  if (width > height * MAX_ASPECT) width = Math.round(height * MAX_ASPECT);
  else if (height > width * MAX_ASPECT) height = Math.round(width * MAX_ASPECT);

  // Odd dimensions are rejected outright by some encoders and quietly rounded by others, which
  // then disagrees with what the mirror thinks it is decoding.
  width = makeEven(width);
  height = makeEven(height);

  const density = clamp(
    Math.round((Math.min(width, height) * BASELINE_DPI) / baseSwDp),
    MIN_DENSITY,
    MAX_DENSITY,
  );

  return { width, height, density };
}

/**
 * Below this, a change is noise rather than a resize: a scrollbar appearing, a 1px border, a
 * rounding wobble as the layout settles.
 *
 * It matters because the cost is asymmetric. Ignoring a 4px change is invisible; acting on one
 * reconfigures the display and re-lays out every visible activity, which is not.
 */
const MIN_CHANGE_PX = 16;

/**
 * Whether a geometry differs from the applied one by enough to be worth the reconfiguration.
 *
 * Compared on pixels alone, not density: density is derived from the pixel dimensions, so it
 * cannot move on its own, and including it would let a 1px wobble that shifts the rounded dpi by
 * one defeat the whole dead zone.
 */
export function worthApplying(applied: DisplayGeometry | null, next: DisplayGeometry): boolean {
  if (!applied) return true;
  return (
    Math.abs(applied.width - next.width) >= MIN_CHANGE_PX ||
    Math.abs(applied.height - next.height) >= MIN_CHANGE_PX
  );
}

/**
 * `wm size` reports the panel first and any override second:
 *
 *     Physical size: 1080x1920
 *     Override size: 1600x900
 *
 * Only the physical line is of interest — reading the override back as the base would compound
 * every resize on top of the last one, and the display would drift smaller with each drag.
 */
export function parsePhysicalSize(stdout: string): Size | null {
  const match = /Physical size:\s*(\d+)x(\d+)/i.exec(stdout);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { width, height };
}

/** As `parsePhysicalSize`, for `Physical density: 440`. */
export function parsePhysicalDensity(stdout: string): number | null {
  const match = /Physical density:\s*(\d+)/i.exec(stdout);
  if (!match) return null;
  const density = Number(match[1]);
  return density > 0 ? density : null;
}

/**
 * The commands that apply a geometry, in the order they must run.
 *
 * Size before density: `wm size` triggers a display reconfiguration that Android services react
 * to, and following it with the density change lets both land in one settling period instead of
 * two visible re-layouts.
 */
export function applyCommands(geometry: DisplayGeometry): string[] {
  return [`wm size ${geometry.width}x${geometry.height}`, `wm density ${geometry.density}`];
}

/** Hands the display back to the panel's own geometry. */
export function resetCommands(): string[] {
  return ['wm size reset', 'wm density reset'];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeEven(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}
