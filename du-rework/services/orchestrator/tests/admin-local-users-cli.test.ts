import type { AdminLocalUserRepository } from '../src/modules/auth/admin-local/repository';
import { isLocalPasswordHash } from '../src/modules/auth/admin-local/password';
import {
  adminLocalUserCommandMessage,
  executeAdminLocalUserCommand,
} from '../src/migrations-local-users-cli';

const TENANT_A = 'c1aec1ae-1111-4111-8111-c1aec1aec1ae';
const TENANT_B = 'd2bed2be-2222-4222-8222-d2bed2be2222';
const USER_ID = 'e3cfc3cf-3333-4333-8333-e3cfc3cfe3cf';
const SAFE_USER = {
  id: USER_ID,
  tenantId: TENANT_A,
  username: 'admin.one',
  role: 'admin',
  enabled: true,
  locked: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
};

function makeRepository(overrides: Partial<AdminLocalUserRepository> = {}): AdminLocalUserRepository {
  return {
    createAdmin: jest.fn(async () => SAFE_USER),
    findById: jest.fn(async () => SAFE_USER),
    setStatus: jest.fn(async () => SAFE_USER),
    disableAdmin: jest.fn(async () => SAFE_USER),
    resetPassword: jest.fn(async () => SAFE_USER),
    rotateCredentials: jest.fn(async () => SAFE_USER),
    ...overrides,
  } as unknown as AdminLocalUserRepository;
}

describe('admin local user CLI commands', () => {
  it('uses generic success/failure output with no identity or secret details', () => {
    expect(adminLocalUserCommandMessage(true)).toBe('admin local user command succeeded\n');
    expect(adminLocalUserCommandMessage(false)).toBe('admin local user command failed\n');
    expect(adminLocalUserCommandMessage(false)).not.toContain('admin.one');
    expect(adminLocalUserCommandMessage(false)).not.toContain('not-a-secret');
  });

  it('routes create, reset, and rotation secrets from the stdin reader as hashes only', async () => {
    const repository = makeRepository();
    const readPassword = jest.fn(async () => 'never-print-this-secret');
    const created = await executeAdminLocalUserCommand(
      ['create-admin', '--tenant-id', TENANT_A, '--username', 'admin.one'],
      repository,
      readPassword
    );
    const reset = await executeAdminLocalUserCommand(
      ['reset-password', '--tenant-id', TENANT_A, '--user-id', USER_ID],
      repository,
      readPassword
    );
    const rotated = await executeAdminLocalUserCommand(
      ['rotate-credentials', '--tenant-id', TENANT_A, '--user-id', USER_ID],
      repository,
      readPassword
    );

    expect([created, reset, rotated]).toEqual([true, true, true]);
    expect(readPassword).toHaveBeenCalledTimes(3);
    const createInput = (repository.createAdmin as jest.Mock).mock.calls[0]?.[0];
    const resetInput = (repository.resetPassword as jest.Mock).mock.calls[0]?.[0];
    const rotateInput = (repository.rotateCredentials as jest.Mock).mock.calls[0]?.[0];
    for (const input of [createInput, resetInput, rotateInput]) {
      expect(input.passwordHash).not.toBe('never-print-this-secret');
      expect(isLocalPasswordHash(input.passwordHash)).toBe(true);
    }
    expect(JSON.stringify([createInput, resetInput, rotateInput])).not.toContain('never-print-this-secret');
  });

  it('disables without reading a password', async () => {
    const repository = makeRepository();
    const readPassword = jest.fn(async () => 'unused');
    await expect(
      executeAdminLocalUserCommand(
        ['disable-admin', '--tenant-id', TENANT_A, '--user-id', USER_ID],
        repository,
        readPassword
      )
    ).resolves.toBe(true);
    expect(repository.disableAdmin).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      userId: USER_ID,
      actor: 'admin-local-user-cli',
    });
    expect(readPassword).not.toHaveBeenCalled();
  });

  it.each([
    ['disable-admin', 'unknown tenant', TENANT_B, USER_ID],
    ['disable-admin', 'unknown user', TENANT_A, 'f4d0f4d0-4444-4444-8444-f4d0f4d0f4d0'],
    ['reset-password', 'unknown tenant', TENANT_B, USER_ID],
    ['reset-password', 'unknown user', TENANT_A, 'f4d0f4d0-4444-4444-8444-f4d0f4d0f4d0'],
    ['rotate-credentials', 'unknown tenant', TENANT_B, USER_ID],
    ['rotate-credentials', 'unknown user', TENANT_A, 'f4d0f4d0-4444-4444-8444-f4d0f4d0f4d0'],
  ])('%s fails generically for %s', async (command, _caseName, tenantId, userId) => {
    const repository = makeRepository({
      disableAdmin: jest.fn(async () => null),
      resetPassword: jest.fn(async () => null),
      rotateCredentials: jest.fn(async () => null),
    });
    const result = await executeAdminLocalUserCommand(
      [command, '--tenant-id', tenantId, '--user-id', userId],
      repository,
      async () => 'secret-for-error-path'
    );
    expect(result).toBe(false);
    expect(adminLocalUserCommandMessage(result)).toBe('admin local user command failed\n');
    expect(adminLocalUserCommandMessage(result)).not.toContain(tenantId);
    expect(adminLocalUserCommandMessage(result)).not.toContain(userId);
  });

  it('create-admin hides an unknown-tenant insert failure behind the generic response', async () => {
    const repository = makeRepository({
      createAdmin: jest.fn(async () => { throw new Error('tenant/username details must stay private'); }),
    });
    const result = await executeAdminLocalUserCommand(
      ['create-admin', '--tenant-id', TENANT_B, '--username', 'private-user-name'],
      repository,
      async () => 'secret-for-error-path'
    );
    expect(result).toBe(false);
    expect(adminLocalUserCommandMessage(result)).toBe('admin local user command failed\n');
    expect(adminLocalUserCommandMessage(result)).not.toContain(TENANT_B);
    expect(adminLocalUserCommandMessage(result)).not.toContain('private-user-name');
  });
});
