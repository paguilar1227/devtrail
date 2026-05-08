import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite blocks Host headers that don't match this list (DNS-rebinding
    // guard). The tailnet hostname / MagicDNS suffix has to be allowed
    // explicitly when reaching the dev server from another device on the
    // tailnet (e.g. opening the mobile view from a phone). IP addresses
    // bypass this check, so 100.x and 192.x access already works without
    // listing them.
    allowedHosts: [
      'localhost',
      'my-laptop',
      '.local',
      '.ts.net',
    ],
    proxy: {
      // Backend listens on 3001 locally to avoid clashing with other dev servers
      // on the more common 3000 (mirrors why Postgres is on 5434, not 5432).
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/mcp': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
