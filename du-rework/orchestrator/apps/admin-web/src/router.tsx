import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/app-shell/app-shell';
import { BootstrapHome } from '@/routes/bootstrap-home';
import { OverviewRoute } from '@/routes/overview';
import { ApiKeysRoute } from '@/routes/api-keys';
import { ConnectorsRoute } from '@/routes/connectors';
import { ProfilesRoute } from '@/routes/profiles';
import { OperationsRoute } from '@/routes/operations';
import { BusinessesRoute } from '@/routes/businesses';
import { UsageRoute } from '@/routes/usage';
import { SecurityRoute } from '@/routes/security';
import { SecretsRoute } from '@/routes/secrets';
import { IdentityRoute } from '@/routes/identity';
import { SettingsRoute } from '@/routes/settings';
import { WorkflowsRoute } from '@/routes/workflows';
import { DocsRoute } from '@/routes/docs';
import { ApiDocsRoute } from '@/routes/api-docs';
import { NotFound } from '@/routes/not-found';

/**
 * React Router Data Mode. `basename` is derived from Vite's BASE_URL so the
 * same build works behind the Orchestrator mount (`admin/`) and in the
 * Vite dev server.
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <AppShell />,
      children: [
        {
          index: true,
          loader: () => ({
            mountedAt: basename,
            mode: import.meta.env.MODE,
          }),
          Component: BootstrapHome,
        },
        { path: 'overview', Component: OverviewRoute },
        { path: 'api-keys', Component: ApiKeysRoute },
        { path: 'connectors', Component: ConnectorsRoute },
        { path: 'profiles', Component: ProfilesRoute },
        { path: 'operations', Component: OperationsRoute },
        { path: 'businesses', Component: BusinessesRoute },
        { path: 'usage', Component: UsageRoute },
        { path: 'security', Component: SecurityRoute },
        { path: 'secrets', Component: SecretsRoute },
        { path: 'identity', Component: IdentityRoute },
        { path: 'settings', Component: SettingsRoute },
        { path: 'workflows', Component: WorkflowsRoute },
        { path: 'docs', Component: DocsRoute },
        { path: 'api-docs', Component: ApiDocsRoute },
        { path: '*', Component: NotFound },
      ],
    },
  ],
  { basename },
);