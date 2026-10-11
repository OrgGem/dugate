export const DEFAULT_PORT: number;

export interface MockVaultCounters {
  tokenCreates: number;
  renews: number;
  revokes: number;
  expiredLeases: number;
  reads: number;
  writes: number;
  denied: number;
}

export interface MockVaultService {
  url: string;
  port: number;
  tokens: { kv: string; encrypt: string; decrypt: string };
  kvMount: string;
  transitMount: string;
  allowedKeyRefs: Record<string, string>;
  metadataKeyRef: string;
  publicUploadKeyRef: string;
  now(): number;
  advance(ms: number): void;
  counters(): MockVaultCounters;
  requests(): { route: string; status: number; path: string }[];
  versionsOf(secretPath: string): number[];
  readValue(secretPath: string, key: string): { value: unknown; version: number } | undefined;
  stop(): Promise<void>;
}

export class WireError extends Error {
  status: number;
  errors: string[];
}

export function startMockVaultService(options?: { fixturePath: string; port?: number }): Promise<MockVaultService>;
