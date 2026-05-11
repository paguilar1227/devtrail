// Compact sort-mode picker for todo lists. Native <select> styled to
// match the rest of the chrome — no a11y wrapper needed, keyboard +
// screen reader support comes free. Used by Home column, Inbox drawer,
// and project todos panels (all three keep their own surface key in
// localStorage via useTodoSortMode).

import { TODO_SORT_LABELS, TODO_SORT_MODES, type TodoSortMode } from '../lib/todoSort';

interface Props {
  mode: TodoSortMode;
  onChange: (m: TodoSortMode) => void;
  /** Optional id used by the visually-hidden label that pairs with the
   *  select for screen readers; only matters when more than one
   *  dropdown might exist on the page. */
  id?: string;
}

export function SortDropdown({ mode, onChange, id }: Props) {
  return (
    <label className="todo-sort-dropdown" htmlFor={id}>
      <span className="todo-sort-dropdown-label">Sort</span>
      <select
        id={id}
        className="todo-sort-dropdown-select"
        value={mode}
        onChange={(e) => onChange(e.target.value as TodoSortMode)}
      >
        {TODO_SORT_MODES.map((m) => (
          <option key={m} value={m}>{TODO_SORT_LABELS[m]}</option>
        ))}
      </select>
    </label>
  );
}
