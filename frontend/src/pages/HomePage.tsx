import { Icons } from '../components/Icons';
import { Checkbox, Priority } from '../components/primitives';
import { Spark } from '../components/primitives';
import { ProjectCard } from '../components/ProjectCard';
import { ACTIVITY, INBOX_TODOS, PROJECTS, STATS } from '../lib/mock';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { Route } from '../types';

interface Props {
  onRoute: (r: Route) => void;
}

export function HomePage({ onRoute }: Props) {
  const s = STATS;
  const projects = PROJECTS.filter(p => p.status === 'active');
  const pinned = projects.filter(p => p.pinned);
  const inbox = INBOX_TODOS.slice(0, 4);
  const activity = ACTIVITY.slice(0, 6);

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Welcome back, Alex.</h1>
          <p className="page-subtle">
            You have <b style={{ color: 'var(--fg)' }}>{s.processing.pending} document processing</b>,{' '}
            <b style={{ color: 'var(--fg)' }}>4 todos in your inbox</b>, and {pinned.length} active projects pinned. Last edit was{' '}
            {fmtRel(new Date(Date.now() - s.freshness.last_edit_ms).toISOString())}.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => onRoute({ route: 'projects', action: 'new' })}>
          <Icons.Plus /> New project
        </button>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="lb">Projects</div>
          <div className="vl">{s.counts.projects}</div>
          <div className="ds">
            <span className="delta">+1</span> this week
          </div>
          <span className="spark" style={{ color: 'var(--accent-1)' }}>
            <Spark data={[2, 3, 3, 4, 4, 5, 5]} />
          </span>
        </div>
        <div className="stat-card">
          <div className="lb">Documents</div>
          <div className="vl tabular">{s.counts.documents}</div>
          <div className="ds">
            <span className="delta">+6</span> this week · 1 pending
          </div>
          <span className="spark" style={{ color: 'oklch(0.74 0.08 220)' }}>
            <Spark data={[35, 38, 41, 42, 44, 47, 50]} />
          </span>
        </div>
        <div className="stat-card">
          <div className="lb">Notes</div>
          <div className="vl tabular">{s.counts.notes}</div>
          <div className="ds">
            <span className="delta">+3</span> this week
          </div>
          <span className="spark" style={{ color: 'oklch(0.74 0.10 80)' }}>
            <Spark data={[40, 41, 43, 43, 44, 45, 46]} />
          </span>
        </div>
        <div className="stat-card">
          <div className="lb">Todos</div>
          <div className="vl tabular">
            {s.counts.done}/{s.counts.todos}
          </div>
          <div className="ds">{Math.round((s.counts.done / s.counts.todos) * 100)}% complete</div>
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
        <div className="proj-grid">
          {pinned.map(p => (
            <ProjectCard key={p.id} p={p} size="lg" onOpen={() => onRoute({ route: 'project', project: p.id })} />
          ))}
        </div>
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
            {inbox.map(t => (
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
            ))}
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
            {activity.map(a => (
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
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
