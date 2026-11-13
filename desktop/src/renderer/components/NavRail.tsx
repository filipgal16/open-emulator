import { useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { WORKSPACE_SHORTCUTS, rovingIndex } from '../keyboard';
import { updateNeedsAttention, useUpdateState } from '../hooks/useUpdateState';

export type WorkspaceId = 'screen' | 'apps' | 'store' | 'settings';

const ITEMS: Array<{ id: WorkspaceId; label: string; icon: IconName }> = [
  { id: 'screen', label: 'Device', icon: 'device' },
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'store', label: 'Store', icon: 'store' },
];

const SETTINGS: { id: WorkspaceId; label: string; icon: IconName } = {
  id: 'settings',
  label: 'Settings',
  icon: 'settings',
};

const ORDER: WorkspaceId[] = [...ITEMS.map((item) => item.id), SETTINGS.id];

interface Props {
  active: WorkspaceId;
  onSelect: (id: WorkspaceId) => void;
}

function shortcutFor(id: WorkspaceId): string | undefined {
  return WORKSPACE_SHORTCUTS.find((entry) => entry.id === id)?.digit;
}

/** Titlebar tabs: Device, Apps, and Store share a track; Settings is a place you visit. */
export function NavRail({ active, onSelect }: Props) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Subscribed here because the rail is always mounted, so the dot appears without anyone having
  // opened Settings first.
  const updateWaiting = updateNeedsAttention(useUpdateState());

  function move(from: WorkspaceId, key: string) {
    const next = rovingIndex(key, ORDER.indexOf(from), ORDER.length);
    if (next < 0) return;
    const id = ORDER[next];
    onSelect(id);
    itemRefs.current[next]?.focus();
  }

  return (
    <nav className="nav-rail" aria-label="Workspace">
      <div className="nav-track">
        {ITEMS.map((item, index) => (
          <RailItem
            key={item.id}
            refFn={(node) => {
              itemRefs.current[index] = node;
            }}
            item={item}
            active={active}
            shortcut={shortcutFor(item.id)}
            onSelect={onSelect}
            onMove={move}
          />
        ))}
      </div>
      <RailItem
        refFn={(node) => {
          itemRefs.current[ITEMS.length] = node;
        }}
        item={SETTINGS}
        active={active}
        shortcut={shortcutFor(SETTINGS.id)}
        onSelect={onSelect}
        onMove={move}
        utility
        attention={updateWaiting ? 'update available' : undefined}
      />
    </nav>
  );
}

function RailItem({
  item,
  active,
  shortcut,
  onSelect,
  onMove,
  refFn,
  utility,
  attention,
}: {
  item: { id: WorkspaceId; label: string; icon: IconName };
  active: WorkspaceId;
  shortcut?: string;
  onSelect: (id: WorkspaceId) => void;
  onMove: (from: WorkspaceId, key: string) => void;
  refFn: (node: HTMLButtonElement | null) => void;
  utility?: boolean;
  /** Something is waiting here. Shown as a dot, and said in words for a screen reader. */
  attention?: string;
}) {
  const current = active === item.id;
  const label = attention ? `${item.label}, ${attention}` : item.label;
  const hint = shortcut ? `${label} (Alt+${shortcut})` : label;
  const className = [
    'nav-rail-item',
    current ? 'on' : '',
    utility ? 'is-utility' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={refFn}
      type="button"
      className={className}
      aria-current={current ? 'page' : undefined}
      aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
      title={hint}
      aria-label={attention ? label : undefined}
      tabIndex={current ? 0 : -1}
      onClick={() => onSelect(item.id)}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          onMove(item.id, event.key);
        }
      }}
    >
      <Icon name={item.icon} size={utility ? 18 : 16} />
      <span className="nav-rail-label">{item.label}</span>
      {attention && <span className="nav-rail-dot" aria-hidden="true" />}
    </button>
  );
}
