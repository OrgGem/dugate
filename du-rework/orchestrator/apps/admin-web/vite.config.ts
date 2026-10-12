import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Orchestrator Portal is served by the Orchestrator Backend under `/admin/`
 * behind a per-route server flag (DU_ADMIN_WEB, default off — see
 * services/orchestrator/src/app/admin/shell-server.ts). Assets are emitted
 * with content hashes so the server can cache them immutably.
 */
export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // @du/contracts is a linked workspace package. Vite resolves its CommonJS
    // dist outside node_modules, so include only that package in conversion
    // while retaining the default dependency handling.
    commonjsOptions: {
      include: [/node_modules/, /packages\/contracts\/dist\//],
    },
  },
});
