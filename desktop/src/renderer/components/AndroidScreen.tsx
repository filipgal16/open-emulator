import { GuestSurface } from './GuestSurface';

interface Props {
  /** Fires once, when the guest first paints — the signal that the boot wait is over. */
  onFirstFrame?: () => void;
}

/**
 * The device workspace.
 *
 * Everything about mirroring and input lives in `GuestSurface`, which the Store's Play frame
 * shares — this is just where it sits in the layout.
 */
export function AndroidScreen({ onFirstFrame }: Props = {}) {
  return <GuestSurface onFirstFrame={onFirstFrame} />;
}
