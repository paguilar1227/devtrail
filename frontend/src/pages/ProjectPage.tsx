import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQueryClient, useQuery } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { Tabs, Tag } from '../components/primitives';
import {
  getProject,
  listContent,
  listProjectCounts,
  listProjects,
  listTags,
  pinProject,
  unpinProject,
} from '../lib/api';
import { toUiProject } from '../lib/view';
import { cls, fmtRel } from '../lib/util';
import type { ActionDispatch } from '../types';
import { ChatTab } from './project/ChatTab';
import { DocumentsTab } from './project/DocumentsTab';
import { NotesTab } from './project/NotesTab';
import { TodosTab } from './project/TodosTab';
import { SearchInput, type MentionTarget, type ProjectSuggestion, type TagSuggestion } from '../components/SearchInput';

interface Props {
  projectId: string;
  onAction: ActionDispatch;
}

type TabId = 'chat' | 'documents' | 'notes' | 'todos';

export function ProjectPage({ projectId, onAction }: Props) {
  const [tab, setTab] = useState<TabId>('chat');
  const [searchDraft, setSearchDraft] = useState('');
  const qc = useQueryClient();
  const [projectQ, countsQ] = useQueries({
    queries: [
      { queryKey: ['project', projectId], queryFn: () => getProject(projectId) },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
    ],
  });

  // Universal search data sources. Fetched globally (not project-scoped)
  // so the @-typeahead can surface docs/notes from any project — useful
  // when the user wants to mention an item that lives elsewhere to add
  // it to the active search. The submitted search is THIS project's
  // scope by default; the user can override via the drawer's scope chips
  // or via a `project:<name>` DSL predicate.
  const { data: allProjects } = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const { data: tagsApi } = useQuery({ queryKey: ['tags', 'all'], queryFn: () => listTags() });
  const { data: docsApi } = useQuery({
    queryKey: ['content', 'documents', 'all'],
    queryFn: () => listContent({ type: 'document' }),
  });
  const { data: notesApi } = useQuery({
    queryKey: ['content', 'notes', 'all'],
    queryFn: () => listContent({ type: 'note' }),
  });
  const projectSuggestions = useMemo<ProjectSuggestion[]>(
    () => (allProjects ?? [])
      .filter((p) => p.status === 'active')
      .map((p) => ({ id: p.id, name: p.name })),
    [allProjects],
  );
  const tagSuggestions = useMemo<TagSuggestion[]>(
    () => (tagsApi ?? [])
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((t) => ({ name: t.name, total: t.total })),
    [tagsApi],
  );
  const mentionTargets = useMemo<MentionTarget[]>(() => {
    const docs: MentionTarget[] = (docsApi ?? []).map((d) => ({ id: d.id, title: d.title, kind: 'document' }));
    const notes: MentionTarget[] = (notesApi ?? []).map((n) => ({ id: n.id, title: n.title, kind: 'note' }));
    return [...docs, ...notes].sort((a, b) => a.title.localeCompare(b.title));
  }, [docsApi, notesApi]);

  const submitProjectSearch = () => {
    if (!searchDraft.trim()) return;
    onAction({ kind: 'search', payload: { query: searchDraft.trim(), scope: projectId } });
  };

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

      <div className="proj-search-row">
        <div className="home-search-box">
          <Icons.Search />
          <SearchInput
            value={searchDraft}
            onChange={setSearchDraft}
            onSubmit={submitProjectSearch}
            tags={tagSuggestions}
            mentions={mentionTargets}
            projects={projectSuggestions}
            placeholder={`Search inside ${project.name}… try #tag, in:todo, @docname, -#exclude`}
          />
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
