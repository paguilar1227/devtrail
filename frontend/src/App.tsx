import { Fragment, useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CommandPalette } from './components/CommandPalette';
import { MobileTabbar } from './components/MobileTabbar';
import { Sidebar } from './components/Sidebar';
import { Topbar, type Crumb } from './components/Topbar';
import { ConfirmModal } from './components/modals/ConfirmModal';
import { DocReaderDrawer } from './components/modals/DocReaderDrawer';
import { NewProjectModal } from './components/modals/NewProjectModal';
import { NoteEditorModal } from './components/modals/NoteEditorModal';
import { TodoDetailDrawer } from './components/modals/TodoDetailDrawer';
import { UploadModal } from './components/modals/UploadModal';
import { useIsMobile } from './lib/useIsMobile';
import { listProjects } from './lib/api';
import { cls } from './lib/util';
import { ActivityPage } from './pages/ActivityPage';
import { HomePage } from './pages/HomePage';
import { MentionsPage } from './pages/MentionsPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsModal } from './components/modals/SettingsModal';
import { TagsPage } from './pages/TagsPage';
import { TrashPage } from './pages/TrashPage';
import type { ModalKind, Route, SidebarMode, Theme } from './types';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const v = localStorage.getItem('ob.theme');
  return v === 'light' ? 'light' : 'dark';
}

function readInitialSidebarMode(): SidebarMode {
  if (typeof window === 'undefined') return 'collapsed';
  const v = localStorage.getItem('ob.sidebarMode');
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
    localStorage.setItem('ob.theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('ob.sidebarMode', sidebarMode);
  }, [sidebarMode]);

  useEffect(() => {
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
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onAction = useCallback((m: ModalKind) => setModal(m), []);

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    if (r.route === 'projects' && r.action === 'new') {
      setModal({ kind: 'new-project' });
    }
  }, []);

  // Same query key the sidebar already uses, so we share the cache and
  // don't double-fetch.
  const { data: projects = [] } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => listProjects(),
  });
  const project = route.route === 'project' ? projects.find((p) => p.id === route.project) ?? null : null;

  const crumbs: Crumb[] = (() => {
    switch (route.route) {
      case 'home':
        return [{ label: 'Home' }];
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
      case 'mentions':
        return [{ label: 'Find Mentions' }];
      case 'trash':
        return [{ label: 'Archived' }];
      case 'search':
        return [{ label: 'Search' }];
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
        <Topbar crumbs={crumbs} onCmdK={() => setCmdkOpen(true)} />
        <div className="main-scroll">
          {route.route === 'home' && <HomePage onRoute={navigate} onAction={onAction} />}
          {route.route === 'projects' && <ProjectsPage onRoute={navigate} onAction={onAction} />}
          {route.route === 'project' && <ProjectPage projectId={route.project} onAction={onAction} />}
          {route.route === 'activity' && <ActivityPage onAction={onAction} />}
          {route.route === 'tags' && <TagsPage onAction={onAction} />}
          {route.route === 'mentions' && <MentionsPage />}
          {route.route === 'search' && <SearchPage initialQuery={route.query} initialScope={route.scope} />}
          {route.route === 'trash' && <TrashPage />}
        </div>
      </main>
      {isMobile && <MobileTabbar route={route} onRoute={navigate} onAction={onAction} />}

      {modal?.kind === 'upload' && <UploadModal project={modal.payload} onClose={() => setModal(null)} />}
      {modal?.kind === 'note-edit' && <NoteEditorModal note={modal.payload} projectId={modal.projectId} onClose={() => setModal(null)} />}
      {modal?.kind === 'doc-read' && <DocReaderDrawer doc={modal.payload} onClose={() => setModal(null)} />}
      {modal?.kind === 'todo-detail' && <TodoDetailDrawer todo={modal.payload} onClose={() => setModal(null)} />}
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
        <ConfirmModal
          title="Rename tag"
          message={
            <Fragment>
              Renaming "{modal.payload.name}" will update {modal.payload.total} entities across all projects. This cannot be undone.
            </Fragment>
          }
          confirmLabel="Rename"
          danger={false}
          requireType={modal.payload.name}
          onClose={() => setModal(null)}
          onConfirm={() => setModal(null)}
        />
      )}
      {modal?.kind === 'new-project' && <NewProjectModal onClose={() => setModal(null)} />}
      {modal?.kind === 'settings' && (
        <SettingsModal theme={theme} onTheme={setTheme} onClose={() => setModal(null)} />
      )}

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
          theme={theme}
        />
      )}
    </div>
  );
}
