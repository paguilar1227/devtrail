// Archived (Trash) view — soft-deleted projects/documents/notes/todos.
// Restore brings an item back; Delete forever hard-deletes it (gated on
// typing the title, as the header copy promises); Empty archive purges
// everything currently listed after an explicit confirm.

import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import {
  deleteContentForever,
  deleteProject,
  deleteTodoForever,
  listContent,
  listProjects,
  listTodos,
  restoreContent,
  restoreProject,
  restoreTodo,
} from '../lib/api';
import { fmtRel } from '../lib/util';

type Kind = 'project' | 'document' | 'note' | 'todo';
type Filter = 'all' | Kind;

interface TrashItem {
  id: string;
  kind: Kind;
  title: string;
  at: string;
  sub: string;
}

const restoreByKind: Record<Kind, (id: string) => Promise<void>> = {
  project: restoreProject,
  document: restoreContent,
  note: restoreContent,
  todo: restoreTodo,
};

const deleteByKind: Record<Kind, (id: string) => Promise<void>> = {
  project: deleteProject,
  document: deleteContentForever,
  note: deleteContentForever,
  todo: deleteTodoForever,
};

export function TrashPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const qc = useQueryClient();
  const [projectsQ, contentQ, todosQ] = useQueries({
    queries: [
      { queryKey: ['projects', 'all-incl-archived'], queryFn: () => listProjects() },
      { queryKey: ['content', 'archived'], queryFn: () => listContent({ include_archived: true }) },
      { queryKey: ['todos', 'archived'], queryFn: () => listTodos({ include_archived: true }) },
    ],
  });

  const projectsById = useMemo(
    () => new Map((projectsQ.data ?? []).map((p) => [p.id, p])),
    [projectsQ.data],
  );

  const items: TrashItem[] = useMemo(() => {
    const result: TrashItem[] = [];
    (projectsQ.data ?? [])
      .filter((p) => p.status === 'archived')
      .forEach((p) =>
        result.push({
          id: p.id,
          kind: 'project',
          title: p.name,
          at: p.updated_at,
          sub: p.description ?? '',
        }),
      );
    (contentQ.data ?? [])
      .filter((c) => c.archived)
      .forEach((c) => {
        const projectName =
          c.project_ids[0] ? projectsById.get(c.project_ids[0])?.name ?? '—' : 'Inbox';
        result.push({
          id: c.id,
          kind: c.type,
          title: c.title,
          at: c.updated_at,
          sub: projectName,
        });
      });
    (todosQ.data ?? [])
      .filter((t) => t.archived)
      .forEach((t) => {
        const projectName = t.project_id
          ? projectsById.get(t.project_id)?.name ?? '—'
          : 'Inbox';
        result.push({
          id: t.id,
          kind: 'todo',
          title: t.content,
          at: t.updated_at,
          sub: projectName,
        });
      });
    return result.sort((a, b) => b.at.localeCompare(a.at));
  }, [projectsQ.data, contentQ.data, todosQ.data, projectsById]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: ['content'] });
    qc.invalidateQueries({ queryKey: ['todos'] });
    qc.invalidateQueries({ queryKey: ['project-counts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };

  const restoreMut = useMutation({
    mutationFn: (it: TrashItem) => restoreByKind[it.kind](it.id),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (it: TrashItem) => deleteByKind[it.kind](it.id),
    onSuccess: invalidate,
  });
  // Purge everything currently listed, sequentially — a few dozen rows at
  // most, and sequential keeps the backend load boring.
  const emptyMut = useMutation({
    mutationFn: async (all: TrashItem[]) => {
      for (const it of all) await deleteByKind[it.kind](it.id);
    },
    onSuccess: invalidate,
  });

  // Which dialog is open: a per-item delete confirm, or the bulk empty.
  const [confirmDelete, setConfirmDelete] = useState<TrashItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const counts = {
    project: items.filter((i) => i.kind === 'project').length,
    document: items.filter((i) => i.kind === 'document').length,
    note: items.filter((i) => i.kind === 'note').length,
    todo: items.filter((i) => i.kind === 'todo').length,
  };
  const filtered = filter === 'all' ? items : items.filter((i) => i.kind === filter);

  const isLoading = projectsQ.isLoading || contentQ.isLoading || todosQ.isLoading;
  const error = projectsQ.error || contentQ.error || todosQ.error;
  const busy = restoreMut.isPending || deleteMut.isPending || emptyMut.isPending;

  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load archive: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <div className="proj-hero">
        <div>
          <h1>Archived</h1>
          <p className="page-subtle">
            Soft-deleted items. Restore brings them back; permanent delete requires typing the title to confirm. Items here are excluded
            from chat retrieval but remain searchable here.
          </p>
        </div>
        <button
          className="btn btn-danger"
          disabled={items.length === 0 || busy}
          onClick={() => setConfirmEmpty(true)}
        >
          Empty archive
        </button>
      </div>
      <div className="filter-bar">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All <span style={{ marginLeft: 4 }}>{items.length}</span>
        </FilterChip>
        <FilterChip active={filter === 'project'} onClick={() => setFilter('project')}>
          Projects <span style={{ marginLeft: 4 }}>{counts.project}</span>
        </FilterChip>
        <FilterChip active={filter === 'document'} onClick={() => setFilter('document')}>
          Documents <span style={{ marginLeft: 4 }}>{counts.document}</span>
        </FilterChip>
        <FilterChip active={filter === 'note'} onClick={() => setFilter('note')}>
          Notes <span style={{ marginLeft: 4 }}>{counts.note}</span>
        </FilterChip>
        <FilterChip active={filter === 'todo'} onClick={() => setFilter('todo')}>
          Todos <span style={{ marginLeft: 4 }}>{counts.todo}</span>
        </FilterChip>
      </div>
      {isLoading ? (
        <div className="page-subtle">Loading archive…</div>
      ) : filtered.length === 0 ? (
        <div className="page-subtle">Archive is empty.</div>
      ) : (
        <div className="row-list">
          {filtered.map((it) => (
            <div key={it.id} className="row" style={{ gridTemplateColumns: '32px 1fr auto auto auto' }}>
              <div className="ic-box" style={{ width: 28, height: 28 }}>
                {it.kind === 'project' ? (
                  <Icons.Folders size={13} />
                ) : it.kind === 'document' ? (
                  <Icons.Doc size={13} />
                ) : it.kind === 'note' ? (
                  <Icons.Note size={13} />
                ) : (
                  <Icons.Check size={13} />
                )}
              </div>
              <div>
                <div className="strong">{it.title}</div>
                <div className="subtle row-meta">
                  {it.kind} · {it.sub} · archived {fmtRel(it.at)}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => restoreMut.mutate(it)}
              >
                Restore
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => setConfirmDelete(it)}
              >
                Delete forever
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmDelete ? (
        <ConfirmModal
          title={`Delete "${confirmDelete.title}" forever?`}
          message={`This permanently deletes the ${confirmDelete.kind} — it can't be restored afterwards. Type the title to confirm.`}
          confirmLabel="Delete forever"
          requireType={confirmDelete.title}
          danger
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const it = confirmDelete;
            setConfirmDelete(null);
            deleteMut.mutate(it);
          }}
        />
      ) : null}

      {confirmEmpty ? (
        <ConfirmModal
          title={`Empty the archive?`}
          message={`This permanently deletes all ${items.length} archived item${items.length === 1 ? '' : 's'} — projects, documents, notes, and todos. None of them can be restored afterwards.`}
          confirmLabel="Delete all forever"
          danger
          onClose={() => setConfirmEmpty(false)}
          onConfirm={() => {
            setConfirmEmpty(false);
            emptyMut.mutate(items);
          }}
        />
      ) : null}
    </div>
  );
}
