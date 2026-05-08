// Hierarchical sort for personal todos. Used by both the Home column
// (top 6) and the personal todos drawer.
//
// Top-level sort bands, in order:
//   1. Pinned       — surface intent first
//   2. Active       — anything not done; within band sort by priority
//                     asc (P1 most urgent), then due asc (overdue
//                     first), then created desc (newest at top of band)
//   3. Done         — pushed to the bottom of the column; recently
//                     completed sit at the top of the band
//
// Subtasks always emit immediately after their parent, regardless of
// their own band. The visual hierarchy beats the sort score for
// children — splitting a parent from its kids would be more confusing
// than a done child appearing above an active sibling.
//
// Orphan children (parent not in the list) get appended at the end
// rather than dropped — happens if a partial filter is applied.

import type { Todo } from '../types';

const PRIORITY_RANK: Record<Todo['priority'], number> = { p1: 0, p2: 1, p3: 2 };

function isOverdueAt(d: string | null): boolean {
  if (!d) return false;
  return new Date(d).getTime() < Date.now();
}

function bandRank(t: Todo): number {
  if (t.pinned) return 0;
  if (t.status === 'done') return 2;
  return 1;
}

function withinBandRank(t: Todo): [number, number, number] {
  // Priority asc (lower number = higher priority).
  const p = PRIORITY_RANK[t.priority] ?? 9;
  // Due asc; null due dates sort last within priority.
  const dueMs = t.due_at ? new Date(t.due_at).getTime() : Number.MAX_SAFE_INTEGER;
  // Created desc — newest first inside the same priority/due bucket.
  const createdMs = -new Date(t.created_at).getTime();
  return [p, dueMs, createdMs];
}

function compare(a: Todo, b: Todo): number {
  const ba = bandRank(a);
  const bb = bandRank(b);
  if (ba !== bb) return ba - bb;
  // Inside the active band, overdue gets pulled forward independently
  // of priority — an overdue P3 outranks a future P1.
  if (ba === 1) {
    const oa = isOverdueAt(a.due_at) ? 0 : 1;
    const ob = isOverdueAt(b.due_at) ? 0 : 1;
    if (oa !== ob) return oa - ob;
  }
  const wa = withinBandRank(a);
  const wb = withinBandRank(b);
  return wa[0] - wb[0] || wa[1] - wb[1] || wa[2] - wb[2];
}

export function sortPersonalTodos(todos: Todo[]): Todo[] {
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

  const out: Todo[] = [];
  const seenChildren = new Set<string>();
  for (const t of tops) {
    out.push(t);
    const cs = byParent.get(t.id);
    if (cs) {
      for (const c of cs) {
        out.push(c);
        seenChildren.add(c.id);
      }
    }
  }
  // Orphans: children whose parent isn't in this list.
  for (const cs of byParent.values()) {
    for (const c of cs) {
      if (!seenChildren.has(c.id)) out.push(c);
    }
  }
  return out;
}
