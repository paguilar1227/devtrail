import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icons } from '../../components/Icons';
import { FilterChip, Status, Tag } from '../../components/primitives';
import { listContent } from '../../lib/api';
import { toUiNote } from '../../lib/view';
import { fmtRel } from '../../lib/util';
import type { ActionDispatch, Project } from '../../types';

interface Props {
  project: Project;
  onAction: ActionDispatch;
}

export function NotesTab({ project, onAction }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['content', 'note', project.id],
    queryFn: () => listContent({ type: 'note', project_id: project.id }),
  });

  const notes = useMemo(() => (data ?? []).map(toUiNote), [data]);
  const pinnedCount = notes.filter(n => n.pinned).length;
  const pendingCount = notes.filter(n => n.processing_status === 'pending').length;

  if (error) {
    return <div className="page-subtle" style={{ color: 'var(--danger)' }}>Failed to load notes: {String((error as Error).message)}</div>;
  }
  if (isLoading) {
    return <div className="page-subtle">Loading notes…</div>;
  }

  return (
    <div>
      <div className="filter-bar">
        <FilterChip active>
          All <span style={{ marginLeft: 4 }}>{notes.length}</span>
        </FilterChip>
        <FilterChip>
          Pinned <span style={{ marginLeft: 4 }}>{pinnedCount}</span>
        </FilterChip>
        <FilterChip>
          Processing <span style={{ marginLeft: 4 }}>{pendingCount}</span>
        </FilterChip>
        <span style={{ marginLeft: 'auto' }} className="row-flex gap-1">
          <button className="btn btn-sm" onClick={() => onAction({ kind: 'note-edit', payload: null, projectId: project.id })}>
            <Icons.Plus /> New note
          </button>
        </span>
      </div>

      {notes.length === 0 ? (
        <div className="page-subtle">No notes in this project yet.</div>
      ) : (
        <div className="note-grid">
          {notes.map(n => (
            <div key={n.id} className="note-card" onClick={() => onAction({ kind: 'note-edit', payload: n })}>
              <div className="row-flex gap-2">
                <span className="nm">{n.title}</span>
                {n.pinned ? (
                  <Icons.Pin size={12} style={{ color: 'var(--fg-subtle)', marginLeft: 'auto' }} />
                ) : null}
              </div>
              <div className="body">{n.body.replace(/^#+\s.*\n?/gm, '').replace(/\*/g, '').trim()}</div>
              <div className="ft">
                <div className="tags">
                  {n.tags.slice(0, 3).map(t => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
                <div className="row-flex gap-2">
                  <Status status={n.processing_status} />
                  <span>{fmtRel(n.updated_at)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
