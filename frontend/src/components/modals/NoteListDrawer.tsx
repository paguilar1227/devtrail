// All personal (project-less) notes in a drawer. Mirrors TodoListDrawer
// for symmetry — same drawer chrome, same row primitive pattern.

import { useQuery } from '@tanstack/react-query';
import { Drawer } from '../primitives';
import { NoteRow } from '../NoteRow';
import { listContent } from '../../lib/api';
import { toUiNote } from '../../lib/view';
import type { ActionDispatch } from '../../types';

interface Props {
  onClose: () => void;
  onAction: ActionDispatch;
}

export function NoteListDrawer({ onClose, onAction }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['content', 'notes', 'personal'],
    queryFn: () => listContent({ type: 'note', project_id: 'null' }),
  });
  const notes = data ?? [];

  return (
    <Drawer title={`Personal notes · ${notes.length}`} onClose={onClose}>
      {error ? (
        <div className="page-subtle search-drawer-error">
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : isLoading ? (
        <div className="page-subtle">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="page-subtle">No personal notes yet.</div>
      ) : (
        <div className="todo-list-drawer-rows">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={toUiNote(n)}
              onClick={() => {
                onClose();
                onAction({ kind: 'note-edit', payload: toUiNote(n) });
              }}
            />
          ))}
        </div>
      )}
    </Drawer>
  );
}
