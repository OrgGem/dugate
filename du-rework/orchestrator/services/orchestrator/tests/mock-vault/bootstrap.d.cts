import type { MockVaultService } from './mock-vault-service.cjs';

export const MOCK_ENV: string;
export const FIXTURE_ENV: string;

export function readStrictBoolean(env: Record<string, string | undefined>, name: string): boolean;

export function applyMockVaultEnv(env?: Record<string, string | undefined>): Promise<MockVaultService | undefined>;

export type { MockVaultService };
