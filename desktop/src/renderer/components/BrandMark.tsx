interface Props {
  /** `sm` is the titlebar's tile: the dot alone. `lg` is the first-run mark, with the phone drawn round it. */
  size: 'sm' | 'lg';
  /** Something is being waited for, so the dot breathes. */
  live?: boolean;
}

/**
 * The mark: an ink tile, and a mint dot.
 *
 * The dot is the brand — the only colour the shell owns — so it is also what says "alive": it
 * breathes while the app is working and sits still when it is not. At titlebar size there is no
 * room for a drawing, so the small mark is the tile and the dot; the large one draws the phone
 * the dot is the heart of.
 */
export function BrandMark({ size, live = false }: Props) {
  return (
    <span className={`brand-mark brand-mark-${size}${live ? ' is-live' : ''}`} aria-hidden="true">
      {size === 'lg' && (
        <svg viewBox="0 0 32 32">
          <rect x="9.5" y="4.5" width="13" height="23" rx="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="13.6" y="7.3" width="4.8" height="1.2" rx="0.6" fill="currentColor" opacity="0.5" />
        </svg>
      )}
      <span className="brand-dot" />
    </span>
  );
}
