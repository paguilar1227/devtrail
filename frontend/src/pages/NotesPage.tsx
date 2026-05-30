// Notes browser — a Bear-style three-column view over notes organized by
// FOLDERS (hierarchical slash-tags; see lib/folders.ts). Left: the folder
// tree (collapsible, resizable). Middle: notes in the selected folder (or
// hybrid search results) with the SAME SearchInput as Home. Right: the note
// content + a single, click-to-edit folder-path chip.
//
// A note belongs to exactly ONE folder (one slash-tag) at a time. Editing
// the chip re-files the note and re-navigates the tree/middle to its new
// home. Scope (personal / all / project) mirrors the Tags view.
//
// Columns are resizable (drag the dividers) and collapsible:
//   Cmd/Ctrl+1 — toggle the folder tree
//   Cmd/Ctrl+2 — toggle tree + list together (follows the list's state)
//   Cmd/Ctrl+3 — toggle "only the note" (hide both side columns)

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { SortDropdown } from '../components/SortDropdown';
import { SearchInput, type SigilKind } from '../components/SearchInput';
import { NoteRow } from '../components/NoteRow';
import { NoteReaderBody } from '../components/modals/NoteReaderDrawer';
import { listContent, listProjects, updateContent } from '../lib/api';
import { toUiNote, toUiProjects } from '../lib/view';
import { useEntitySearch } from '../lib/useEntitySearch';
import { useTagSuggestions } from '../lib/useTagSuggestions';
import {
  buildFolderTree, noteInFolder, normalizeFolderPath, ancestorsOf,
  type FolderNode,
} from '../lib/folders';
import { cls } from '../lib/util';
import type { ContentItem } from '@open-brain/shared';
import type { ActionDispatch, Note, Route } from '../types';

type ScopeMode = 'personal' | 'all' | string;

interface Props {
  onAction: ActionDispatch;
  onRoute: (r: Route) => void;
  initialPath?: string;
  initialScope?: ScopeMode;
}

const NOTE_SIGILS: readonly SigilKind[] = ['tag'];
const NO_MENTIONS: never[] = [];
const TREE_MIN = 160, TREE_MAX = 460, LIST_MIN = 220, LIST_MAX = 560;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const scopeToProjectId = (scope: ScopeMode): 'null' | string | undefined =>
  scope === 'personal' ? 'null' : scope === 'all' ? undefined : scope;

