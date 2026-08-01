import { useState } from 'react';
import { probeServer, saveNativeServerConfig } from '../lib/api';
import { normalizeServerOrigin } from '../lib/nativeConfig';

// First-run screen for the native (iOS) shell: collects the Open Brain
// server URL + API key, verifies the pair against the live backend, persists
// it, and reloads so bootAuth picks it up. Web builds never render this —
// they are same-origin and authenticate via Easy Auth / the dev env key.
export function ConnectScreen() {
  const [server, setServer] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const origin = normalizeServerOrigin(server);
    if (!origin) {
      setError('Enter a valid server URL, e.g. https://openbrain.example.com');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await probeServer(origin, key.trim());
      saveNativeServerConfig(origin, key.trim());
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-title">Open Brain</div>
        <div className="page-subtle">Connect to your server to get started.</div>
        <div style={{ height: 20 }} />
        <label className="field-label" htmlFor="connect-server">Server URL</label>
        <input
          id="connect-server"
          className="input"
          placeholder="https://openbrain.example.com"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          value={server}
          onChange={(e) => setServer(e.target.value)}
        />
        <div style={{ height: 12 }} />
        <label className="field-label" htmlFor="connect-key">API key</label>
        <input
          id="connect-key"
          className="input"
          type="password"
          placeholder="Your API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error ? <div className="connect-error">{error}</div> : null}
        <div style={{ height: 16 }} />
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || !server.trim() || !key.trim()}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  );
}
