import { Icon, type IconName } from './Icon';

export type WorkspaceId = 'screen' | 'apps' | 'store';

const ITEMS: Array<{ id: WorkspaceId; label: string; icon: IconName }> = [
  { id: 'screen', label: 'Device', icon: 'device' },
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'store', label: 'Store', icon: 'store' },
];

interface Props {
  active: WorkspaceId;
  onSelect: (id: WorkspaceId) => void;
}

/** Left rail: the device is the workspace; Apps and Store are places you visit. */
export function NavRail({ active, onSelect }: Props) {
  return (
    <nav className="nav-rail" aria-label="Workspace">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={active === item.id ? 'nav-rail-item on' : 'nav-rail-item'}
          aria-current={active === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
