import { createMaintenanceHostExecutionContext } from '../src/maintenance-host-execution-context';

describe('dedicated maintenance host composition boundary', () => {
  const names = [
    'DU_MAINTENANCE_EXECUTION_ROLE',
    'DU_MAINTENANCE_HOST_IDENTITY',
    'DU_MAINTENANCE_BACKUP_MANIFEST_PATH',
    'DU_MAINTENANCE_BACKUP_MANIFEST_SHA256',
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('refuses web mode before reading host pins or opening resources', async () => {
    process.env.DU_MAINTENANCE_EXECUTION_ROLE = 'web';
    delete process.env.DU_MAINTENANCE_HOST_IDENTITY;
    delete process.env.DU_MAINTENANCE_BACKUP_MANIFEST_PATH;
    delete process.env.DU_MAINTENANCE_BACKUP_MANIFEST_SHA256;

    await expect(createMaintenanceHostExecutionContext()).rejects.toThrow('MAINTENANCE_HOST_ROLE_REQUIRED');
  });

  it('requires the pinned host identity before constructing database or storage clients', async () => {
    process.env.DU_MAINTENANCE_EXECUTION_ROLE = 'host';
    delete process.env.DU_MAINTENANCE_HOST_IDENTITY;

    await expect(createMaintenanceHostExecutionContext()).rejects.toThrow('DU_MAINTENANCE_HOST_IDENTITY_REQUIRED');
  });
});
