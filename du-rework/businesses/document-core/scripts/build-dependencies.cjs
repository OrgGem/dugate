/**
 * Business-Owned Dependency-Ordered Build Pipeline (Wave 16, W16-A)
 *
 * Enforces explicit topological dependency ordering across all workspace packages
 * required by the cross-service E2E integration test suite:
 *   1. @du/contracts (foundational schemas and wire contracts)
 *   2. @du/observability (shared logging and telemetry)
 *   3. @du/egress (provider network policy and safe egress)
 *   4. @du/document-kit (document parsing & conversion utilities)
 *   5. @du/worker-sdk (worker runtime, context, and facades)
 *   6. @du/connector-client (connector HTTP client and grants)
 *   7. @du/connector (connector service and pipeline execution)
 *   8. @du/orchestrator (orchestrator HTTP runtime and lifecycle)
 *   9. @du/document-core (document-core worker and actions)
 *
 * Rules:
 * - Never runs stale downstream integration if an upstream build fails.
 * - Fails fast and propagates the exact exit error immediately.
 * - Does not depend on implicit npm/pnpm lifecycle hooks or single-file mtime comparisons.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

const DEPENDENCY_BUILD_ORDER = [
  { name: '@du/contracts', dir: 'packages/contracts', cmd: 'pnpm --filter @du/contracts build' },
  { name: '@du/observability', dir: 'packages/observability', cmd: 'pnpm --filter @du/observability build' },
  { name: '@du/egress', dir: 'packages/egress', cmd: 'pnpm --filter @du/egress build' },
  { name: '@du/document-kit', dir: 'packages/document-kit', cmd: 'pnpm --filter @du/document-kit build' },
  { name: '@du/worker-sdk', dir: 'packages/worker-sdk', cmd: 'pnpm --filter @du/worker-sdk build' },
  { name: '@du/connector-client', dir: 'packages/connector-client', cmd: 'pnpm --filter @du/connector-client build' },
  { name: '@du/connector', dir: 'services/connector', cmd: 'pnpm --filter @du/connector build' },
  { name: '@du/orchestrator', dir: 'services/orchestrator', cmd: 'pnpm --filter @du/orchestrator build' },
  { name: '@du/document-core', dir: 'businesses/document-core', cmd: 'pnpm --filter @du/document-core build' },
];

/**
 * Validates topological dependency order and build graph closure against
 * actual workspace package.json manifests on disk.
 *
 * Enforces:
 * 1. Existence and name verification of each package.json on disk.
 * 2. Closure: all workspace dependencies (@du/* or workspace:*) declared by packages in the sequence
 *    must be explicitly present in the build sequence.
 * 3. Topological ordering: any workspace dependency must appear at a strictly lower index
 *    than the package that consumes it.
 */
function validateDependencyGraphOrder(order = DEPENDENCY_BUILD_ORDER, workspaceRoot = WORKSPACE_ROOT) {
  const stepIndices = new Map();
  for (let i = 0; i < order.length; i++) {
    stepIndices.set(order[i].name, i);
  }

  const manifestMap = new Map();

  for (const step of order) {
    const pkgJsonPath = path.join(workspaceRoot, step.dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error(`Package manifest missing for ${step.name}: ${pkgJsonPath} not found`);
    }

    const raw = fs.readFileSync(pkgJsonPath, 'utf8');
    const pkg = JSON.parse(raw);

    if (pkg.name !== step.name) {
      throw new Error(`Manifest name mismatch for ${step.dir}: expected "${step.name}", got "${pkg.name}"`);
    }

    manifestMap.set(step.name, pkg);
  }

  // Verify build graph closure and topological ordering
  for (let i = 0; i < order.length; i++) {
    const step = order[i];
    const pkg = manifestMap.get(step.name);
    const deps = { ...(pkg.dependencies || {}) };

    for (const [depName, depVersion] of Object.entries(deps)) {
      const isWorkspaceDep =
        depName.startsWith('@du/') ||
        (typeof depVersion === 'string' && depVersion.startsWith('workspace:'));

      if (isWorkspaceDep) {
        // Build closure: dependency must be declared in build order
        if (!stepIndices.has(depName)) {
          throw new Error(
            `Build closure violation: package "${step.name}" depends on workspace package "${depName}", but "${depName}" is omitted from the build sequence`
          );
        }

        // Topological ordering: dependency must appear before consumer
        const depIndex = stepIndices.get(depName);
        if (depIndex >= i) {
          throw new Error(
            `Topological order violation: package "${step.name}" (index ${i}) depends on "${depName}" (index ${depIndex}), which must be built earlier`
          );
        }
      }
    }
  }

  return { valid: true, packages: order.map((s) => s.name) };
}

function executeDependencyOrderedBuild(options = {}) {
  const runner =
    options.runner ||
    ((cmd, cwd) => {
      execSync(cmd, { cwd: cwd || WORKSPACE_ROOT, stdio: 'inherit' });
    });
  const logger = options.logger || console.log;

  // Validate graph closure and order before beginning build execution
  if (options.validateGraph !== false) {
    try {
      validateDependencyGraphOrder(DEPENDENCY_BUILD_ORDER, WORKSPACE_ROOT);
      logger('[Build Pipeline] Dependency graph manifest validation passed.');
    } catch (graphErr) {
      const graphMsg = `[Build Pipeline] Dependency graph validation FAILED: ${graphErr.message}. Aborting build immediately.`;
      if (options.throwOnError !== false) {
        throw new Error(graphMsg);
      }
      return { success: false, failedAt: 'GRAPH_VALIDATION', executed: [], error: graphErr };
    }
  }

  logger('[Build Pipeline] Starting dependency-ordered workspace build sequence...');
  const executed = [];

  for (const step of DEPENDENCY_BUILD_ORDER) {
    logger(`[Build Pipeline] Step ${executed.length + 1}/${DEPENDENCY_BUILD_ORDER.length}: building ${step.name} (${step.dir})...`);
    try {
      runner(step.cmd, WORKSPACE_ROOT, step);
      executed.push(step.name);
    } catch (err) {
      const failureMsg = `[Build Pipeline] Build step FAILED for ${step.name} (${step.dir}): ${err.message}. Aborting dependency build pipeline immediately without running downstream targets.`;
      if (options.throwOnError !== false) {
        throw new Error(failureMsg);
      }
      return { success: false, failedAt: step.name, executed, error: err };
    }
  }

  logger('[Build Pipeline] All dependency build steps completed successfully.');
  return { success: true, executed };
}

if (require.main === module) {
  try {
    executeDependencyOrderedBuild();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  DEPENDENCY_BUILD_ORDER,
  validateDependencyGraphOrder,
  executeDependencyOrderedBuild,
};