export function NotesPage({ onAction, onRoute, initialPath, initialScope }: Props) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<ScopeMode>(initialScope ?? 'personal');
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialPath ? ancestorsOf(initialPath) : []));

  // Column layout: visibility + widths (resizable).
  const [showTree, setShowTree] = useState(true);
  const [showList, setShowList] = useState(true);
  const [treeW, setTreeW] = useState(248);
  const [listW, setListW] = useState(340);

  const expand = (path: string) => setExpanded((s) => {
    const n = new Set(s);
    for (const a of ancestorsOf(path)) n.add(a);
    return n;
  });
  const toggle = (path: string) => setExpanded((s) => {
    const n = new Set(s);
    n.has(path) ? n.delete(path) : n.add(path);
    return n;
  });
  // Selecting a folder reveals its children (never collapses on click — the
  // chevron does that), so the nesting is visible immediately.
  const selectFolder = (path: string | null) => {
    setSelectedPath(path);
    if (path) expand(path);
  };

  // --- scope dropdown options (Personal / All / each active project) ---
  const projectsQ = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const projects = useMemo(
    () => toUiProjects(projectsQ.data ?? [], []).filter((p) => p.status === 'active'),
    [projectsQ.data],
  );
  const scopeModes: readonly ScopeMode[] = useMemo(
    () => ['personal', 'all', ...projects.map((p) => p.id)],
    [projects],
  );
  const scopeLabels = useMemo(() => {
    const out: Record<string, string> = { personal: 'Personal', all: 'All projects' };
    for (const p of projects) out[p.id] = p.name;
    return out;
  }, [projects]);

  const projectId = scopeToProjectId(scope);

  // --- all notes in scope (drives both the tree and the browse list) ---
  const notesQ = useQuery({
    queryKey: ['content', 'note', 'notes-view', scope],
    queryFn: () => listContent(projectId === undefined ? { type: 'note' } : { type: 'note', project_id: projectId }),
  });
  const notes: ContentItem[] = notesQ.data ?? [];

  const roots = useMemo(() => buildFolderTree(notes.map((n) => ({ folder: n.folder }))), [notes]);

  // --- middle column: hybrid search (when typing) OR folder-filtered browse ---
  const { query, setQuery, searchActive, hits } = useEntitySearch({ projectId, entityTypes: ['note'] });
  const tagSuggestions = useTagSuggestions(
    scope === 'personal' ? { scope: 'personal', type: 'note' }
      : scope === 'all' ? { type: 'note' }
        : { project_id: scope, type: 'note' },
  );

  const browseNotes = useMemo(() => {
    const list = selectedPath ? notes.filter((n) => noteInFolder(n.folder, selectedPath)) : notes;
    return [...list]
      .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
      .map(toUiNote);
  }, [notes, selectedPath]);

  const searchNotes = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof hits = [];
    for (const h of hits) {
      if (h.entity_kind !== 'note' || seen.has(h.entity_id)) continue;
      seen.add(h.entity_id);
      out.push(h);
    }
    return out;
  }, [hits]);

  const selectedNote: Note | null = useMemo(() => {
    if (!selectedId) return null;
    const ci = notes.find((n) => n.id === selectedId);
    return ci ? toUiNote(ci) : null;
  }, [notes, selectedId]);

  // When a note is opened, reveal its folder in the tree so the left panel
  // reflects where the note lives (the nesting the user expects to see).
  const selectedFolder = selectedNote?.folder ?? null;
  useEffect(() => { if (selectedFolder) expand(selectedFolder); }, [selectedFolder]);

  // --- folder editing: a note has ONE folder; editing re-files + navigates ---
  const saveFolder = useMutation({
    mutationFn: ({ id, folder }: { id: string; folder: string | null }) => updateContent(id, { folder }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['content', 'note', 'notes-view'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
    },
  });
  const setNoteFolder = (note: Note, path: string | null) => {
    saveFolder.mutate({ id: note.id, folder: path });
    // Re-navigate so the moved note's new group shows in the middle and the
    // new path is revealed/highlighted in the tree. Note stays open.
    setSelectedPath(path);
    if (path) expand(path);
  };

  // --- keyboard: column toggles ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === '1') { e.preventDefault(); setShowTree((t) => !t); }
      else if (e.key === '2') { e.preventDefault(); const next = !showList; setShowTree(next); setShowList(next); }
      else if (e.key === '3') {
        e.preventDefault();
        const onlyNote = !showTree && !showList;
        setShowTree(onlyNote); setShowList(onlyNote); // if only-note → restore; else focus note
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showTree, showList]);

  const scopeNoteCount = notes.length;
  const gridCols =
    `${showTree ? treeW : 0}px ${showTree ? 5 : 0}px ${showList ? listW : 0}px ${showList ? 5 : 0}px minmax(0, 1fr)`;

  return (
    <div className="notes-view">
      <div className="notes-view-head">
        <div>
          <h1>Notes</h1>
          <p className="page-subtle">
            {scopeNoteCount} notes · organized by Folders (nested <code>#a/b/c</code> tags).
            <span className="notes-kbd-hint"> ⌘1/2/3 toggle columns</span>
          </p>
        </div>
        <SortDropdown<ScopeMode>
          id="notes-scope"
          mode={scope}
          modes={scopeModes}
          labels={scopeLabels}
          onChange={(s) => { setScope(s); setSelectedPath(null); }}
          label="Scope"
        />
      </div>

      <div className="notes-cols" style={{ gridTemplateColumns: gridCols }} data-tree={showTree} data-list={showList}>
        {/* ---- LEFT: folder tree ---- */}
        <nav className="notes-tree" aria-label="Folders" aria-hidden={!showTree}>
          <button
            className={cls('notes-tree-row', selectedPath === null && 'active')}
            onClick={() => selectFolder(null)}
          >
            <span className="notes-tree-chev-spacer" aria-hidden="true" />
            <Icons.Layers size={13} />
            <span className="lbl">All notes</span>
            <span className="ct">{scopeNoteCount}</span>
          </button>
          {roots.length === 0 ? (
            <div className="page-subtle notes-tree-empty">
              No folders yet. Add a folder to a note (bottom of the reader) to start a tree.
            </div>
          ) : (
            roots.map((n) => (
              <FolderTreeNode
                key={n.path}
                node={n}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={toggle}
                onSelect={selectFolder}
              />
            ))
          )}
        </nav>

        <ColResizer onResize={(d) => setTreeW((w) => clamp(w + d, TREE_MIN, TREE_MAX))} active={showTree} />

        {/* ---- MIDDLE: search + notes list ---- */}
        <div className="notes-list" aria-hidden={!showList}>
          <div className="notes-list-search">
            <div className="search-box">
              <Icons.Search size={13} />
              <SearchInput
                value={query}
                onChange={setQuery}
                onSubmit={() => { /* live */ }}
                tags={tagSuggestions}
                mentions={NO_MENTIONS}
                sigils={NOTE_SIGILS}
                placeholder="Search notes… try #tag"
              />
            </div>
          </div>
          <div className="notes-list-rows">
            {notesQ.isLoading ? (
              <div className="page-subtle">Loading…</div>
            ) : searchActive ? (
              searchNotes.length === 0 ? (
                <div className="page-subtle">No notes match.</div>
              ) : (
                searchNotes.map((h) => (
                  <NoteRow
                    key={h.entity_id}
                    note={{ title: h.title }}
                    sub={h.excerpt}
                    tags={h.tags}
                    onClick={() => setSelectedId(h.entity_id)}
                  />
                ))
              )
            ) : browseNotes.length === 0 ? (
              <div className="page-subtle">
                {selectedPath ? 'No notes in this folder.' : 'No notes yet.'}
              </div>
            ) : (
              browseNotes.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  tags={n.tags}
                  onClick={() => setSelectedId(n.id)}
                />
              ))
            )}
          </div>
        </div>

        <ColResizer onResize={(d) => setListW((w) => clamp(w + d, LIST_MIN, LIST_MAX))} active={showList} />

        {/* ---- RIGHT: note content + single folder chip ---- */}
        <div className="notes-detail">
          {selectedNote ? (
            <>
              <div className="notes-detail-body">
                <NoteReaderBody
                  key={selectedNote.id}
                  note={selectedNote}
                  onClose={() => setSelectedId(null)}
                  onRoute={onRoute}
                />
              </div>
              <FolderPathEditor
                note={selectedNote}
                pending={saveFolder.isPending}
                onChange={(path) => setNoteFolder(selectedNote, path)}
              />
            </>
          ) : (
            <div className="notes-detail-empty page-subtle">
              {browseNotes.length || searchNotes.length ? 'Select a note to read it.' : 'Nothing here yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- draggable column divider ----
function ColResizer({ onResize, active }: { onResize: (deltaX: number) => void; active: boolean }) {
  const last = useRef(0);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!active) return;
    e.preventDefault();
    last.current = e.clientX;
    const move = (ev: PointerEvent) => { onResize(ev.clientX - last.current); last.current = ev.clientX; };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <div
      className={cls('notes-col-resizer', !active && 'hidden')}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
    />
  );
}

// ---- recursive folder tree node ----
function FolderTreeNode({
  node, depth, selectedPath, expanded, onToggle, onSelect,
}: {
  node: FolderNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const hasKids = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  return (
    <>
      <div
        className={cls('notes-tree-row', selectedPath === node.path && 'active')}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node.path)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.path); } }}
      >
        {hasKids ? (
          <button
            className={cls('notes-tree-chev', isOpen && 'open')}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
          >
            <Icons.ChevronRight size={16} />
          </button>
        ) : (
          <span className="notes-tree-chev-spacer" aria-hidden="true" />
        )}
        <span className="lbl" title={node.path}>{node.name}</span>
        <span className="ct">{node.noteCount}</span>
      </div>
      {hasKids && isOpen
        ? node.children.map((c) => (
            <FolderTreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}

// ---- single folder-path chip, click-to-edit (pinned at the detail bottom) ----
function FolderPathEditor({
  note, pending, onChange,
}: {
  note: Note;
  pending: boolean;
  onChange: (path: string | null) => void;
}) {
  const folder = note.folder;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Drop edit state when switching notes.
  useEffect(() => { setEditing(false); setDraft(''); }, [note.id]);

  const startEdit = () => { setDraft(folder ?? ''); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const next = normalizeFolderPath(draft) || null;
    if (next !== folder) onChange(next);
  };

  return (
    <div className="notes-folder-bar" aria-label="Folder for this note">
      <span className="notes-folder-ic"><Icons.Layers size={12} /></span>
      {editing ? (
        <input
          className="notes-folder-input"
          autoFocus
          placeholder="area/topic/sub"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(''); }
          }}
          onBlur={commit}
        />
      ) : folder ? (
        <button className="notes-folder-chip" onClick={startEdit} title="Click to edit folder">
          {folder}
        </button>
      ) : (
        <button className="btn btn-ghost btn-sm notes-folder-add" disabled={pending} onClick={startEdit}>
          <Icons.Plus size={11} /> Folder
        </button>
      )}
      {pending ? <span className="page-subtle">saving…</span> : null}
    </div>
  );
}
