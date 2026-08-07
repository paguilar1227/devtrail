// DnD list for the shared TodosPanel. Top-level todos live in sections;
// dragging a row reorders it within its section OR moves it to another
// section (dropping on a row or on a section's body). Subtasks render
// nested under their parent and drag WITHIN their sibling group only —
// each parent's children get their own nested SortableContext (useSortable
// binds to the nearest context), and cross-parent / cross-section drops
// are rejected in the handler: section is a root-todo concept.
//
// Persistence rides on two existing fields, no migration:
//   - cross-section move → updateTodo({ section })
//   - top-level order    → POST /todos/reorder (parent_id null) renumbers
//                          manual_order across ALL open top-level todos in
//                          the new visual order.
//   - subtask order      → POST /todos/reorder (parent_id <id>) renumbers
//                          manual_order across that parent's children.

import { Fragment, useMemo } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icons } from './Icons';
import { TodoRow } from './TodoRow';
import { reorderTodos, updateTodo } from '../lib/api';
import type { TodoSection } from '../lib/todoSections';
import type { SortedTodo } from '../lib/todoSort';
import type { Todo } from '../types';

const UNGROUPED_KEY = '__ungrouped__';
const secDroppableId = (name: string | null) => `sec:${name ?? UNGROUPED_KEY}`;
const parseSecId = (id: string): string | null | undefined => {
  if (!id.startsWith('sec:')) return undefined;
  const raw = id.slice(4);
  return raw === UNGROUPED_KEY ? null : raw;
};

interface RowProps {
  s: SortedTodo;
  draggable: boolean;
  isExpanded: (id: string) => boolean;
  onToggleExpand: (id: string) => void;
  onClickRow: (todo: Todo) => void;
  onToggleDone: (todo: Todo) => void;
}

function SortableRow({ s, isExpanded, onToggleExpand, onClickRow, onToggleDone }: Omit<RowProps, 'draggable'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: s.todo.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <TodoRow
        todo={s.todo}
        depth={s.depth}
        childCount={s.childCount}
        expanded={isExpanded(s.todo.id)}
        hiddenDescendants={s.hiddenDescendants}
        dragHandleProps={{ ...attributes, ...listeners }}
        onClick={() => onClickRow(s.todo)}
        onToggleExpand={() => onToggleExpand(s.todo.id)}
        onToggleDone={() => onToggleDone(s.todo)}
      />
    </div>
  );
}

interface Props {
  sections: TodoSection[];
  isExpanded: (id: string) => boolean;
  onToggleExpand: (id: string) => void;
  onClickRow: (todo: Todo) => void;
  onToggleDone: (todo: Todo) => void;
  /** Rename a section header in place. */
  onRenameSection?: (from: string, to: string) => void;
  invalidateKeys?: string[][];
}

