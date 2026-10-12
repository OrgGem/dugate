import {
  ComposeOperationsHostRunner,
  ComposeProjectLock,
  ComposeRunnerConfigError,
  ComposeRunnerApiError,
  loadRunnerConfigFromEnvironment,
} from './modules/compose-operations/runner';

interface CliMode {
  readonly kind: 'run' | 'once' | 'reconcile';
  readonly jobId?: string;
  readonly stateVersion?: number;
}

function parseArgs(args: readonly string[]): CliMode {
  if (args.length === 0) return { kind: 'run' };
  if (args.length === 1 && args[0] === '--once') return { kind: 'once' };
  if (args[0] === '--reconcile' && args.length === 5 && args[2] === '--state-version' && args[4] === '--confirm-quiescent') {
    const stateVersion = Number(args[3]);
    const jobId = args[1] ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !Number.isSafeInteger(stateVersion) || stateVersion < 1) {
      throw new ComposeRunnerConfigError('runner_config_invalid');
    }
    return { kind: 'reconcile', jobId, stateVersion };
  }
  throw new ComposeRunnerConfigError('runner_config_invalid');
}

export async function runComposeOperationsRunnerCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  let runner: ComposeOperationsHostRunner | null = null;
  let projectLock: ComposeProjectLock | null = null;
  let recoverMode = false;
  try {
    const mode = parseArgs(args);
    const config = await loadRunnerConfigFromEnvironment();
    runner = new ComposeOperationsHostRunner(config);
    await runner.initialize();
    const identity = runner.projectIdentity;
    if (identity.hostId !== config.hostId) throw new ComposeRunnerConfigError('runner_config_invalid');
    projectLock = new ComposeProjectLock(config.lockPath, identity.hostId, identity.projectId);

    if (mode.kind === 'reconcile') {
      recoverMode = true;
      await projectLock.recoverForLocalReconciliation();
      const job = await runner.reconcileLocally({
        jobId: mode.jobId ?? '',
        stateVersion: mode.stateVersion ?? 0,
        confirmQuiescent: true,
      });
      if (!['SUCCEEDED', 'FAILED', 'PARTIAL', 'RECONCILED'].includes(job.state)) {
        throw new ComposeRunnerConfigError('runner_journal_uncertain');
      }
      await projectLock.finalizeRecovery();
      return;
    }

    await projectLock.acquire();
    await runner.recoverAfterRestart();
    if (mode.kind === 'once') {
      await runner.runCycle();
      return;
    }

    let stopping = false;
    const stop = (): void => { stopping = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await runner.runForever({
        shouldStop: () => stopping,
        onError: (code) => process.stderr.write(`compose operations runner cycle failed (${code})\n`),
      });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    const safeCode = error instanceof ComposeRunnerConfigError
      ? error.code
      : error instanceof ComposeRunnerApiError
        ? `runner_api_${error.kind}`
        : error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message.toLowerCase()
          : 'runner_failed';
    process.stderr.write(`compose operations runner stopped (${safeCode})\n`);
    process.exitCode = 1;
  } finally {
    if (recoverMode) {
      if (process.exitCode === 1) await projectLock?.restoreRecovery().catch(() => undefined);
      else await projectLock?.finalizeRecovery().catch(() => undefined);
    }
    await runner?.close().catch(() => undefined);
    if (!recoverMode || process.exitCode !== 1) await projectLock?.release().catch(() => undefined);
  }
}

if (require.main === module) {
  void runComposeOperationsRunnerCli();
}
