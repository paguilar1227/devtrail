import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/SessionPage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { MobileTabbar } from './components/MobileTabbar';
import { Sidebar } from './components/Sidebar';
import { Topbar, type Crumb } from './components/Topbar';
import { ConfirmModal } from './components/modals/ConfirmModal';
import { DocReaderDrawer } from './components/modals/DocReaderDrawer';
import { ProjectModal } from './components/modals/ProjectModal';
import { NoteEditorModal } from './components/modals/NoteEditorModal';
import { TodoDetailDrawer } from './components/modals/TodoDetailDrawer';
import { UploadModal } from './components/modals/UploadModal';
import { useIsMobile } from './lib/useIsMobile';
import { useProjects } from './lib/useProjects';
import { cls } from './lib/util';
import { ActivityPage } from './pages/ActivityPage';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsModal } from './components/modals/SettingsModal';
import { TagsPage } from './pages/TagsPage';
import { TagDetailPage } from './pages/TagDetailPage';
import { NotesPage } from './pages/NotesPage';
import { TodosPage } from './pages/TodosPage';
import { RenameTagModal } from './components/modals/RenameTagModal';
import { TrashPage } from './pages/TrashPage';
import type { ModalKind, Route, SidebarMode, Theme } from './types';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const v = localStorage.getItem('devtrail.theme');
  return v === 'dark' ? 'dark' : 'light';
}

