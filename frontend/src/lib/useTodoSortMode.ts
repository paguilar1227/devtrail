// Per-surface persistent todo sort mode. Each surface (Home column,
// Inbox drawer, Project X todos panel) keeps its own choice — the owner's
// "Home option is distinct from Project X option" requirement.
//
// Surface keys are caller-supplied so they can include scoping like
// `project:<id>`. localStorage stores them under
// `obv2.todoSort.<surfaceKey>`. Unknown / corrupt entries fall back to
// the default mode without throwing.

import { useCallback, useEffect, useState } from 'react';
import { TODO_SORT_MODES, type TodoSortMode } from './todoSort';

const STORAGE_PREFIX = 'obv2.todoSort.';
const DEFAULT_MODE: TodoSortMode = 'smart';

function readInitial(surfaceKey: string, defaultMode: TodoSortMode): TodoSortMode {
  if (typeof window === 'undefined') return defaultMode;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + surfaceKey);
    if (raw && (TODO_SORT_MODES as string[]).includes(raw)) return raw as TodoSortMode;
    return defaultMode;
  } catch {
    return defaultMode;
  }
}

export function useTodoSortMode(surfaceKey: string, defaultMode: TodoSortMode = DEFAULT_MODE): {
  mode: TodoSortMode;
  setMode: (m: TodoSortMode) => void;
} {
  const [mode, setModeState] = useState<TodoSortMode>(() => readInitial(surfaceKey, defaultMode));

  // Re-read when the surface key changes (e.g. user navigates from
  // Project A to Project B). Without this the dropdown would stick on
  // Project A's last choice when re-mounting against Project B's key.
  useEffect(() => {
    setModeState(readInitial(surfaceKey, defaultMode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + surfaceKey, mode);
    } catch {
      // Quota / private mode — fall through; in-memory state still works.
    }
  }, [surfaceKey, mode]);

  const setMode = useCallback((m: TodoSortMode) => setModeState(m), []);
  return { mode, setMode };
}
