import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Icons } from './Icons';
import { cls } from '../lib/util';
import { DOCUMENTS, NOTES, PROJECTS } from '../lib/mock';
import type { Route } from '../types';

interface PaletteItem {
  kind: 'project' | 'document' | 'note' | 'action';
  id: string;
  title: string;
  sub: string;
  icon: ReactNode;
  action: () => void;
}

interface PaletteGroup {
  name: string;
  items: PaletteItem[];
}

interface Props {
  onClose: () => void;
  onRoute: (r: Route) => void;
}

export function CommandPalette({ onClose, onRoute }: Props) {
  const [q, setQ] = useState('');

  const groups: PaletteGroup[] = useMemo(() => {
    const projs: PaletteItem[] = PROJECTS.filter(p => p.status === 'active').map(p => ({
      kind: 'project',
      id: p.id,
      title: p.name,
      sub: p.desc,
      icon: <span className={cls('sb-proj-dot', p.accent)} />,
      action: () => onRoute({ route: 'project', project: p.id }),
    }));
    const docs: PaletteItem[] = (DOCUMENTS.claudepit || []).map(d => ({
      kind: 'document',
      id: d.id,
      title: d.title,
      sub: 'doc · claudepit',
      icon: <Icons.Doc size={13} />,
      action: () => {},
    }));
    const notes: PaletteItem[] = (NOTES.claudepit || []).map(n => ({
      kind: 'note',
      id: n.id,
      title: n.title,
      sub: 'note · claudepit',
      icon: <Icons.Note size={13} />,
      action: () => {},
    }));
    const cmds: PaletteItem[] = [
      { kind: 'action', id: 'new-project', title: 'Create new project', sub: 'shortcut · ⌘P', icon: <Icons.Plus size={13} />, action: () => {} },
      { kind: 'action', id: 'upload', title: 'Upload file…', sub: 'to current project', icon: <Icons.Upload size={13} />, action: () => {} },
      { kind: 'action', id: 'new-note', title: 'New note', sub: 'in current project', icon: <Icons.Note size={13} />, action: () => {} },
      { kind: 'action', id: 'go-inbox', title: 'Go to Inbox', sub: 'shortcut · G then I', icon: <Icons.Inbox size={13} />, action: () => onRoute({ route: 'inbox' }) },
      { kind: 'action', id: 'go-tags', title: 'Go to Tags', sub: 'shortcut · G then T', icon: <Icons.Tag size={13} />, action: () => onRoute({ route: 'tags' }) },
      { kind: 'action', id: 'toggle-theme', title: 'Toggle theme', sub: 'shortcut · ⌘⇧L', icon: <Icons.Moon size={13} />, action: () => {} },
    ];

    const lower = q.toLowerCase();
    const filt = (xs: PaletteItem[]) =>
      q ? xs.filter(x => x.title.toLowerCase().includes(lower) || x.sub.toLowerCase().includes(lower)) : xs;

    return [
      { name: 'Projects', items: filt(projs).slice(0, 5) },
      { name: 'Documents', items: filt(docs).slice(0, 4) },
      { name: 'Notes', items: filt(notes).slice(0, 4) },
      { name: 'Actions', items: filt(cmds) },
    ].filter(g => g.items.length);
  }, [q, onRoute]);

  return (
    <div
      className="cmdk-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk">
        <div className="cmdk-input">
          <Icons.Search />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search projects, documents, notes, todos, or run a command…"
            autoFocus
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-results">
          {groups.map((g, gi) => (
            <Fragment key={g.name}>
              <div className="cmdk-group-h">{g.name}</div>
              {g.items.map((it, i) => (
                <div
                  key={it.id}
                  className={cls('cmdk-row', i === 0 && gi === 0 && 'active')}
                  onClick={() => {
                    it.action();
                    onClose();
                  }}
                >
                  <div className="icb">{it.icon}</div>
                  <div>
                    <div className="nm">{it.title}</div>
                    <div className="sub">{it.sub}</div>
                  </div>
                  <Icons.ChevronRight size={11} style={{ color: 'var(--fg-subtle)' }} />
                </div>
              ))}
            </Fragment>
          ))}
        </div>
        <div className="cmdk-foot">
          <span>
            <span className="kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">⌘↵</span> open in new pane
          </span>
          <span style={{ marginLeft: 'auto' }}>184ms · 32 results</span>
        </div>
      </div>
    </div>
  );
}