function readInitialSidebarMode(): SidebarMode {
  if (typeof window === 'undefined') return 'collapsed';
  const v = localStorage.getItem('devtrail.sidebarMode');
  return v === 'expanded' || v === 'hidden' ? v : 'collapsed';
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [route, setRoute] = useState<Route>({ route: 'home' });
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readInitialSidebarMode);
  const isMobile = useIsMobile();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151715' : '#ffffff');
    localStorage.setItem('devtrail.theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('devtrail.sidebarMode', sidebarMode);
  }, [sidebarMode]);

  // Keyboard sequences fire from a listener registered once — route through
  // a ref so they always use the current navigate (assigned below, after
  // navigate is defined).
  const goRef = useRef<(r: Route) => void>(() => {});

  useEffect(() => {
    // "G then <key>" navigation sequences (advertised in the palette):
    // G-H → Home, G-A → Activity, G-T → Tags. Tracked with a short-lived
    // timestamp; suppressed while typing in a field or when a modifier is
    // held, so plain text entry can't trigger navigation.
    let gArmedAt = 0;
    const G_WINDOW_MS = 900;
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(o => !o);
      }
      if (e.key === 'Escape') {
        setModal(null);
        setCmdkOpen(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setTheme(t => (t === 'dark' ? 'light' : 'dark'));
      }

      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) {
        gArmedAt = 0;
        return;
      }
      const key = e.key.toLowerCase();
      if (gArmedAt && Date.now() - gArmedAt < G_WINDOW_MS) {
        gArmedAt = 0;
        if (key === 'h') { e.preventDefault(); goRef.current({ route: 'home' }); return; }
        if (key === 'a') { e.preventDefault(); goRef.current({ route: 'activity' }); return; }
        if (key === 't') { e.preventDefault(); goRef.current({ route: 'tags' }); return; }
      }
      if (key === 'g') gArmedAt = Date.now();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onAction = useCallback((m: ModalKind) => setModal(m), []);

  // Bumped whenever the user explicitly "goes home" with no search seed
  // (sidebar Home click, palette Go to Home, etc). Used as a `key` on the
  // HomePage instance so internal state resets cleanly — useState
  // initializers re-run, the URL is re-read fresh. Without this, clicking
  // Home while a search is active leaves the search active because the
  // existing HomePage instance hangs onto its query state.
  const [homeNonce, setHomeNonce] = useState(0);

  const navigate = useCallback((r: Route) => {
    if (r.route === 'home' && !r.q && !r.scope) {
      // "Fresh home" intent — wipe URL view-state (q, scope, tag, mode)
      // and force a HomePage remount so its internal state matches. A tab
      // deep-link (sidebar "Todos") keeps its ?tab so the remount lands
      // on the right tab.
      window.history.replaceState(null, '', r.tab && r.tab !== 'todos' ? `/?tab=${r.tab}` : '/');
      setHomeNonce((n) => n + 1);
    }
    setRoute(r);
    if (r.route === 'projects' && r.action === 'new') {
      setModal({ kind: 'new-project' });
    }
  }, []);

  useEffect(() => { goRef.current = navigate; }, [navigate]);

  // Palette "Search…" — the advertised intent is "go to home AND focus the
  // search bar", not just routing. HomePage focuses its input whenever this
  // nonce advances past 0.
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const openSearch = useCallback(() => {
    navigate({ route: 'home' });
    setSearchFocusNonce((n) => n + 1);
  }, [navigate]);

  const { data: projects = [] } = useProjects();
  const project = route.route === 'project' ? projects.find((p) => p.id === route.project) ?? null : null;

  const crumbs: Crumb[] = (() => {
    switch (route.route) {
      case 'home':
        return [{ label: 'Home' }];
      case 'sessions': return [{ label: 'Sessions' }];
      case 'session': return [{ label: 'Sessions', onClick: () => navigate({ route: 'sessions' }) }, { label: 'Session' }];
      case 'projects':
        return [{ label: 'Projects' }];
      case 'project':
        return [
          { label: 'Projects', onClick: () => setRoute({ route: 'projects' }) },
          { label: project?.name || 'Project' },
        ];
      case 'activity':
        return [{ label: 'Activity' }];
      case 'tags':
        return [{ label: 'Tags' }];
      case 'notes':
        return [{ label: 'Notes' }];
      case 'todos':
        return [{ label: 'Todos' }];
      case 'trash':
        return [{ label: 'Archived' }];
      default:
        return [{ label: '—' }];
    }
  })();

  const sb: SidebarMode = isMobile ? 'hidden' : sidebarMode;
  const appProps: Record<string, string> = { 'data-sb': sb };
  if (isMobile) appProps['data-mobile'] = 'true';

  return (
    <div className={cls('app')} {...appProps}>
      {!isMobile && (
        <Sidebar
          route={route}
          onRoute={navigate}
          onAction={onAction}
          collapsed={sidebarMode === 'collapsed'}
          onToggleCollapsed={() =>
            setSidebarMode(sidebarMode === 'collapsed' ? 'expanded' : 'collapsed')
          }
        />
      )}
      <main className="main">
        <Topbar crumbs={crumbs} />
        <div className="main-scroll">
          {route.route === 'home' && (
            <HomePage
              key={homeNonce}
              onRoute={navigate}
              onAction={onAction}
              // q + scope on the home route are the cross-page search
              // seed; HomePage reads them on mount.
              initialSearch={route.q || route.scope ? { query: route.q, scope: route.scope } : undefined}
              initialTab={route.tab}
              searchFocusNonce={searchFocusNonce}
            />
          )}
          {route.route === 'sessions' && <SessionsPage onRoute={navigate} />}
          {route.route === 'session' && <SessionPage key={route.session} sessionId={route.session} onRoute={navigate} onAction={onAction} />}
          {route.route === 'projects' && <ProjectsPage onRoute={navigate} onAction={onAction} />}
          {route.route === 'project' && <ProjectPage projectId={route.project} onAction={onAction} onRoute={navigate} />}
          {route.route === 'activity' && <ActivityPage onAction={onAction} />}
          {route.route === 'tags' && (route.name
            ? <TagDetailPage key={route.name} name={route.name} onAction={onAction} onRoute={setRoute} />
            : <TagsPage onAction={onAction} onRoute={setRoute} />
          )}
          {route.route === 'notes' && (
            <NotesPage onAction={onAction} onRoute={navigate} initialPath={route.path} initialScope={route.scope} />
          )}
          {route.route === 'todos' && (
            <TodosPage onAction={onAction} initialScope={route.scope} />
          )}
          {route.route === 'trash' && <TrashPage />}
        </div>
      </main>
      {isMobile && <MobileTabbar route={route} onRoute={navigate} onAction={onAction} />}

      {modal?.kind === 'upload' && <UploadModal project={modal.payload} sessionId={modal.sessionId} onClose={() => setModal(null)} />}
      {modal?.kind === 'note-edit' && <NoteEditorModal note={modal.payload} sessionId={modal.sessionId} projectId={modal.projectId} initialFolder={modal.folder} onClose={() => setModal(null)} />}
      {modal?.kind === 'doc-read' && <DocReaderDrawer doc={modal.payload} onClose={() => setModal(null)} onRoute={navigate} />}
      {modal?.kind === 'todo-detail' && <TodoDetailDrawer key={modal.payload.id} todo={modal.payload} onClose={() => setModal(null)} onAction={onAction} />}
      {modal?.kind === 'bulk-confirm' && (
        <ConfirmModal
          title={`Archive ${modal.payload.count} ${modal.payload.kind}?`}
          message="Items will be moved to the Archive. They'll be excluded from chat retrieval but remain searchable from the Archived view. You can restore at any time."
          confirmLabel="Archive"
          danger
          onClose={() => setModal(null)}
          onConfirm={() => setModal(null)}
        />
      )}
      {modal?.kind === 'confirm-rename' && (
        <RenameTagModal tag={modal.payload} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'new-project' && <ProjectModal onClose={() => setModal(null)} />}
      {modal?.kind === 'settings' && (
        <SettingsModal theme={theme} onTheme={setTheme} onClose={() => setModal(null)} />
      )}
      {/* Search is inline on HomePage; no modal here. The personal-*
          list drawers are gone — Home's tabs render the full panels. */}

      {cmdkOpen && (
        <CommandPalette
          onClose={() => setCmdkOpen(false)}
          onRoute={(r) => {
            navigate(r);
            setCmdkOpen(false);
          }}
          onAction={(m) => {
            onAction(m);
            setCmdkOpen(false);
          }}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onOpenSearch={() => {
            openSearch();
            setCmdkOpen(false);
          }}
          theme={theme}
        />
      )}
    </div>
  );
}
