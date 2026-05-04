import { Fragment } from 'react';
import { Icons } from './Icons';
import type { Theme } from '../types';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

interface Props {
  crumbs: Crumb[];
  onCmdK: () => void;
  onTheme: (t: Theme) => void;
  theme: Theme;
}

export function Topbar({ crumbs, onCmdK, onTheme, theme }: Props) {
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
        <div className="thm-toggle">
          <button className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}>
            <Icons.Moon size={13} />
          </button>
          <button className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}>
            <Icons.Sun size={13} />
          </button>
        </div>
      </div>
    </header>
  );
}
