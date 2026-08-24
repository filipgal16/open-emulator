import { Icon, type IconName } from './Icon';

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

interface Props {
  active: WorkspaceId;
  onSelect: (id: WorkspaceId) => void;
}

/** Left rail: the device is the workspace; Apps, Store, and Settings are places you visit. */
export function NavRail({ active, onSelect }: Props) {
  return (
    <nav className="nav-rail" aria-label="Workspace">
      {ITEMS.map((item) => (
        <RailItem key={item.id} item={item} active={active} onSelect={onSelect} />
      ))}
      <span className="nav-rail-spacer" aria-hidden="true" />
      <RailItem item={SETTINGS} active={active} onSelect={onSelect} />
    </nav>
  );
}

function RailItem({
  item,
  active,
  onSelect,
}: {
  item: { id: WorkspaceId; label: string; icon: IconName };
  active: WorkspaceId;
  onSelect: (id: WorkspaceId) => void;
}) {
  return (
    <button
      type="button"
      className={active === item.id ? 'nav-rail-item on' : 'nav-rail-item'}
      aria-current={active === item.id ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
    >
      <Icon name={item.icon} size={20} />
      <span>{item.label}</span>
    </button>
  );
}
