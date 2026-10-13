import path from 'node:path';
import { runMaintenanceHostRunner } from '../src/maintenance-host-runner';
import { registerActiveMaintenanceCommand } from '../src/modules/maintenance/active-command-shutdown';

const environment = {
  DU_MAINTENANCE_EXECUTION_ROLE: 'host',
  DU_MAINTENANCE_HOST_IDENTITY: 'maintenance-host-a',
  DU_MAINTENANCE_BACKUP_MANIFEST_PATH: path.resolve('maintenance-backup.json'),
  DU_MAINTENANCE_BACKUP_MANIFEST_SHA256: 'a'.repeat(64),
};

function context(runtimeIdentity = 'maintenance-host-a') {
  return {
    maintenance: {
      runQueuedMaintenanceJobs: jest.fn(async () => []),
      runQueuedRollouts: jest.fn(async () => []),
    },
    runtimeIdentity,
    bootId: '77777777-7777-4777-8777-777777777777',
    close: jest.fn(async () => undefined),
  };
}

describe('dedicated maintenance host runner entrypoint', () => {
  it('rejects web role and caller-selected commands before loading host services', async () => {
    const createContext = jest.fn(async () => context());
    await expect(runMaintenanceHostRunner({ env: { ...environment, DU_MAINTENANCE_EXECUTION_ROLE: 'web' },
      argv: ['--once'], createContext })).rejects.toThrow('MAINTENANCE_HOST_CONFIGURATION_INVALID');
    await expect(runMaintenanceHostRunner({ env: environment, argv: ['--manifest', '/tmp/other.json'], createContext }))
      .rejects.toThrow('MAINTENANCE_HOST_ARGUMENTS_INVALID');
    expect(createContext).not.toHaveBeenCalled();
  });

  it('runs one existing durable claim cycle under the pinned identity and closes composition', async () => {
    const owned = context();
    const createContext = jest.fn(async () => owned);
    await runMaintenanceHostRunner({ env: environment, argv: ['--once'], createContext });
    expect(owned.maintenance.runQueuedMaintenanceJobs).toHaveBeenCalledWith('maintenance-host-a', 1);
    expect(owned.maintenance.runQueuedRollouts).toHaveBeenCalledWith('maintenance-host-a', 1);
    expect(owned.close).toHaveBeenCalledTimes(1);
  });

  it('closes composition and rejects a mismatched root-pinned identity', async () => {
    const owned = context('different-host');
    await expect(runMaintenanceHostRunner({ env: environment, argv: ['--once'], createContext: async () => owned }))
      .rejects.toThrow('MAINTENANCE_HOST_IDENTITY_MISMATCH');
    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(owned.maintenance.runQueuedMaintenanceJobs).not.toHaveBeenCalled();
  });

  it('does not close live pools after bounded shutdown leaves an active durable claim', async () => {
    let finishClaim!: () => void;
    let entered!: () => void;
    const claimEntered = new Promise<void>((resolve) => { entered = resolve; });
    const activeClaim = new Promise<[]>((resolve) => { finishClaim = () => resolve([]); });
    const owned = context();
    owned.maintenance.runQueuedMaintenanceJobs = jest.fn(async () => {
      entered();
      return activeClaim;
    });
    const onShutdownTimeout = jest.fn();
    const run = runMaintenanceHostRunner({ env: environment, argv: [], createContext: async () => owned,
      waitForShutdown: async () => undefined, shutdownGraceMs: 1_000, onShutdownTimeout });

    await claimEntered;
    await expect(run).rejects.toThrow('MAINTENANCE_HOST_SHUTDOWN_OUTCOME_UNKNOWN');
    expect(onShutdownTimeout).toHaveBeenCalledTimes(1);
    expect(owned.close).not.toHaveBeenCalled();
    finishClaim();
  });

  it('stops an owned command on SIGTERM in one-shot mode and waits for durable completion', async () => {
    const previousExitCode = process.exitCode;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const work = new Promise<[]>((resolve) => { release = () => resolve([]); });
    const stopChild = jest.fn(() => release());
    const owned = context();
    owned.maintenance.runQueuedMaintenanceJobs = jest.fn(async () => {
      const unregister = registerActiveMaintenanceCommand(stopChild);
      entered();
      try { return await work; } finally { unregister(); }
    });
    try {
      const run = runMaintenanceHostRunner({ env: environment, argv: ['--once'], createContext: async () => owned });
      await started;
      process.emit('SIGTERM');
      await expect(run).resolves.toBeUndefined();
      expect(stopChild).toHaveBeenCalledTimes(1);
      expect(owned.close).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      release();
    }
  });
});
