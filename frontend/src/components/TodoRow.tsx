// Single source of truth for a compact todo row, used by the Home
// personal-todos column and the personal todos drawer. Anything that
// should look or behave the same across both surfaces lives here.
//
// Markup intentionally mirrors what HomePage had inline so existing
// CSS (.prow / .prow-todo / .ti / .ti-sub / .ats) keeps working — no
// stylesheet churn beyond what the refactor strictly requires.

import { Checkbox, Priority } from './primitives';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { Todo } from '../types';

interface Props {
  todo: Todo;
  onClick?: () => void;
  onToggleDone?: () => void;
}

export function TodoRow({ todo, onClick, onToggleDone }: Props) {
  const t = todo;
  return (
    <div
      className="prow prow-todo"
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
        checked={t.status === 'done'}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onToggleDone?.();
        }}
      />
      <div>
        <div className="ti">{t.title}</div>
        {t.due_at ? (
          <div className={cls('ti-sub', isOverdue(t.due_at) && 'due-overdue')}>
            due {fmtRel(t.due_at)}
          </div>
        ) : null}
      </div>
      <Priority p={t.priority} />
      <span className="ats">{fmtRel(t.created_at)}</span>
    </div>
  );
}
