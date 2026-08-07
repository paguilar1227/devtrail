// Thin wrapper — the project Notes tab IS the shared NotesPanel pinned to
// this project's scope. Card grid, filters, quick capture, and hybrid
// search all come from the panel, identical to Home's Notes tab.

import { NotesPanel } from '../../components/panels/NotesPanel';
import type { ActionDispatch, Project } from '../../types';

interface Props {
  project: Project;
  onAction: ActionDispatch;
}

export function NotesTab({ project, onAction }: Props) {
  return <NotesPanel scope={project.id} contextLabel={project.name} onAction={onAction} />;
}
