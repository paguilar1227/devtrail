import { useState } from 'react';
import { Icons } from './Icons';
import { cls } from '../lib/util';
import { PROJECTS } from '../lib/mock';
import type { Route, Theme } from '../types';

interface Props {
  route: Route;
  onRoute: (r: Route) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}

export function MobileTabbar({ route, onRoute, theme, onTheme }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const items = [
    { id: 'home' as const, label: 'Home', icon: <Icons.Home /> },
    { id: 'projects' as const, label: 'Projects', icon: <Icons.Folders /> },
    { id: 'inbox' as const, label: 'Inbox', icon: <Icons.Inbox /> },
  ];
  const pinned = PROJECTS.filter(p => p.pinned);

  const go = (next: Route) => {
    setMoreOpen(false);
    onRoute(next);
  };

  return (
    <>
      <nav className="mobile-tabbar show">
        {items.map(it => (
          <div
            key={it.id}
            className={cls('mtab', route.route === it.id && 'active')}
            onClick={() => onRoute({ route: it.id })}
          >
            <span className="ic">{it.icon}</span>
            <span>{it.label}</span>
          </div>
        ))}
        <div className={cls('mtab', moreOpen && 'active')} onClick={() => setMoreOpen(true)}>
          <span className="ic"><Icons.More /></span>
          <span>More</span>
        </div>
      </nav>
      {moreOpen && (
        <>
          <div className="m-sheet-overlay" onClick={() => setMoreOpen(false)} />
          <div className="m-sheet" role="dialog" aria-label="More">
            <div className="m-sheet-grip" />
            <div className="m-sheet-h">
              <span>More</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setMoreOpen(false)}>
                <Icons.X />
              </button>
            </div>

            <div className="m-sheet-section">Workspace</div>
            <div className="m-sheet-list">
              <button className={cls('m-sheet-row', route.route === 'activity' && 'active')} onClick={() => go({ route: 'activity' })}>
                <span className="ic"><Icons.Activity /></span><span>Activity</span>
              </button>
              <button className={cls('m-sheet-row', route.route === 'tags' && 'active')} onClick={() => go({ route: 'tags' })}>
                <span className="ic"><Icons.Tag /></span><span>Tags</span>
              </button>
              <button className={cls('m-sheet-row', route.route === 'mentions' && 'active')} onClick={() => go({ route: 'mentions' })}>
                <span className="ic"><Icons.Hash /></span><span>Mentions</span>
              </button>
              <button className={cls('m-sheet-row', route.route === 'trash' && 'active')} onClick={() => go({ route: 'trash' })}>
                <span className="ic"><Icons.ArchiveBox /></span><span>Archived</span>
              </button>
            </div>

            <div className="m-sheet-section">
              Pinned <span className="ct">{pinned.length}</span>
            </div>
            <div className="m-sheet-list">
              {pinned.map(p => (
                <button key={p.id} className="m-sheet-row" onClick={() => go({ route: 'project', project: p.id })}>
                  <span className={cls('sb-proj-dot', p.accent)}></span>
                  <span>{p.name}</span>
                  <span className="sub mono">{p.counts.docs + p.counts.notes}</span>
                </button>
              ))}
              {pinned.length === 0 && <div className="m-sheet-empty">No pinned projects yet.</div>}
            </div>

            <div className="m-sheet-section">Settings</div>
            <div className="m-sheet-user">
              <div className="ic-avatar">P</div>
              <div className="grow">
                <div className="nm">Alex</div>
                <div className="em">you@example.com</div>
              </div>
            </div>
            <div className="m-sheet-list">
              <button className="m-sheet-row" onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}>
                <span className="ic">{theme === 'dark' ? <Icons.Sun /> : <Icons.Moon />}</span>
                <span>Appearance</span>
                <span className="sub mono">{theme === 'dark' ? 'Dark' : 'Light'}</span>
              </button>
              <button className="m-sheet-row">
                <span className="ic"><Icons.Cog /></span><span>Account &amp; preferences</span><span className="sub">›</span>
              </button>
              <button className="m-sheet-row">
                <span className="ic"><Icons.Inbox /></span><span>Notifications</span><span className="sub">›</span>
              </button>
              <button className="m-sheet-row">
                <span className="ic"><Icons.Layers /></span><span>Connected sources</span><span className="sub">›</span>
              </button>
              <button className="m-sheet-row">
                <span className="ic"><Icons.Sparkle /></span><span>Help &amp; shortcuts</span><span className="sub">›</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
