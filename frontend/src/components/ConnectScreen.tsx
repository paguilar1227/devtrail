import { useState } from 'react';
import { probeServer, saveApiKey, saveNativeServerConfig } from '../lib/api';
import { normalizeServerOrigin } from '../lib/nativeConfig';

// Sign-in screen. Native (iOS) shell: collects the DevTrail server URL + API
// key. Web with AUTH_MODE=api-key: the page is already on the server, so it
// only asks for the API key. Either way the pair is verified against the live
// backend before it is stored, then the page reloads so bootAuth picks it up.
export function ConnectScreen({ mode = 'native' }: { mode?: 'native' | 'web' }) {
  const web = mode === 'web';
  const [server, setServer] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const origin = web ? window.location.origin : normalizeServerOrigin(server);
    if (!origin) {
      setError('Enter a valid server URL, e.g. https://devtrail.example.com');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await probeServer(origin, key.trim());
      if (web) saveApiKey(key.trim());
      else saveNativeServerConfig(origin, key.trim());
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-title">DevTrail</div>
        <div className="page-subtle">
          {web ? 'Sign in with the API key this server was started with.' : 'Connect to your server to get started.'}
        </div>
        <div style={{ height: 20 }} />
        {web ? null : (
          <>
            <label className="field-label" htmlFor="connect-server">Server URL</label>
            <input
              id="connect-server"
              className="input"
              placeholder="https://devtrail.example.com"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
            <div style={{ height: 12 }} />
          </>
        )}
        <label className="field-label" htmlFor="connect-key">API key</label>
        <input
          id="connect-key"
          className="input"
          type="password"
          placeholder="Your API key"
          autoFocus={web}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error ? <div className="connect-error">{error}</div> : null}
        <div style={{ height: 16 }} />
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || (!web && !server.trim()) || !key.trim()}
        >
          {busy ? (web ? 'Signing in…' : 'Connecting…') : (web ? 'Sign in' : 'Connect')}
        </button>
      </div>
    </div>
  );
}