export function SectionedTodoList({
  sections,
  isExpanded,
  onToggleExpand,
  onClickRow,
  onToggleDone,
  invalidateKeys,
}: Props) {
  const qc = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // section name (null=ungrouped) → ordered top-level ids
  const order = useMemo(
    () => sections.map((s) => ({ name: s.name, ids: [...s.topIds] })),
    [sections],
  );
  const sectionOf = (id: string): string | null | undefined => {
    for (const g of order) if (g.ids.includes(id)) return g.name;
    return undefined;
  };

  // Row lookup + parent → visible children (render order). A dragged
  // subtask's siblings are always all visible — children only render when
  // their parent is expanded, so the sibling set built here is complete
  // and safe to renumber wholesale.
  const { rowById, childrenByParent } = useMemo(() => {
    const byId = new Map<string, SortedTodo>();
    const byParent = new Map<string, SortedTodo[]>();
    for (const sec of sections) {
      for (const r of sec.rows) {
        byId.set(r.todo.id, r);
        const pid = r.todo.parent_id;
        if (pid) {
          const arr = byParent.get(pid);
          if (arr) arr.push(r);
          else byParent.set(pid, [r]);
        }
      }
    }
    return { rowById: byId, childrenByParent: byParent };
  }, [sections]);

  const reorderMut = useMutation({
    mutationFn: (req: { parent_id: string | null; ids: string[] }) => reorderTodos(req),
    onSuccess: () => {
      for (const key of invalidateKeys ?? [['todos']]) qc.invalidateQueries({ queryKey: key });
    },
  });
  const moveMut = useMutation({
    mutationFn: ({ id, section }: { id: string; section: string | null }) => updateTodo(id, { section }),
    onSuccess: () => {
      for (const key of invalidateKeys ?? [['todos']]) qc.invalidateQueries({ queryKey: key });
    },
  });

  // Optimistic cache patch shared by both drag paths: stamp the new
  // manual_order (and optionally a new section) on every cached todos
  // query so the next render reflects the drag before the refetch.
  const patchCaches = (orderById: Map<string, number>, moved?: { id: string; section: string | null }) => {
    const patch = (t: Todo): Todo => {
      let n = t;
      if (orderById.has(t.id)) n = { ...n, manual_order: orderById.get(t.id)! };
      if (moved && t.id === moved.id) n = { ...n, section: moved.section };
      return n;
    };
    qc.setQueriesData<unknown>({ queryKey: ['todos'] }, (data: unknown) => {
      if (!data) return data;
      if (Array.isArray(data)) return (data as Todo[]).map(patch);
      if (typeof data === 'object' && 'pages' in (data as Record<string, unknown>)) {
        const inf = data as { pages: Todo[][]; pageParams: unknown[] };
        return { ...inf, pages: inf.pages.map((p) => p.map(patch)) };
      }
      return data;
    });
  };

  // Collision detection scoped to the active item's VALID targets. With
  // plain closestCenter a tall section body's center can beat the sibling
  // row right under the pointer, so a subtask drop resolved to the section
  // and was rejected. Subtasks compete only against their siblings;
  // top-level rows against other top-level rows + section bodies.
  const collisionForActive: CollisionDetection = (args) => {
    const activeRow = rowById.get(String(args.active.id));
    if (activeRow?.todo.parent_id) {
      const siblings = new Set(
        (childrenByParent.get(activeRow.todo.parent_id) ?? []).map((r) => r.todo.id),
      );
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => siblings.has(String(c.id))),
      });
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => {
        const id = String(c.id);
        if (id.startsWith('sec:')) return true;
        return !rowById.get(id)?.todo.parent_id;
      }),
    });
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);

    // ── Subtask drag: reorder within the sibling group only. Cross-parent
    // and cross-section drops are rejected — a subtask's home is its
    // parent; re-parenting lives in the detail drawer.
    const activeRow = rowById.get(activeId);
    if (activeRow?.todo.parent_id) {
      const parentId = activeRow.todo.parent_id;
      const overRow = rowById.get(String(over.id));
      if (!overRow || overRow.todo.parent_id !== parentId) return;
      const siblings = (childrenByParent.get(parentId) ?? []).map((r) => r.todo.id);
      const oldIndex = siblings.indexOf(activeId);
      const newIndex = siblings.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const newIds = arrayMove(siblings, oldIndex, newIndex);
      patchCaches(new Map(newIds.map((id, i) => [id, i + 1])));
      reorderMut.mutate({ parent_id: parentId, ids: newIds });
      return;
    }

    const fromSection = sectionOf(activeId);
    if (fromSection === undefined) return;

    // Resolve the target section + insertion index from the drop target.
    let toSection: string | null;
    let insertIndex: number;
    const overId = String(over.id);
    const overSec = parseSecId(overId);
    if (overSec !== undefined) {
      // Dropped on a section body (incl. empty) → append to its end.
      toSection = overSec;
      insertIndex = (order.find((g) => g.name === toSection)?.ids.length ?? 0);
    } else {
      const overSection = sectionOf(overId);
      if (overSection === undefined) return;
      toSection = overSection;
      insertIndex = (order.find((g) => g.name === toSection)?.ids.indexOf(overId) ?? 0);
    }
    if (activeId === overId) return;

    // Rebuild each section's id list with the active row removed, then inserted.
    const next = order.map((g) => ({ name: g.name, ids: g.ids.filter((id) => id !== activeId) }));
    const target = next.find((g) => g.name === toSection);
    if (!target) return;
    const clampedIndex = Math.min(insertIndex, target.ids.length);
    target.ids.splice(clampedIndex, 0, activeId);

    // No-op guard: same section, same position.
    const before = order.find((g) => g.name === fromSection)?.ids ?? [];
    const after = next.find((g) => g.name === fromSection)?.ids ?? [];
    if (fromSection === toSection && before.join() === target.ids.join() && before.join() === after.join()) {
      // fall through only if truly unchanged
    }

    const flatIds = next.flatMap((g) => g.ids);
    const sectionChanged = fromSection !== toSection;

    patchCaches(
      new Map(flatIds.map((id, i) => [id, i + 1])),
      sectionChanged ? { id: activeId, section: toSection } : undefined,
    );

    if (sectionChanged) moveMut.mutate({ id: activeId, section: toSection });
    reorderMut.mutate({ parent_id: null, ids: flatIds });
  };

  // Recursive render: every row is sortable; a row's visible children are
  // wrapped in their own nested SortableContext, so useSortable binds each
  // subtask to its sibling group and dnd-kit only offers in-place sorts
  // within that group at any depth.
  const renderRow = (s: SortedTodo): React.ReactNode => {
    const childRows = childrenByParent.get(s.todo.id) ?? [];
    return (
      <Fragment key={s.todo.id}>
        <SortableRow
          s={s}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
          onClickRow={onClickRow}
          onToggleDone={onToggleDone}
        />
        {childRows.length > 0 ? (
          <SortableContext
            items={childRows.map((c) => c.todo.id)}
            strategy={verticalListSortingStrategy}
          >
            {childRows.map(renderRow)}
          </SortableContext>
        ) : null}
      </Fragment>
    );
  };

  return (
    <DndContext sensors={sensors} collisionDetection={collisionForActive} onDragEnd={handleDragEnd}>
      {sections.map((sec) => (
        <SectionDroppable key={sec.name ?? UNGROUPED_KEY} name={sec.name} count={sec.topIds.length}>
          <SortableContext items={sec.topIds} strategy={verticalListSortingStrategy}>
            {sec.rows.length === 0 ? (
              <div className="todos-section-empty page-subtle">Drop a todo here</div>
            ) : (
              sec.rows.filter((r) => r.depth === 0).map(renderRow)
            )}
          </SortableContext>
        </SectionDroppable>
      ))}
    </DndContext>
  );
}

function SectionDroppable({
  name, count, children,
}: { name: string | null; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: secDroppableId(name) });
  return (
    <section className="todos-section" data-over={isOver || undefined}>
      <header className="todos-section-head">
        <Icons.Hash size={12} />
        <span className="todos-section-name">{name ?? 'Ungrouped'}</span>
        <span className="ct">{count}</span>
      </header>
      <div ref={setNodeRef} className="todos-section-body">
        {children}
      </div>
    </section>
  );
}
