import { isAbsolute, normalize } from 'node:path';
import type { MaintenanceRunnerPort } from './modules/maintenance/job-runner';
import { createHostMaintenanceRunner } from './modules/maintenance/host-maintenance-runner';
import { stopActiveMaintenanceCommands } from './modules/maintenance/active-command-shutdown';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MaintenanceHostExecutionContext {
  maintenance: Pick<MaintenanceRunnerPort, 'runQueuedMaintenanceJobs' | 'runQueuedRollouts'>;
  /** Root-pinned executor identity used in durable maintenance claim rows. */
  runtimeIdentity: string;
  /** This process boot identity is distinct for every host-runner start. */
  bootId: string;
  close(): Promise<void>;
}

export type MaintenanceHostContextFactory = () => Promise<MaintenanceHostExecutionContext>;

export interface MaintenanceHostRunnerEnvironment {
  DU_MAINTENANCE_EXECUTION_ROLE?: string;
  DU_MAINTENANCE_HOST_IDENTITY?: string;
  DU_MAINTENANCE_BACKUP_MANIFEST_PATH?: string;
  DU_MAINTENANCE_BACKUP_MANIFEST_SHA256?: string;
}

function requiredHostEnvironment(env: MaintenanceHostRunnerEnvironment): { runtimeIdentity: string; manifestPath: string; manifestSha256: string } {
  const role = env.DU_MAINTENANCE_EXECUTION_ROLE?.trim();
  const runtimeIdentity = env.DU_MAINTENANCE_HOST_IDENTITY?.trim();
  const manifestPath = env.DU_MAINTENANCE_BACKUP_MANIFEST_PATH?.trim();
  const manifestSha256 = env.DU_MAINTENANCE_BACKUP_MANIFEST_SHA256?.trim();
  if (role !== 'host' || !runtimeIdentity || !SAFE_ID.test(runtimeIdentity)
    || !manifestPath || !isAbsolute(manifestPath) || normalize(manifestPath) !== manifestPath
    || !manifestSha256 || !SHA256.test(manifestSha256)) {
    throw new Error('MAINTENANCE_HOST_CONFIGURATION_INVALID');
  }
  return { runtimeIdentity, manifestPath, manifestSha256 };
}

/** Runs the durable maintenance queue in the dedicated host role. The factory
 * is an injected, trusted composition boundary; the command line cannot pick
 * an adapter, path, executable, target, or operation. */
export async function runMaintenanceHostRunner(input: {
  env: MaintenanceHostRunnerEnvironment;
  argv: readonly string[];
  createContext: MaintenanceHostContextFactory;
  waitForShutdown?: () => Promise<void>;
  shutdownGraceMs?: number;
  onShutdownTimeout?: () => void;
  onError?: (code: string) => void;
}): Promise<void> {
  const pinned = requiredHostEnvironment(input.env);
  if (input.argv.some((arg) => arg !== '--once') || input.argv.filter((arg) => arg === '--once').length > 1) {
    throw new Error('MAINTENANCE_HOST_ARGUMENTS_INVALID');
  }
  const once = input.argv.includes('--once');
  const context = await input.createContext();
  let closed = false;
  let mayCloseContext = true;
  const close = async () => {
    if (closed) return;
    closed = true;
    await context.close();
  };
  try {
    if (context.runtimeIdentity !== pinned.runtimeIdentity || !SAFE_ID.test(context.runtimeIdentity) || !UUID.test(context.bootId)) {
      throw new Error('MAINTENANCE_HOST_IDENTITY_MISMATCH');
    }
    const runner = createHostMaintenanceRunner({
      maintenance: context.maintenance,
      runtimeIdentity: context.runtimeIdentity,
      onError: input.onError,
    });
    const shutdownGraceMs = Math.max(1_000, Math.min(60_000, Math.trunc(input.shutdownGraceMs ?? 30_000)));
    const stopWithinBound = async () => {
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([
        runner.stop().then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), shutdownGraceMs); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!stopped) {
        // Do not close pools while a claimed item can still be executing. The
        // production entrypoint exits the host process; its owner lease then
        // ages into UNKNOWN and cannot be replayed.
        mayCloseContext = false;
        input.onShutdownTimeout?.();
        throw new Error('MAINTENANCE_HOST_SHUTDOWN_OUTCOME_UNKNOWN');
      }
    };
    if (once) {
      let signalled = false;
      let resolveSignal!: () => void;
      const signal = new Promise<void>((resolve) => { resolveSignal = resolve; });
      const onSignal = () => {
        signalled = true;
        stopActiveMaintenanceCommands();
        resolveSignal();
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        const work = runner.runOnce();
        const outcome = await Promise.race([work.then(() => 'complete' as const), signal.then(() => 'signal' as const)]);
        if (outcome === 'signal') {
          await stopWithinBound();
          process.exitCode = 1;
        } else {
          await work;
          await stopWithinBound();
        }
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
      return;
    }
    runner.start();
    try {
      await (input.waitForShutdown ?? waitForShutdown)();
    } finally {
      await stopWithinBound();
    }
  } finally {
    if (mayCloseContext) await close();
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('uncaughtException', onFatal);
      process.off('unhandledRejection', onFatal);
    };
    const onSignal = () => { cleanup(); resolve(); };
    const onFatal = () => { cleanup(); reject(new Error('MAINTENANCE_HOST_FATAL')); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('uncaughtException', onFatal);
    process.once('unhandledRejection', onFatal);
  });
}

async function loadProductionContextFactory(): Promise<MaintenanceHostContextFactory> {
  // The bootstrap exports this host-only constructor without creating or
  // listening on an HTTP server. Importing it does not run the web entrypoint.
  const bootstrap = await import('./maintenance-host-execution-context') as unknown as {
    createMaintenanceHostExecutionContext?: MaintenanceHostContextFactory;
  };
  if (typeof bootstrap.createMaintenanceHostExecutionContext !== 'function') {
    throw new Error('MAINTENANCE_HOST_COMPOSITION_UNAVAILABLE');
  }
  return bootstrap.createMaintenanceHostExecutionContext;
}

async function main(): Promise<void> {
  try {
    const createContext = await loadProductionContextFactory();
    await runMaintenanceHostRunner({
      env: process.env,
      argv: process.argv.slice(2),
      createContext,
      onShutdownTimeout: () => {
        process.stderr.write('MAINTENANCE_HOST_SHUTDOWN_OUTCOME_UNKNOWN\n');
        process.exit(1);
      },
      onError: (code) => { process.stderr.write(`${code}\n`); },
    });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'MAINTENANCE_HOST_RUNNER_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
