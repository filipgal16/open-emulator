import { useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { WORKSPACE_SHORTCUTS, rovingIndex } from '../keyboard';

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

/** Left rail: the device is the workspace; Apps, Store, and Settings are places you visit. */
export function NavRail({ active, onSelect }: Props) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(from: WorkspaceId, key: string) {
    const next = rovingIndex(key, ORDER.indexOf(from), ORDER.length);
    if (next < 0) return;
    const id = ORDER[next];
    onSelect(id);
    itemRefs.current[next]?.focus();
  }

  return (
    <nav className="nav-rail" aria-label="Workspace">
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
      <span className="nav-rail-spacer" aria-hidden="true" />
      <RailItem
        refFn={(node) => {
          itemRefs.current[ITEMS.length] = node;
        }}
        item={SETTINGS}
        active={active}
        shortcut={shortcutFor(SETTINGS.id)}
        onSelect={onSelect}
        onMove={move}
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
}: {
  item: { id: WorkspaceId; label: string; icon: IconName };
  active: WorkspaceId;
  shortcut?: string;
  onSelect: (id: WorkspaceId) => void;
  onMove: (from: WorkspaceId, key: string) => void;
  refFn: (node: HTMLButtonElement | null) => void;
}) {
  const current = active === item.id;
  const hint = shortcut ? `${item.label} (Alt+${shortcut})` : item.label;
  return (
    <button
      ref={refFn}
      type="button"
      className={current ? 'nav-rail-item on' : 'nav-rail-item'}
      aria-current={current ? 'page' : undefined}
      aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
      title={hint}
      tabIndex={current ? 0 : -1}
      onClick={() => onSelect(item.id)}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          onMove(item.id, event.key);
        }
      }}
    >
      <Icon name={item.icon} size={20} />
      <span>{item.label}</span>
    </button>
  );
}
