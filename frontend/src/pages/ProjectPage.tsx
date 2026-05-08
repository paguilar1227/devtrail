import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { Tabs, Tag } from '../components/primitives';
import { getProject, listProjectCounts, pinProject, unpinProject } from '../lib/api';
import { toUiProject } from '../lib/view';
import { cls, fmtRel } from '../lib/util';
import type { ActionDispatch } from '../types';
import { ChatTab } from './project/ChatTab';
import { DocumentsTab } from './project/DocumentsTab';
import { NotesTab } from './project/NotesTab';
import { TodosTab } from './project/TodosTab';

interface Props {
  projectId: string;
  onAction: ActionDispatch;
}

type TabId = 'chat' | 'documents' | 'notes' | 'todos';

export function ProjectPage({ projectId, onAction }: Props) {
  const [tab, setTab] = useState<TabId>('chat');
  const qc = useQueryClient();
  const [projectQ, countsQ] = useQueries({
    queries: [
      { queryKey: ['project', projectId], queryFn: () => getProject(projectId) },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
    ],
  });

  const myCounts = countsQ.data?.find((c) => c.project_id === projectId);
  const project = useMemo(
    () => (projectQ.data ? toUiProject(projectQ.data, myCounts) : null),
    [projectQ.data, myCounts],
  );

  const togglePin = useMutation({
    mutationFn: () =>
      project?.pinned ? unpinProject(projectId) : pinProject(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  if (projectQ.error || countsQ.error) {
    const err = projectQ.error || countsQ.error;
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load project: {err instanceof Error ? err.message : String(err)}
        </div>
      </div>
    );
  }

  if (projectQ.isLoading || !project) {
    return (
      <div className="page">
        <div className="page-subtle">Loading project…</div>
      </div>
    );
  }

  const tabs = [
    { id: 'chat', label: 'Chat', icon: <Icons.Chat />, count: 0 },
    { id: 'documents', label: 'Documents', icon: <Icons.Doc />, count: project.counts.docs },
    { id: 'notes', label: 'Notes', icon: <Icons.Note />, count: project.counts.notes },
    { id: 'todos', label: 'Todos', icon: <Icons.Check />, count: project.counts.todos },
  ];

  const isArchived = project.status === 'archived';

  return (
    <div className="page" style={{ paddingBottom: tab === 'chat' ? 0 : 56 }}>
      <div className="proj-hero">
        <div>
          <div className="row-flex gap-2 proj-eyebrow-row">
            <span className={cls('sb-proj-dot', project.accent, 'proj-dot-lg')}></span>
            <span className="subtle eyebrow">
              {isArchived ? 'Archived project' : 'Active project'} · created {fmtRel(project.created_at)}
            </span>
            {project.pinned ? (
              <Tag>
                <Icons.Pin size={10} />
                pinned
              </Tag>
            ) : null}
          </div>
          <h1>{project.name}</h1>
          <p className="desc">{project.desc}</p>
        </div>
        <div className="row-flex gap-2">
          <button
            className="btn"
            onClick={() => togglePin.mutate()}
            disabled={togglePin.isPending}
          >
            <Icons.Pin /> {togglePin.isPending ? '…' : project.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button className="btn" title="More project actions">
            <Icons.More />
          </button>
          <button className="btn btn-primary" onClick={() => onAction({ kind: 'upload', payload: project })}>
            <Icons.Upload /> Add
          </button>
        </div>
      </div>

      <div className="tabs-row">
        <Tabs value={tab} onChange={id => setTab(id as TabId)} items={tabs} />
        <div className="proj-stats-strip">
          <span>
            <span className="v">{project.counts.docs}</span> docs
          </span>
          <span>
            <span className="v">{project.counts.notes}</span> notes
          </span>
          <span>
            <span className="v">
              {project.counts.done}/{project.counts.todos}
            </span>{' '}
            done
          </span>
          <span>
            last edit <span className="v">{fmtRel(project.updated_at)}</span>
          </span>
        </div>
      </div>

      {tab === 'chat' && <ChatTab project={project} />}
      {tab === 'documents' && <DocumentsTab project={project} onAction={onAction} />}
      {tab === 'notes' && <NotesTab project={project} onAction={onAction} />}
      {tab === 'todos' && <TodosTab project={project} onAction={onAction} />}
    </div>
  );
}
