export interface MockVaultFixtureSecret {
  path: string;
  data: Record<string, unknown>;
  versions: number;
}

export interface MockVaultFixture {
  leaseDurationMs: number;
  renewable: boolean;
  kv: { mount: string; allowedPrefix: string; secrets: MockVaultFixtureSecret[] };
  transit: {
    mount: string;
    keys: { name: string; versions: number }[];
    allowedKeyRefs: Record<string, string>;
    metadataKeyRef: string;
    publicUploadKeyRef: string;
  };
  tokens: { kv: string; encrypt: string; decrypt: string };
}

export class MockVaultFixtureError extends Error {}

export function loadFixture(fixturePath: string): MockVaultFixture;
