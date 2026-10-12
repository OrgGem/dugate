import { createHostMaintenanceRunner } from '../src/modules/maintenance/host-maintenance-runner';
import { registerActiveMaintenanceCommand } from '../src/modules/maintenance/active-command-shutdown';

describe('host maintenance shutdown of owned child work', () => {
  it('signals owned child work and waits for its UNKNOWN-capable runner path to close', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const jobs = new Promise<[]>((resolve) => { release = () => resolve([]); });
    const stopChild = jest.fn(() => release());
    const runner = createHostMaintenanceRunner({
      runtimeIdentity: 'maintenance-host-test',
      maintenance: {
        runQueuedMaintenanceJobs: async () => {
          const unregister = registerActiveMaintenanceCommand(stopChild);
          entered();
          try { return await jobs; } finally { unregister(); }
        },
      },
    });

    const cycle = runner.runOnce();
    await started;
    await runner.stop();
    await expect(cycle).resolves.toEqual({ maintenanceJobs: [], rolloutJobs: [] });
    expect(stopChild).toHaveBeenCalledTimes(1);
    expect(runner.status()).toEqual({ running: false, stopping: true });
  });
});
