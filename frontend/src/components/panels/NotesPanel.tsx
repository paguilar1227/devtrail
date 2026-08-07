// The shared notes surface — used by Home's Notes tab (scope 'personal' |
// 'all') and the project page's Notes tab (scope = project UUID). Card
// grid + pinned/processing filters + hybrid search + capture.
//
// Capture is two-speed, mirroring what the old Home column offered:
//   - quick-capture input: type → Enter → note created (first line becomes
//     the title) → editor pops for fleshing out body/tags/projects.
//   - "New note" button: straight to a blank editor.
//
// The Notes sidebar page (folder browser) is a different, deliberate way
// to browse and stays its own surface — this panel is the flat browse.

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { FilterChip, Status, Tag } from '../primitives';
import { SearchInput, type SigilKind } from '../SearchInput';
import { NoteRow } from '../NoteRow';
import { NoteSortDropdown } from '../SortDropdown';
import { createNote, getContent, listContent } from '../../lib/api';
import { toUiNote } from '../../lib/view';
import { useEntitySearch } from '../../lib/useEntitySearch';
import { useTagSuggestions } from '../../lib/useTagSuggestions';
import { openEntity } from '../../lib/openEntity';
import { useNoteSortMode, compareNotesForMode } from '../../lib/useNoteSortMode';
import { fmtRel } from '../../lib/util';
import type { ActionDispatch } from '../../types';
import { scopeToProjectId, type PanelScope } from './TodosPanel';

interface Props {
  scope: PanelScope;
  onAction: ActionDispatch;
  /** Human label for the scope, used in search placeholder. */
  contextLabel?: string;
}

const NOTE_SIGILS: readonly SigilKind[] = ['tag'];
const NO_MENTIONS: never[] = [];

type NoteFilter = 'all' | 'pinned' | 'pending';

