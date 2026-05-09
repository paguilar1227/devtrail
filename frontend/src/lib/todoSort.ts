// Hierarchical sort for personal todos. Used by both the Home column
// (top 6, depth-capped, default-collapsed) and the personal todos
// drawer (full tree, default-collapsed).
//
// Top-level sort bands, in order:
//   0. Overdue       — anything active with a due_at in the past;
//                      bubbled to the absolute top so action items lead
//   1. Pinned        — sticky context the user marked as important
//   2. Active        — anything else not done
//   3. Done          — pushed to the bottom; recently completed first
//
// Within each band, secondary sort is:
//   1. manual_order asc — when the user has dragged this group into a
//      custom order, that order takes precedence over the natural keys
//      below. NULLS LAST so unranked rows fall to natural sort.
//   2. due asc (sooner first), null-due last
//   3. priority asc (P1 most urgent)
//   4. created desc (newest first inside the same priority/due bucket)
//
// Subtasks always emit immediately after their parent, regardless of
// their own band. Children are emitted recursively, so grandchildren
// (depth=2) sit under their parent (depth=1) sit under their grandparent
// (depth=0) — the visual hierarchy beats sort score for descendants.
//
// Two knobs control what's actually emitted:
//   - `maxDepth`  — descendants beyond this depth are omitted and
//                   counted into `hiddenDescendants` so the deepest
//                   visible row can render a "+N deeper" hint.
//   - `isExpanded(id)` — when provided AND returns false for a parent,
//                   that parent's subtree is omitted (counted into
//                   `hiddenDescendants` so the chevron can show "(N)").
//                   Default is "always expanded" — caller opts into
//                   collapse semantics.
//
// Orphan children (parent not in the list) get appended at the end at
// depth=0 rather than dropped — happens if a partial filter is applied.

import type { Todo } from '../types';

export interface SortedTodo {
  todo: Todo;
  depth: number;
  childCount: number;
  hiddenDescendants: number;
}

const PRIORITY_RANK: Record<Todo['priority'], number> = { p1: 0, p2: 1, p3: 2 };

function isOverdueAt(d: string | null): boolean {
  if (!d) return false;
  return new Date(d).getTime() < Date.now();
}

function bandRank(t: Todo): number {
  if (t.status !== 'done' && isOverdueAt(t.due_at)) return 0;
  if (t.pinned && t.status !== 'done') return 1;
  if (t.status === 'done') return 3;
  return 2;
}

function withinBandRank(t: Todo): [number, number, number, number] {
  // manual_order ASC NULLS LAST: rows the user has positioned win
  // over the natural keys; unranked rows (null) fall to the back of
  // this tier and are decided by due / priority / created.
  const m = t.manual_order ?? Number.MAX_SAFE_INTEGER;
  const dueMs = t.due_at ? new Date(t.due_at).getTime() : Number.MAX_SAFE_INTEGER;
  const p = PRIORITY_RANK[t.priority] ?? 9;
  const createdMs = -new Date(t.created_at).getTime();
  return [m, dueMs, p, createdMs];
}

function compare(a: Todo, b: Todo): number {
  const ba = bandRank(a);
  const bb = bandRank(b);
  if (ba !== bb) return ba - bb;
  const wa = withinBandRank(a);
  const wb = withinBandRank(b);
  return wa[0] - wb[0] || wa[1] - wb[1] || wa[2] - wb[2] || wa[3] - wb[3];
}

export interface SortOptions {
  maxDepth?: number;
  isExpanded?: (id: string) => boolean;
}

export function sortPersonalTodos(
  todos: Todo[],
  opts: SortOptions = {},
): SortedTodo[] {
  const { maxDepth = Infinity, isExpanded } = opts;
  const byParent = new Map<string, Todo[]>();
  const tops: Todo[] = [];
  for (const t of todos) {
    if (t.parent_id) {
      const cs = byParent.get(t.parent_id);
      if (cs) cs.push(t);
      else byParent.set(t.parent_id, [t]);
    } else {
      tops.push(t);
    }
  }
  tops.sort(compare);
  for (const cs of byParent.values()) cs.sort(compare);

  const out: SortedTodo[] = [];
  const seenChildren = new Set<string>();

  const countDescendants = (id: string): number => {
    let n = 0;
    const cs = byParent.get(id);
    if (!cs) return 0;
    for (const c of cs) n += 1 + countDescendants(c.id);
    return n;
  };

  const markSubtreeSeen = (id: string) => {
    const k = byParent.get(id);
    if (!k) return;
    for (const x of k) {
      seenChildren.add(x.id);
      markSubtreeSeen(x.id);
    }
  };

  const emit = (t: Todo, depth: number) => {
    if (depth > maxDepth) return;
    const cs = byParent.get(t.id);
    const childCount = cs?.length ?? 0;
    const collapsed = !!isExpanded && childCount > 0 && !isExpanded(t.id);
    const atCap = depth === maxDepth && childCount > 0;
    let hidden = 0;
    if (collapsed || atCap) hidden = countDescendants(t.id);
    // At maxDepth, suppress childCount so the row renders the deeper
    // hint instead of an inert chevron — expansion here can't reveal
    // anything on this surface, so showing a chevron would mislead.
    const reportedChildCount = atCap ? 0 : childCount;
    out.push({ todo: t, depth, childCount: reportedChildCount, hiddenDescendants: hidden });

    if (collapsed || atCap) {
      markSubtreeSeen(t.id);
      return;
    }
    if (cs) {
      for (const c of cs) {
        seenChildren.add(c.id);
        emit(c, depth + 1);
      }
    }
  };

  for (const t of tops) emit(t, 0);

  for (const cs of byParent.values()) {
    for (const c of cs) {
      if (!seenChildren.has(c.id)) {
        out.push({ todo: c, depth: 0, childCount: 0, hiddenDescendants: 0 });
      }
    }
  }
  return out;
}
