import {
  DEPENDENCY_BUILD_ORDER,
  validateDependencyGraphOrder,
  executeDependencyOrderedBuild,
} from '../scripts/build-dependencies';

describe('Dependency-Ordered Build Pipeline (Wave 17, W17-A Build Graph Closure)', () => {
  test('declares all workspace dependencies in strict topological build order including observability and egress', () => {
    const expectedOrder = [
      '@du/contracts',
      '@du/observability',
      '@du/egress',
      '@du/document-kit',
      '@du/worker-sdk',
      '@du/connector-client',
      '@du/connector',
      '@du/orchestrator',
      '@du/document-core',
    ];

    const actualOrder = DEPENDENCY_BUILD_ORDER.map(
      (s: { name: string }) => s.name
    );
    expect(actualOrder).toEqual(expectedOrder);
  });

  test('validates build graph closure and topological ordering against real workspace package.json manifests on disk', () => {
    const result = validateDependencyGraphOrder();
    expect(result.valid).toBe(true);
    expect(result.packages).toEqual([
      '@du/contracts',
      '@du/observability',
      '@du/egress',
      '@du/document-kit',
      '@du/worker-sdk',
      '@du/connector-client',
      '@du/connector',
      '@du/orchestrator',
      '@du/document-core',
    ]);
  });

  test('detects build closure violation if a workspace dependency is omitted from the sequence', () => {
    // Incomplete build order omitting @du/observability (the exact W16 bug)
    const incompleteOrder = DEPENDENCY_BUILD_ORDER.filter(
      (s: { name: string }) => s.name !== '@du/observability'
    );

    expect(() => validateDependencyGraphOrder(incompleteOrder)).toThrow(
      /Build closure violation: package "@du\/worker-sdk" depends on workspace package "@du\/observability", but "@du\/observability" is omitted/
    );
  });

  test('detects topological ordering violation if a dependency is positioned after its consumer', () => {
    // Inverted order placing @du/observability after @du/worker-sdk.
    // @du/egress must stay in the fixture BEFORE worker-sdk: the closure check
    // runs first and a worker-sdk that cannot see its @du/egress dependency
    // would fail on closure instead of on the ordering under test.
    const invertedOrder = [
      { name: '@du/contracts', dir: 'orchestrator/packages/contracts', cmd: 'pnpm --filter @du/contracts build' },
      { name: '@du/egress', dir: 'orchestrator/packages/egress', cmd: 'pnpm --filter @du/egress build' },
      { name: '@du/worker-sdk', dir: 'orchestrator/packages/worker-sdk', cmd: 'pnpm --filter @du/worker-sdk build' },
      { name: '@du/observability', dir: 'orchestrator/packages/observability', cmd: 'pnpm --filter @du/observability build' },
      { name: '@du/document-core', dir: 'businesses/document-core', cmd: 'pnpm --filter @du/document-core build' },
    ];

    expect(() => validateDependencyGraphOrder(invertedOrder)).toThrow(
      /Topological order violation: package "@du\/worker-sdk" \(index 2\) depends on "@du\/observability" \(index 3\), which must be built earlier/
    );
  });

  test('aborts build immediately during pre-execution graph validation when graph is invalid', () => {
    const mockRunner = jest.fn();
    // Simulate running with invalid order through runner with throwOnError: false
    // We pass a step that doesn't exist
    const brokenOrder = [
      { name: '@du/nonexistent', dir: 'orchestrator/packages/nonexistent', cmd: 'pnpm build' },
    ];

    expect(() =>
      validateDependencyGraphOrder(brokenOrder)
    ).toThrow(/Package manifest missing for @du\/nonexistent/);
    expect(mockRunner).not.toHaveBeenCalled();
  });

  test('executes all steps in exact order when each build succeeds', () => {
    const executedCmds: string[] = [];
    const mockRunner = jest.fn((cmd: string) => {
      executedCmds.push(cmd);
    });

    const result = executeDependencyOrderedBuild({
      runner: mockRunner,
      logger: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.executed).toHaveLength(DEPENDENCY_BUILD_ORDER.length);
    expect(mockRunner).toHaveBeenCalledTimes(DEPENDENCY_BUILD_ORDER.length);

    for (let i = 0; i < DEPENDENCY_BUILD_ORDER.length; i++) {
      expect(executedCmds[i]).toBe(DEPENDENCY_BUILD_ORDER[i]!.cmd);
    }
  });

  test('aborts execution immediately and throws when an upstream step fails', () => {
    const executedCmds: string[] = [];
    const mockRunner = jest.fn((cmd: string) => {
      executedCmds.push(cmd);
      // Simulate build failure at @du/worker-sdk
      if (cmd.includes('@du/worker-sdk')) {
        throw new Error('Type error in task-context.ts: property not found');
      }
    });

    expect(() =>
      executeDependencyOrderedBuild({
        runner: mockRunner,
        logger: () => {},
        throwOnError: true,
      })
    ).toThrow(
      /Build step FAILED for @du\/worker-sdk.*Aborting dependency build pipeline immediately/
    );

    // Crucial W16/W17 invariant: downstream packages MUST NOT be executed if an upstream step fails!
    expect(mockRunner).toHaveBeenCalledTimes(5); // contracts, observability, egress, document-kit, worker-sdk (failed)
    expect(executedCmds).not.toContain('pnpm --filter @du/connector build');
    expect(executedCmds).not.toContain('pnpm --filter @du/orchestrator build');
    expect(executedCmds).not.toContain('pnpm --filter @du/document-core build');
  });

  test('returns failure status and executed list when throwOnError is false', () => {
    const mockRunner = jest.fn((_cmd: string, _cwd?: string, step?: { name: string }) => {
      if (step?.name === '@du/connector') {
        throw new Error('Database migration compilation failed');
      }
    });

    const result = executeDependencyOrderedBuild({
      runner: mockRunner,
      logger: () => {},
      throwOnError: false,
    });

    expect(result.success).toBe(false);
    expect(result.failedAt).toBe('@du/connector');
    expect(result.executed).toEqual([
      '@du/contracts',
      '@du/observability',
      '@du/egress',
      '@du/document-kit',
      '@du/worker-sdk',
      '@du/connector-client',
    ]);
  });
});
