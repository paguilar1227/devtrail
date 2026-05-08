// Resolve an activity event into the right modal: doc reader for
// documents, editor for notes, detail drawer for todos. The activity
// list only carries entity_id + entity_kind — modals need the full
// entity, so we fetch it on click.

import { getContent, getTodo } from './api';
import { toUiDocument, toUiNote, toUiTodo } from './view';
import type { ActionDispatch, ActivityEvent } from '../types';

export async function openActivityTarget(a: ActivityEvent, onAction: ActionDispatch): Promise<void> {
  try {
    if (a.entity_kind === 'todo') {
      const t = await getTodo(a.entity_id);
      onAction({ kind: 'todo-detail', payload: toUiTodo(t) });
      return;
    }
    const c = await getContent(a.entity_id);
    if (a.entity_kind === 'document') {
      onAction({ kind: 'doc-read', payload: toUiDocument(c) });
    } else {
      onAction({ kind: 'note-edit', payload: toUiNote(c), projectId: c.project_ids[0] });
    }
  } catch (err) {
    // Soft-deleted or genuinely missing — log and let the row click
    // be a no-op rather than crashing the page. UX could grow into a
    // toast later, but silence is fine for now.
    console.error('Failed to open activity target', a, err);
  }
}
