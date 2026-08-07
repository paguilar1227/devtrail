// Todos — the standalone sectioned todos view reached from the sidebar.
// Kept as its own page (deliberate — Alex isn't ready to retire it); the
// body is the shared TodosPanel, so this file is just a shell: heading +
// a scope dropdown (Personal / All / each active project) over the exact
// implementation Home's Todos tab and the project Todos tabs render.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SortDropdown } from '../components/SortDropdown';
import { TodosPanel, type PanelScope } from '../components/panels/TodosPanel';
import { listProjects } from '../lib/api';
import { toUiProjects } from '../lib/view';
import type { ActionDispatch } from '../types';

interface Props {
  onAction: ActionDispatch;
  initialScope?: PanelScope;
}

export function TodosPage({ onAction, initialScope }: Props) {
  const [scope, setScope] = useState<PanelScope>(initialScope ?? 'personal');

  // --- scope dropdown (Personal / All / each active project) ---
  const projectsQ = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const projects = useMemo(
    () => toUiProjects(projectsQ.data ?? [], []).filter((p) => p.status === 'active'),
    [projectsQ.data],
  );
  const scopeModes: readonly PanelScope[] = useMemo(
    () => ['personal', 'all', ...projects.map((p) => p.id)],
    [projects],
  );
  const scopeLabels = useMemo(() => {
    const out: Record<string, string> = { personal: 'Personal', all: 'All projects' };
    for (const p of projects) out[p.id] = p.name;
    return out;
  }, [projects]);

  const contextLabel = scope === 'personal' || scope === 'all' ? undefined : scopeLabels[scope];

  return (
    <div className="todos-view">
      <div className="notes-view-head">
        <div>
          <h1>Todos</h1>
        </div>
        <SortDropdown<PanelScope>
          id="todos-scope"
          mode={scope}
          modes={scopeModes}
          labels={scopeLabels}
          onChange={setScope}
          label="Scope"
        />
      </div>
      {/* No key: the panel resets its own view state on scope change, and
          staying mounted lets keepPreviousData keep the previous scope's
          rows visible during the swap instead of flashing "Loading…". */}
      <TodosPanel scope={scope} onAction={onAction} contextLabel={contextLabel} />
    </div>
  );
}
