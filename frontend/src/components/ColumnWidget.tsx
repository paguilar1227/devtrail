import type { ReactNode } from 'react';
import { Icons } from './Icons';
import { PersonalColumnHeader } from './PersonalColumnHeader';
import { useFitCount } from '../lib/useFitCount';

// Single source of truth for the Home dashboard's column widgets.
//
// Each Personal / All-projects column (Todos / Notes / Documents) is
// the same shell — outer card, header, optional quick-add input, a
// scrollable rows region whose height is measured to compute how many
// rows fit, and a "View N more" footer when the dataset is larger
// than the fit count. Differences live only in slot content (title,
// row-renderer, empty state, sort dropdown). Before this lived
// inline in HomePage 3× — see PR notes on the dashboard widget
// refactor for context.
//
// Slot contract:
//   sort      — dropdown rendered on the right of the header
//   quickAdd  — optional input row above the rows region (todos/notes)
//   empty     — what to render when isEmpty is true
//   renderRows — function taking the responsive fit count, returns the
//                row markup. Caller slice(0, fit) to respect the cap.
interface Props {
  /** data-pcol value — also identifies the column in DOM queries / e2e. */
  id: string;
  title: string;
  /** Count chip in the header — usually the total filtered length. */
  count: number;
  sort: ReactNode;
  quickAdd?: ReactNode;
  /** Pessimistic average row height in px — used to compute how many
   *  rows fit in the rows region. Lower = more rows visible; too low
   *  = clipping. ~72 for todos, ~56 for notes/docs. */
  rowPx: number;
  isEmpty: boolean;
  empty: ReactNode;
  /** Receives the fit count so the caller can slice its data source
   *  to render exactly that many rows. */
  renderRows: (fitCount: number) => ReactNode;
  /** Total dataset length — drives the "View N more" math + footer
   *  visibility (footer appears when totalRows > fitCount). */
  totalRows: number;
  onMore: () => void;
}

export function ColumnWidget({
  id,
  title,
  count,
  sort,
  quickAdd,
  rowPx,
  isEmpty,
  empty,
  renderRows,
  totalRows,
  onMore,
}: Props) {
  const [fitCount, rowsRef] = useFitCount(rowPx);
  return (
    <div className="pcol" data-pcol={id}>
      <PersonalColumnHeader title={title} count={count} sort={sort} />
      {quickAdd ? <div className="pcol-add">{quickAdd}</div> : null}
      <div className="pcol-rows" ref={rowsRef}>
        {isEmpty ? empty : renderRows(fitCount)}
      </div>
      {totalRows > 0 ? (
        // Always offer the drawer entry when the column has content — the
        // drawer is the only way to reach search + the full paginated list.
        // Gating it on `totalRows > fitCount` made the footer a load-phase
        // transient: in this layout the grid grows to content height, so
        // fitCount climbs to cover every row and the footer unmounts once
        // settled. That left it clickable only during the load flicker —
        // a race that taller rows (e.g. note folder chips) reliably lose,
        // and the reason the footer-driven drawer e2es were flaky. A
        // permanent footer can't detach mid-click, so the entry is stable.
        <button className="pcol-more" onClick={onMore}>
          {totalRows > fitCount ? `View ${totalRows - fitCount} more` : 'View all'}
          <Icons.ChevronRight size={11} />
        </button>
      ) : null}
    </div>
  );
}
