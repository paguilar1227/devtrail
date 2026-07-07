import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';
import { ProjectCard } from '../components/ProjectCard';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { ProjectModal } from '../components/modals/ProjectModal';
import {
  archiveProject,
  deleteProject,
  listProjectCounts,
  listProjects,
  pinProject,
  restoreProject,
  unpinProject,
} from '../lib/api';
import { toUiProjects } from '../lib/view';
import { cls, fmtRel } from '../lib/util';
import type { ActionDispatch, Project, Route } from '../types';

interface Props {
  onRoute: (r: Route) => void;
  onAction: ActionDispatch;
}

export function ProjectsPage({ onRoute, onAction }: Props) {
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const qc = useQueryClient();

  const [projectsQ, countsQ] = useQueries({
    queries: [
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
    ],
  });

  const all = useMemo(
    () => toUiProjects(projectsQ.data ?? [], countsQ.data ?? []),
    [projectsQ.data, countsQ.data],
  );
  const projects = all.filter((p) => filter === 'all' || p.status === filter);
  const activeCount = all.filter((p) => p.status === 'active').length;
  const archivedCount = all.filter((p) => p.status === 'archived').length;

  // Per-row ⋯ menu (list view) — same action set as the project page's
  // hero menu, reachable without leaving the catalog.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'edit' | 'delete'; project: Project }>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: ['project-counts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
  };
  // The confirm dialog is gone by the time a request fails, so failures
  // surface as a message under the filter bar; invalidate in onSettled keeps
  // the rows honest either way.
  const [actionError, setActionError] = useState<string | null>(null);
  const mutationOpts = (verb: string) => ({
    onSuccess: () => setActionError(null),
    onError: (err: unknown) =>
      setActionError(`Failed to ${verb}: ${err instanceof Error ? err.message : String(err)}`),
    onSettled: invalidate,
  });
  const pinMut = useMutation({
    mutationFn: (p: Project) => (p.pinned ? unpinProject(p.id) : pinProject(p.id)),
    ...mutationOpts('pin/unpin the project'),
  });
  const archiveMut = useMutation({
    mutationFn: (p: Project) => (p.status === 'archived' ? restoreProject(p.id) : archiveProject(p.id)),
    ...mutationOpts('archive/restore the project'),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    ...mutationOpts('delete the project'),
  });

  const error = projectsQ.error || countsQ.error;
  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load projects: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  if (projectsQ.isLoading || countsQ.isLoading) {
    return (
      <div className="page">
        <div className="page-subtle">Loading…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Projects</h1>
          <p className="page-subtle">
            {activeCount} active workspaces. Drag-pin from any project menu, or archive when done — archived projects keep their citations
            but won't appear in default chat scope.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => onAction({ kind: 'new-project' })}>
          <Icons.Plus /> New project
        </button>
      </div>

      <div className="filter-bar">
        <FilterChip active={filter === 'active'} onClick={() => setFilter('active')}>
          Active <span style={{ marginLeft: 4 }}>{activeCount}</span>
        </FilterChip>
        <FilterChip active={filter === 'archived'} onClick={() => setFilter('archived')}>
          Archived <span style={{ marginLeft: 4 }}>{archivedCount}</span>
        </FilterChip>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </FilterChip>
        <div style={{ marginLeft: 'auto' }} className="seg-toggle">
          <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}>Grid</button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
        </div>
      </div>

      {actionError ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginBottom: 8 }}>
          {actionError}
        </div>
      ) : null}

      {projects.length === 0 ? (
        <div className="page-subtle">
          {filter === 'archived' ? 'No archived projects.' : 'No projects yet — create one to get started.'}
        </div>
      ) : view === 'grid' ? (
        <div className="proj-grid">
          {projects.map((p, i) => (
            <ProjectCard
              key={p.id}
              p={p}
              size={i < 2 ? 'lg' : 'md'}
              onOpen={() => onRoute({ route: 'project', project: p.id })}
            />
          ))}
        </div>
      ) : (
        <div className="row-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className="row project-row"
              onClick={() => onRoute({ route: 'project', project: p.id })}
            >
              <span className={cls('sb-proj-dot', p.accent)}></span>
              <div className="project-row-main">
                <div className="strong">{p.name}</div>
                <div className="subtle project-row-desc">{p.desc}</div>
              </div>
              <span className="subtle project-row-count">{p.counts.docs} docs</span>
              <span className="subtle project-row-count">{p.counts.notes} notes</span>
              <span className="subtle project-row-count">
                {p.counts.done}/{p.counts.todos}
              </span>
              <span className="subtle project-row-count">{fmtRel(p.updated_at)}</span>
              <div
                className="proj-menu-wrap"
                ref={menuFor === p.id ? menuRef : undefined}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="btn btn-ghost btn-icon"
                  title="Project actions"
                  aria-haspopup="menu"
                  aria-expanded={menuFor === p.id}
                  onClick={() => setMenuFor((cur) => (cur === p.id ? null : p.id))}
                >
                  <Icons.More />
                </button>
                {menuFor === p.id ? (
                  <div className="proj-menu" role="menu">
                    <button
                      role="menuitem"
                      disabled={pinMut.isPending}
                      onClick={() => { setMenuFor(null); pinMut.mutate(p); }}
                    >
                      <Icons.Pin size={13} /> {p.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button role="menuitem" onClick={() => { setMenuFor(null); setDialog({ kind: 'edit', project: p }); }}>
                      <Icons.Pencil size={13} /> Edit project
                    </button>
                    <button
                      role="menuitem"
                      disabled={archiveMut.isPending}
                      onClick={() => { setMenuFor(null); archiveMut.mutate(p); }}
                    >
                      <Icons.ArchiveBox size={13} /> {p.status === 'archived' ? 'Restore' : 'Archive'}
                    </button>
                    <div className="proj-menu-sep" />
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={() => { setMenuFor(null); setDialog({ kind: 'delete', project: p }); }}
                    >
                      <Icons.Trash size={13} /> Delete project…
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {dialog?.kind === 'edit' ? (
        <ProjectModal project={dialog.project} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmModal
          title={`Delete "${dialog.project.name}"?`}
          message="This permanently deletes the project and all of its documents, notes, and todos. This can't be undone — to keep it recoverable, Archive instead."
          confirmLabel="Delete forever"
          requireType={dialog.project.name}
          danger
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const id = dialog.project.id;
            setDialog(null);
            deleteMut.mutate(id);
          }}
        />
      ) : null}
    </div>
  );
}
