import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Icons } from './Icons';
import { cls } from '../lib/util';
import { listProjects, listTodos } from '../lib/api';
import { toUiProjects } from '../lib/view';
import type { Route } from '../types';

interface Props {
  route: Route;
  onRoute: (r: Route) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ route, onRoute, collapsed, onToggleCollapsed }: Props) {
  const [projectsQ, inboxQ] = useQueries({
    queries: [
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      { queryKey: ['todos', 'inbox'], queryFn: () => listTodos({ project_id: 'null' }) },
    ],
  });

  const projects = useMemo(
    () => toUiProjects(projectsQ.data ?? []).filter(p => p.status === 'active'),
    [projectsQ.data],
  );
  const inboxCount = inboxQ.data?.length ?? 0;
  const activeProjectId = route.route === 'project' ? route.project : null;
  const isRoute = (name: Route['route']) => route.route === name;

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="logo">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3.5c-1.4 0-2.5 1.1-2.5 2.5 0 .5.2 1 .5 1.4-.6.4-1 1.1-1 1.9 0 1.2.9 2.2 2 2.4M5 3.5c.6-.6 1.4-1 2.3-1 1 0 1.9.5 2.4 1.3M5 3.5v9.4M11 3.5c1.4 0 2.5 1.1 2.5 2.5 0 .5-.2 1-.5 1.4.6.4 1 1.1 1 1.9 0 1.2-.9 2.2-2 2.4M11 3.5c-.6-.6-1.4-1-2.3-1M11 3.5v9.4M5 13c.6.6 1.4 1 2.3 1 1.4 0 2.5-1.1 2.5-2.5M11 13c-.6.6-1.4 1-2.3 1" />
          </svg>
        </div>
        <div className="name">Open Brain</div>
        <div className="ver">2.5</div>
        <button
          className="sb-collapse"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <Icons.ChevronRight size={12} /> : <Icons.ChevronLeft size={12} />}
        </button>
      </div>

      <div className="sb-section">Workspace</div>
      <div className={cls('sb-item', isRoute('home') && 'active')} onClick={() => onRoute({ route: 'home' })}>
        <span className="ic"><Icons.Home /></span>
        <span className="label">Home</span>
      </div>
      <div className={cls('sb-item', isRoute('projects') && 'active')} onClick={() => onRoute({ route: 'projects' })}>
        <span className="ic"><Icons.Folders /></span>
        <span className="label">Projects</span>
        <span className="count">{projects.length}</span>
      </div>
      <div className={cls('sb-item', isRoute('inbox') && 'active')} onClick={() => onRoute({ route: 'inbox' })}>
        <span className="ic"><Icons.Inbox /></span>
        <span className="label">Inbox</span>
        <span className="count">{inboxCount}</span>
      </div>
      <div className={cls('sb-item', isRoute('activity') && 'active')} onClick={() => onRoute({ route: 'activity' })}>
        <span className="ic"><Icons.Activity /></span>
        <span className="label">Activity</span>
      </div>
      <div className={cls('sb-item', isRoute('tags') && 'active')} onClick={() => onRoute({ route: 'tags' })}>
        <span className="ic"><Icons.Tag /></span>
        <span className="label">Tags</span>
      </div>
      <div className={cls('sb-item', isRoute('mentions') && 'active')} onClick={() => onRoute({ route: 'mentions' })}>
        <span className="ic"><Icons.Hash /></span>
        <span className="label">Mentions</span>
      </div>
      <div className={cls('sb-item', isRoute('trash') && 'active')} onClick={() => onRoute({ route: 'trash' })}>
        <span className="ic"><Icons.ArchiveBox /></span>
        <span className="label">Archived</span>
      </div>

      <div className="sb-section" style={{ marginTop: 8 }}>Pinned</div>
      <div className="sb-projects">
        {projects.filter(p => p.pinned).map(p => (
          <div
            key={p.id}
            className={cls('sb-item', isRoute('project') && activeProjectId === p.id && 'active')}
            onClick={() => onRoute({ route: 'project', project: p.id })}
          >
            <span className={cls('sb-proj-dot', p.accent)}></span>
            <span className="label">{p.name}</span>
          </div>
        ))}
        <div className="sb-section" style={{ marginTop: 8 }}>All Projects</div>
        {projects.filter(p => !p.pinned).map(p => (
          <div
            key={p.id}
            className={cls('sb-item', isRoute('project') && activeProjectId === p.id && 'active')}
            onClick={() => onRoute({ route: 'project', project: p.id })}
          >
            <span className={cls('sb-proj-dot', p.accent)}></span>
            <span className="label">{p.name}</span>
          </div>
        ))}
        <div className="sb-item dim" onClick={() => onRoute({ route: 'projects', action: 'new' })}>
          <span className="ic"><Icons.Plus /></span>
          <span className="label">New project</span>
        </div>
      </div>

      <div className="sb-footer">
        <div className="sb-avatar">P</div>
        <div className="sb-user">
          <div className="nm">Alex</div>
          <div className="em">you@example.com</div>
        </div>
        <span className="sb-cog"><Icons.Cog /></span>
      </div>
    </aside>
  );
}
