// Thin wrapper — the project Todos tab IS the shared TodosPanel pinned to
// this project's scope. Sections, drag-reorder, quick-add, filters, and
// hybrid search all come from the panel, identical to Home's Todos tab.

import { TodosPanel } from '../../components/panels/TodosPanel';
import type { ActionDispatch, Project } from '../../types';

interface Props {
  project: Project;
  onAction: ActionDispatch;
}

export function TodosTab({ project, onAction }: Props) {
  return <TodosPanel scope={project.id} contextLabel={project.name} onAction={onAction} />;
}
