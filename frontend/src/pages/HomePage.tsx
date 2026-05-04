import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { Checkbox, Priority } from '../components/primitives';
import { Spark } from '../components/primitives';
import { ProjectCard } from '../components/ProjectCard';
import {
  getStats,
  listActivity,
  listProjectCounts,
  listProjects,
  listTodos,
} from '../lib/api';
import { toUiActivity, toUiProjects, toUiStats, toUiTodo } from '../lib/view';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { Route } from '../types';

interface Props {
  onRoute: (r: Route) => void;
}

export function HomePage({ onRoute }: Props) {
  const queries = useQueries({
    queries: [
      { queryKey: ['stats'], queryFn: () => getStats() },
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
      { queryKey: ['todos', 'inbox'], queryFn: () => listTodos({ project_id: 'null' }) },
      { queryKey: ['activity', 'recent'], queryFn: () => listActivity({ limit: 6 }) },
    ],
  });
  const [statsQ, projectsQ, countsQ, inboxQ, activityQ] = queries;

  const projectsRaw = projectsQ.data ?? [];
  const projectsById = useMemo(
    () => new Map(projectsRaw.map((p) => [p.id, p])),
    [projectsRaw],
  );
  const projects = useMemo(
    () => toUiProjects(projectsRaw, countsQ.data ?? []),
    [projectsRaw, countsQ.data],
  );
  const pinned = projects.filter((p) => p.pinned && p.status === 'active');
  const inbox = (inboxQ.data ?? []).slice(0, 4).map(toUiTodo);
  const activity = (activityQ.data ?? []).map((e) => toUiActivity(e, projectsById));
  const stats = statsQ.data ? toUiStats(statsQ.data) : null;

  const isLoading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error;

  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load home: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  if (isLoading || !stats) {
    return (
      <div className="page">
        <div className="page-subtle">Loading…</div>
      </div>
    );
  }

  const inboxCount = inboxQ.data?.length ?? 0;
  const todosTotal = stats.counts.todos;
  const donePct = todosTotal > 0 ? Math.round((stats.counts.done / todosTotal) * 100) : 0;

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Welcome back, Alex.</h1>
          <p className="page-subtle">
            You have <b style={{ color: 'var(--fg)' }}>{stats.processing.pending} document processing</b>,{' '}
            <b style={{ color: 'var(--fg)' }}>{inboxCount} todos in your inbox</b>, and {pinned.length} active projects pinned.
            {stats.freshness.last_edit_ms > 0 ? (
              <> Last edit was {fmtRel(new Date(Date.now() - stats.freshness.last_edit_ms).toISOString())}.</>
            ) : null}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => onRoute({ route: 'projects', action: 'new' })}>
          <Icons.Plus /> New project
        </button>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="lb">Projects</div>
          <div className="vl">{stats.counts.projects}</div>
          <div className="ds">{pinned.length} pinned · {projects.filter(p => p.status === 'active').length} active</div>
          <span className="spark" style={{ color: 'var(--accent-1)' }}>
            <Spark data={[2, 3, 3, 4, 4, 5, 5]} />
          </span>
        </div>
        <div className="stat-card">
          <div className="lb">Documents</div>
          <div className="vl tabular">{stats.counts.documents}</div>
          <div className="ds">
            {stats.processing.pending > 0 ? `${stats.processing.pending} pending` : 'all ready'}
            {stats.processing.failed > 0 ? ` · ${stats.processing.failed} failed` : ''}
          </div>
          <span className="spark" style={{ color: 'oklch(0.74 0.08 220)' }}>
            <Spark data={[35, 38, 41, 42, 44, 47, 50]} />
          </span>
        </div>
        <div className="stat-card">
          <div className="lb">Notes</div>
          <div className="vl tabular">{stats.counts.notes}</div>
          <div className="ds">in {projects.filter(p => p.counts.notes > 0).length} projects</div>
          <span className="spark" style={{ color: 'oklch(0.74 0.10 80)' }}>
            <Spark data={[40, 41, 43, 43, 44, 45, 46]} />
          </span>
        </div>
        <div className="stat-card">
          <div className="lb">Todos</div>
          <div className="vl tabular">
            {stats.counts.done}/{todosTotal}
          </div>
          <div className="ds">{donePct}% complete</div>
          <span className="spark" style={{ color: 'oklch(0.74 0.10 150)' }}>
            <Spark data={[12, 14, 16, 18, 20, 22, 23]} />
          </span>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Pinned projects</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => onRoute({ route: 'projects' })}>
            All projects →
          </button>
        </div>
        {pinned.length > 0 ? (
          <div className="proj-grid">
            {pinned.map((p) => (
              <ProjectCard key={p.id} p={p} size="lg" onOpen={() => onRoute({ route: 'project', project: p.id })} />
            ))}
          </div>
        ) : (
          <div className="page-subtle">No pinned projects yet — pin from any project menu.</div>
        )}
      </div>

      <div className="section home-bottom-grid">
        <div>
          <div className="section-head">
            <h2>Inbox · todos with no project</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => onRoute({ route: 'inbox' })}>
              Open inbox →
            </button>
          </div>
          <div className="row-list">
            {inbox.length === 0 ? (
              <div className="page-subtle">Inbox is empty.</div>
            ) : (
              inbox.map((t) => (
                <div key={t.id} className="row" style={{ gridTemplateColumns: '20px 1fr auto auto' }}>
                  <Checkbox checked={t.status === 'done'} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</div>
                    {t.due_at ? (
                      <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                        <span className={isOverdue(t.due_at) ? 'due-overdue' : ''}>due {fmtRel(t.due_at)}</span>
                      </div>
                    ) : null}
                  </div>
                  <Priority p={t.priority} />
                  <span className="subtle mono" style={{ fontSize: 10.5 }}>
                    {fmtRel(t.created_at)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="section-head">
            <h2>Recent activity</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => onRoute({ route: 'activity' })}>
              Full feed →
            </button>
          </div>
          <div className="row-list">
            {activity.length === 0 ? (
              <div className="page-subtle">No recent activity.</div>
            ) : (
              activity.map((a) => (
                <div key={a.id} className="activity-row">
                  <div className={cls('activity-icon', a.kind)}>
                    {a.kind === 'ingest' ? <Icons.Upload size={12} /> : a.kind === 'edit' ? <Icons.Note size={12} /> : <Icons.Chat size={12} />}
                  </div>
                  <div className="text">
                    {a.kind === 'ingest' ? 'Ingested' : a.kind === 'edit' ? 'Edited' : 'Commented on'} <b>{a.title}</b>
                    <span className="subtle mono" style={{ fontSize: 10, marginLeft: 6 }}>
                      · {a.project}
                    </span>
                  </div>
                  <span className="ts">{fmtRel(a.at)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
