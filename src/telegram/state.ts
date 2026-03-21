// src/telegram/state.ts
// Shared mutable state types passed between handler modules

export type LastActionEntry = {
  action: string;
  reminderId: string;
  previousState?: Record<string, unknown>;
};

export type PendingSubtaskEntry = {
  parentId: string;
  parentContent: string;
  parentProject: string | null;
  parentSection: string | null;
  depth: number;
};

export type PendingActionEntry = {
  action: 'edit' | 'comment' | 'move';
  reminderId: string;
};

export interface StateRefs {
  lastActions: Map<string, LastActionEntry>;
  todoNumberMaps: Map<string, Map<number, string>>;
  pendingSubtask: Map<string, PendingSubtaskEntry>;
  pendingAction: Map<string, PendingActionEntry>;
}
