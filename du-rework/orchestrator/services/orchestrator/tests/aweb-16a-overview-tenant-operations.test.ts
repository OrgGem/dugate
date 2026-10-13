import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const overviewScreenPath = resolve(
  __dirname,
  '../../../apps/admin-web/src/features/overview/overview-screen.tsx',
);

function loadOverviewLoader() {
  const source = readFileSync(overviewScreenPath, 'utf8');
  const sourceFile = ts.createSourceFile(overviewScreenPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.ArrowFunction | undefined;
  let refreshDependsOnTenant = false;
  let effectRefreshesOnLoaderChange = false;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'load') {
      const initializer = node.initializer;
      if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'useCallback') {
        const candidate = initializer.arguments[0];
        if (candidate && ts.isArrowFunction(candidate)) callback = candidate;
        const dependencies = initializer.arguments[1];
        refreshDependsOnTenant = dependencies !== undefined && ts.isArrayLiteralExpression(dependencies) &&
          dependencies.elements.some((dependency) => ts.isIdentifier(dependency) && dependency.text === 'globalTenantId');
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') {
      const effect = node.arguments[0];
      const dependencies = node.arguments[1];
      if (effect && ts.isArrowFunction(effect) && dependencies && ts.isArrayLiteralExpression(dependencies)) {
        const loadsOnChange = dependencies.elements.length === 1 &&
          dependencies.elements.some((dependency) => ts.isIdentifier(dependency) && dependency.text === 'load');
        let invokesLoad = false;
        const inspectEffect = (effectNode: ts.Node): void => {
          if (ts.isCallExpression(effectNode) && ts.isIdentifier(effectNode.expression) && effectNode.expression.text === 'load') {
            invokesLoad = true;
          }
          ts.forEachChild(effectNode, inspectEffect);
        };
        inspectEffect(effect.body);
        if (loadsOnChange && invokesLoad) effectRefreshesOnLoaderChange = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!callback) throw new Error('Could not locate the Overview load callback in overview-screen.tsx');
  const injectedLoader = `
    const {
      createAdminApiClient, lastSuccess, globalTenantId, window,
      activeLoadRef, pendingLoadRef, requestSequence, selectedTenantRef, sessionScopeRef,
      setUsage, setSession, setAudit, setOperations, setHasOperationsApi,
      setOperationsLoading, setOperationsFailed,
      setBusinesses, setHealth, setHealthFailed, setOperationMetrics, setOperationMetricsFailed,
      setWorkerInstances, setWorkerInventoryFailed, setStale, setLastSuccessAt,
      parseUsageRollup, parseAuditPage, canReadPlatformSignals,
    } = dependencies;
    const load = ${callback.getText(sourceFile)};
  `;
  const javascript = ts.transpileModule(injectedLoader, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const factory = new Function('dependencies', `${javascript}\nreturn load;`) as (
    input: Record<string, unknown>,
  ) => () => Promise<void>;
  return { create: factory, refreshDependsOnTenant, effectRefreshesOnLoaderChange, source };
}

function createDependencies(tenantId: string | null, operationsQueries: Record<string, string>[]) {
  return {
    globalTenantId: tenantId,
    window: { from: '2026-10-09T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' },
    lastSuccess: { current: null as number | null },
    activeLoadRef: { current: false },
    pendingLoadRef: { current: null as (() => Promise<void>) | null },
    requestSequence: { current: 0 },
    selectedTenantRef: { current: tenantId },
    sessionScopeRef: { current: null as string | null },
    createAdminApiClient: () => ({
      getSession: async () => ({ ok: true, status: 200, data: {
        role: 'admin',
        principal: { kind: 'platform', tenantId: null as string | null },
        scope: { kind: 'platform' },
      } }),
      getUsage: async () => ({ ok: true, status: 200, data: {} }),
      listAudit: async () => ({ ok: true, status: 200, data: {} }),
      listOperations: async (query?: Record<string, string>) => {
        operationsQueries.push(query ?? {});
        return { ok: true, status: 200, data: { items: [] } };
      },
      listBusinesses: async () => ({ ok: true, status: 200, data: { items: [] } }),
      getHealth: async () => ({ ok: true, status: 200, data: {} }),
    }),
    setUsage: () => undefined,
    setSession: () => undefined,
    setAudit: () => undefined,
    setOperations: () => undefined,
    setOperationsLoading: () => undefined,
    setOperationsFailed: () => undefined,
    setHasOperationsApi: () => undefined,
    setBusinesses: () => undefined,
    setHealth: () => undefined,
    setHealthFailed: () => undefined,
    setOperationMetrics: () => undefined,
    setOperationMetricsFailed: () => undefined,
    setWorkerInstances: () => undefined,
    setWorkerInventoryFailed: () => undefined,
    setStale: () => undefined,
    setLastSuccessAt: () => undefined,
    parseUsageRollup: (value: unknown) => value,
    parseAuditPage: (value: unknown) => value,
    // Platform health/worker projections are outside this tenant-list scope test.
    canReadPlatformSignals: () => false,
  };
}

describe('AWEB-16a Overview operations tenant scope (offline)', () => {
  test('sends each selected tenant and recreates the loader when selection changes', async () => {
    const loader = loadOverviewLoader();
    const queries: Record<string, string>[] = [];

    await loader.create(createDependencies('tenant-a', queries))();
    await loader.create(createDependencies('tenant-b', queries))();

    expect(queries).toEqual([
      { limit: '100', sort: 'created_at:desc', tenant: 'tenant-a' },
      { limit: '100', sort: 'created_at:desc', tenant: 'tenant-b' },
    ]);
    expect(loader.refreshDependsOnTenant).toBe(true);
    expect(loader.effectRefreshesOnLoaderChange).toBe(true);
  });

  test('keeps the server scoped tenant for tenant sessions', async () => {
    const loader = loadOverviewLoader();
    const queries: Record<string, string>[] = [];
    const dependencies = createDependencies('platform-selection', queries);
    const createClient = dependencies.createAdminApiClient;
    dependencies.createAdminApiClient = () => ({
      ...createClient(),
      getSession: async () => ({ ok: true, status: 200, data: {
        role: 'tenant_operator',
        principal: { kind: 'tenant_operator', tenantId: 'tenant-owned' },
        scope: { kind: 'tenant', tenantId: 'tenant-owned' },
      } }),
    });

    await loader.create(dependencies)();

    expect(queries).toEqual([{ limit: '100', sort: 'created_at:desc', tenant: 'tenant-owned' }]);
  });

  test('does not repeat the global tenant selection in the Overview header', () => {
    const { source } = loadOverviewLoader();

    expect(source).not.toContain('activeTenantName=');
    expect(source).toContain('<SessionCard loadable={session} />');
  });
});
