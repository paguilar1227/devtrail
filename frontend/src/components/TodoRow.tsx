// Single source of truth for a compact todo row, used by the Home
// personal-todos column and the personal todos drawer. Anything that
// should look or behave the same across both surfaces lives here.
//
// Visual states the row carries:
//   - depth=1 → indented under its parent (subtask)
//   - status=done → title struck through, row dimmed
//   - comment_count > 0 → tiny chat-bubble badge with the count
//   - due in the past + status != done → red due meta line

import { Icons } from './Icons';
import { Checkbox, Priority } from './primitives';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { Todo } from '../types';

interface Props {
  todo: Todo;
  depth?: 0 | 1;
  onClick?: () => void;
  onToggleDone?: () => void;
}

export function TodoRow({ todo, depth = 0, onClick, onToggleDone }: Props) {
  const t = todo;
  const done = t.status === 'done';
  return (
    <div
      className={cls('prow', 'prow-todo', done && 'prow-done')}
      data-depth={depth}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      } : undefined}
    >
      <Checkbox
        checked={done}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onToggleDone?.();
        }}
      />
      <div>
        <div className="ti">{t.title}</div>
        {t.due_at ? (
          <div className={cls('ti-sub', !done && isOverdue(t.due_at) && 'due-overdue')}>
            due {fmtRel(t.due_at)}
          </div>
        ) : null}
      </div>
      {t.comments > 0 ? (
        <span className="prow-comments" title={`${t.comments} comment${t.comments === 1 ? '' : 's'}`}>
          <Icons.Chat size={11} />
          <span>{t.comments}</span>
        </span>
      ) : null}
      <Priority p={t.priority} />
      <span className="ats">{fmtRel(t.created_at)}</span>
    </div>
  );
}
