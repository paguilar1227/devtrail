import { useState } from 'react';
import { Icons } from '../components/Icons';
import { Tabs, Tag } from '../components/primitives';
import { PROJECTS } from '../lib/mock';
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
  const project = PROJECTS.find(p => p.id === projectId) || PROJECTS[0];
  const [tab, setTab] = useState<TabId>('chat');
  const tabs = [
    { id: 'chat', label: 'Chat', icon: <Icons.Chat />, count: 8 },
    { id: 'documents', label: 'Documents', icon: <Icons.Doc />, count: project.counts.docs },
    { id: 'notes', label: 'Notes', icon: <Icons.Note />, count: project.counts.notes },
    { id: 'todos', label: 'Todos', icon: <Icons.Check />, count: project.counts.todos },
  ];

  return (
    <div className="page" style={{ paddingBottom: tab === 'chat' ? 0 : 56 }}>
      <div className="proj-hero">
        <div>
          <div className="row-flex gap-2" style={{ marginBottom: 8 }}>
            <span className={cls('sb-proj-dot', project.accent)} style={{ width: 12, height: 12 }}></span>
            <span
              className="subtle mono"
              style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              Active project · created {fmtRel(project.created_at)}
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
          <button className="btn">
            <Icons.Pin /> {project.pinned ? 'Unpin' : 'Pin'}
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
