import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ConfirmProvider } from './components/ConfirmDialog';
import { queryClient } from './lib/queryClient';
import { bootAuth } from './lib/api';
import './styles.css';

// bootAuth resolves the Bearer key in production by exchanging the Easy Auth
// session cookie via /api/auth/token. In local dev (VITE_OPEN_BRAIN_API_KEY
// set) it's a no-op. If the user's session has expired bootAuth performs a
// hard navigation to the AAD login URL and never resolves — that's why we
// don't render anything inside the catch.
bootAuth()
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );
  })
  .catch((err) => {
    if (err?.message === 'Redirecting to login…') return;
    console.error('[bootAuth] failed', err);
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `<div style="padding:2rem;color:#fff;font-family:system-ui">
        <h1>Open Brain</h1>
        <p>Could not authenticate. ${String(err?.message ?? err)}</p>
      </div>`;
    }
  });
