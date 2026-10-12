import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const appRoot = '/workspace/dugate/du-rework/orchestrator/apps/admin-web';
const require = createRequire(`${appRoot}/package.json`);
const importLocal = (name) => import(pathToFileURL(require.resolve(name)).href);
const vite = await importLocal('vite');
const { default: react } = await importLocal('@vitejs/plugin-react');
const { default: tailwindcss } = await importLocal('@tailwindcss/vite');

export default vite.defineConfig({
  root: appRoot,
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': `${appRoot}/src`,
      // The shared package dist is a stale ORV14 snapshot and the public
      // contracts barrel also re-exports server-only Node crypto helpers.
      // This private entry points the browser build at the exact runtime leaf
      // schemas consumed by the current Admin source.
      '@du/contracts': '/workspace/dugate/du-rework/tests/workflow-api/orv14-vfy/private-admin-contracts-entry.ts',
    },
  },
  build: {
    outDir: process.env.ORV14_ADMIN_PRIVATE_DIST ?? '/workspace/scratch/orv14-primary-ui-20261012T0243Z/admin-dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
