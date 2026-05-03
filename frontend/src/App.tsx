import { useEffect, useState } from 'react';
import { hasApiKey, setApiKey } from './lib/api';
import { Home } from './pages/Home';
import { ProjectDetail } from './pages/ProjectDetail';

type View =
  | { name: 'home' }
  | { name: 'project'; id: string };

export default function App() {
  const [authed, setAuthed] = useState(hasApiKey());
  const [view, setView] = useState<View>({ name: 'home' });
  const [keyInput, setKeyInput] = useState('');

  useEffect(() => {
    // Parse URL hash for deep linking: #/project/<id>
    const hash = window.location.hash;
    const projectMatch = hash.match(/^#\/project\/([a-f0-9-]+)$/);
    if (projectMatch) setView({ name: 'project', id: projectMatch[1] });

    const onHash = () => {
      const h = window.location.hash;
      if (h === '' || h === '#' || h === '#/') setView({ name: 'home' });
      const m = h.match(/^#\/project\/([a-f0-9-]+)$/);
      if (m) setView({ name: 'project', id: m[1] });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (v: View) => {
    setView(v);
    if (v.name === 'home') window.location.hash = '';
    else if (v.name === 'project') window.location.hash = `#/project/${v.id}`;
  };

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card w-full max-w-md">
          <h1 className="text-2xl font-bold mb-2">Open Brain</h1>
          <p className="text-muted text-sm mb-4">Enter your API key to continue.</p>
          <input
            className="input mb-3"
            type="password"
            placeholder="API key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyInput) {
                setApiKey(keyInput);
                setAuthed(true);
              }
            }}
          />
          <button
            className="btn w-full"
            onClick={() => { setApiKey(keyInput); setAuthed(true); }}
            disabled={!keyInput}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <button className="font-bold text-lg hover:text-accent transition-colors" onClick={() => navigate({ name: 'home' })}>
            🧠 Open Brain
          </button>
          <button
            className="btn-ghost text-xs text-muted"
            onClick={() => {
              localStorage.removeItem('ob_api_key');
              setAuthed(false);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {view.name === 'home' && <Home onOpenProject={(id) => navigate({ name: 'project', id })} />}
        {view.name === 'project' && <ProjectDetail projectId={view.id} onBack={() => navigate({ name: 'home' })} />}
      </main>
    </div>
  );
}
