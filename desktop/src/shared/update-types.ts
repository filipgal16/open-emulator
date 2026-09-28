/**
 * App self-update state, as the renderer sees it.
 *
 * Updates are offered, never taken: a check can happen on its own, but nothing is downloaded until
 * someone asks, and nothing is installed until they ask again (or quit after downloading).
 */
export type UpdatePhase =
  /** A development run. Only an installed build can update itself. */
  | 'unsupported'
  /** Nothing checked yet this session. */
  | 'idle'
  | 'checking'
  | 'up-to-date'
  /** A newer version exists and is waiting for someone to choose to download it. */
  | 'available'
  | 'downloading'
  /** Downloaded and verified; installs on restart, or the next time the app closes. */
  | 'ready'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  /** The version on offer, once a check has found one. */
  latestVersion: string | null;
  /** 0–100 while downloading, otherwise null. */
  percent: number | null;
  /** What went wrong, or why updating is unavailable — phrased for the person reading it. */
  message: string | null;
  /** When the last check finished, as epoch milliseconds. */
  checkedAt: number | null;
}
