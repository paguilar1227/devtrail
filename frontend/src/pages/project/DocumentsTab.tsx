// Thin wrapper — the project Documents tab IS the shared DocumentsPanel
// pinned to this project's scope. Filters, bulk ops, retry/reprocess all
// come from the panel, identical to Home's Documents tab.

import { DocumentsPanel } from '../../components/panels/DocumentsPanel';
import type { ActionDispatch, Project } from '../../types';

interface Props {
  project: Project;
  onAction: ActionDispatch;
}

export function DocumentsTab({ project, onAction }: Props) {
  return <DocumentsPanel scope={project.id} project={project} onAction={onAction} />;
}