export function NotesPanel({ scope, onAction, contextLabel }: Props) {
  const qc = useQueryClient();
  const projectId = scopeToProjectId(scope);
  const isProjectScope = scope !== 'personal' && scope !== 'all';
  const { mode: sortMode, setMode: setSortMode } = useNoteSortMode(`panel:${scope}`);
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [draft, setDraft] = useState('');

  // Hybrid search scoped to this panel's notes — same component + path as
  // Home. Typing flips the panel from the card grid to a flat ranked
  // result list; clearing returns to browse.
  const { query, setQuery, searchActive, hits, isFetching: searchFetching, error: searchError } =
    useEntitySearch({ projectId, entityTypes: ['note'] });
  const tagSuggestions = useTagSuggestions(
    scope === 'personal' ? { scope: 'personal', type: 'note' }
      : scope === 'all' ? { type: 'note' }
        : { project_id: scope, type: 'note' },
  );

  const noteHits = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof hits = [];
    for (const h of hits) {
      if (h.entity_kind !== 'note' || seen.has(h.entity_id)) continue;
      seen.add(h.entity_id);
      out.push(h);
    }
    return out;
  }, [hits]);

  // View state must not leak across scopes (the quick-capture draft is
  // deliberately kept). keepPreviousData: the scope prop re-keys the query
  // mid-interaction (Home's Personal/All toggle) — without it the whole
  // panel chrome unmounts to "Loading…" on every flip.
  useEffect(() => {
    setFilter('all');
    setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['content', 'note', 'panel', scope],
    queryFn: () => listContent(projectId === undefined ? { type: 'note' } : { type: 'note', project_id: projectId }),
    placeholderData: keepPreviousData,
  });

  // Quick capture — first line becomes the title (capped at 80 chars),
  // full text goes into the body. On success, pop the editor for the
  // just-created note so the user can flesh out body/tags/projects
  // without an extra click. The editor needs the full ContentItem, so we
  // refetch by id — POST /content only returns { id, status }.
  const noteCreate = useMutation({
    mutationFn: async (body: string) => {
      const firstLine = body.split('\n')[0].trim();
      const title = (firstLine || 'Untitled note').slice(0, 80);
      const created = await createNote({
        type: 'note',
        title,
        content: body,
        project_ids: isProjectScope ? [scope] : [],
        tags: [],
      });
      return getContent(created.id);
    },
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['content'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['project-counts'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      if (item.type === 'note') {
        onAction({ kind: 'note-edit', payload: toUiNote(item) });
      }
    },
  });

  const notes = useMemo(() => {
    const sorted = (data ?? []).slice().sort(compareNotesForMode(sortMode));
    return sorted.map(toUiNote);
  }, [data, sortMode]);
  const pinnedCount = notes.filter(n => n.pinned).length;
  const pendingCount = notes.filter(n => n.processing_status === 'pending').length;
  const visibleNotes = useMemo(
    () =>
      filter === 'pinned' ? notes.filter((n) => n.pinned)
        : filter === 'pending' ? notes.filter((n) => n.processing_status === 'pending')
          : notes,
    [notes, filter],
  );

  if (error) {
    return <div className="page-subtle" style={{ color: 'var(--danger)' }}>Failed to load notes: {String((error as Error).message)}</div>;
  }
  if (isLoading) {
    return <div className="page-subtle">Loading notes…</div>;
  }

  return (
    <div className="notes-panel">
      {!searchActive && (
        <>
          <div className="todo-input-row">
            <div className="field">
              <Icons.Plus />
              <input
                placeholder="+ Quick note — press Enter to capture"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim() && !noteCreate.isPending) {
                    e.preventDefault();
                    const c = draft.trim();
                    setDraft('');
                    noteCreate.mutate(c);
                  }
                }}
                disabled={noteCreate.isPending}
              />
            </div>
          </div>
          {noteCreate.error ? (
            <div className="page-subtle" style={{ color: 'var(--danger)', marginTop: 4 }}>
              Failed to create note: {noteCreate.error instanceof Error ? noteCreate.error.message : String(noteCreate.error)}
            </div>
          ) : null}
        </>
      )}

      <div className="filter-bar">
        {searchActive ? null : (
          <>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              All <span style={{ marginLeft: 4 }}>{notes.length}</span>
            </FilterChip>
            <FilterChip active={filter === 'pinned'} onClick={() => setFilter('pinned')}>
              Pinned <span style={{ marginLeft: 4 }}>{pinnedCount}</span>
            </FilterChip>
            <FilterChip active={filter === 'pending'} onClick={() => setFilter('pending')}>
              Processing <span style={{ marginLeft: 4 }}>{pendingCount}</span>
            </FilterChip>
          </>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <div className="search-box">
            <Icons.Search size={13} />
            <SearchInput
              value={query}
              onChange={setQuery}
              onSubmit={() => { /* live search — no submit */ }}
              tags={tagSuggestions}
              mentions={NO_MENTIONS}
              sigils={NOTE_SIGILS}
              placeholder={contextLabel ? `Search ${contextLabel} notes… try #tag` : 'Search notes… try #tag'}
            />
          </div>
          {searchActive ? null : (
            <NoteSortDropdown id={`panel-${scope}-notes-sort`} mode={sortMode} onChange={setSortMode} />
          )}
          <button
            className="btn btn-sm"
            onClick={() => onAction({ kind: 'note-edit', payload: null, projectId: isProjectScope ? scope : undefined })}
          >
            <Icons.Plus /> New note
          </button>
        </span>
      </div>

      {searchActive ? (
        searchError ? (
          <div className="page-subtle" style={{ color: 'var(--danger)' }}>
            Search failed: {searchError instanceof Error ? searchError.message : String(searchError)}
          </div>
        ) : searchFetching && noteHits.length === 0 ? (
          <div className="page-subtle">Searching…</div>
        ) : noteHits.length === 0 ? (
          <div className="page-subtle">No notes match.</div>
        ) : (
          <div className="todo-list-drawer-rows">
            {noteHits.map((h) => (
              <NoteRow
                key={h.entity_id}
                note={{ title: h.title }}
                sub={h.excerpt}
                onClick={() => openEntity(h, onAction)}
              />
            ))}
          </div>
        )
      ) : notes.length === 0 ? (
        <div className="page-subtle">
          {isProjectScope ? 'No notes in this project yet — capture above.' : 'No personal notes — capture above.'}
        </div>
      ) : visibleNotes.length === 0 ? (
        <div className="page-subtle">
          {filter === 'pinned' ? 'No pinned notes in this scope.' : 'No notes are processing.'}
        </div>
      ) : (
        <div className="note-grid">
          {visibleNotes.map(n => (
            <div key={n.id} className="note-card" onClick={() => onAction({ kind: 'note-edit', payload: n })}>
              <div className="row-flex gap-2">
                <span className="nm">{n.title}</span>
                {n.pinned ? (
                  <Icons.Pin size={12} style={{ color: 'var(--fg-subtle)', marginLeft: 'auto' }} />
                ) : null}
              </div>
              <div className="body">{n.body.replace(/^#+\s.*\n?/gm, '').replace(/\*/g, '').trim()}</div>
              <div className="ft">
                <div className="tags">
                  {n.tags.slice(0, 3).map(t => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
                <div className="row-flex gap-2">
                  <Status status={n.processing_status} />
                  <span>{fmtRel(n.updated_at)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
