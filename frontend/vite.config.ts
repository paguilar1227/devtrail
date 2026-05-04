import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
