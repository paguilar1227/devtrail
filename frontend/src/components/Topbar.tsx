import { Fragment } from 'react';
import { Icons } from './Icons';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

interface Props {
  crumbs: Crumb[];
  onCmdK: () => void;
}

export function Topbar({ crumbs, onCmdK }: Props) {
  return (
    <header className="topbar">
      <div className="crumb">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="sep">›</span> : null}
            <span className={i === crumbs.length - 1 ? '' : 'ctx'} onClick={c.onClick}>
              {c.label}
            </span>
          </Fragment>
        ))}
      </div>
      <div className="search" onClick={onCmdK}>
        <span style={{ color: 'var(--fg-subtle)' }}><Icons.Search /></span>
        <input placeholder="Search across all projects…" readOnly />
        <span className="kbd">⌘K</span>
      </div>
      <div className="topbar-actions">
        <button className="btn btn-ghost btn-icon icon-search" onClick={onCmdK}>
          <Icons.Search />
        </button>
      </div>
    </header>
  );
}
