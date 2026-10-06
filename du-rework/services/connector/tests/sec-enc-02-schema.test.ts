import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SEC-ENC-02 (SD-01) — offline schema/source pin. No database: this certifies
 * that the sensitive invocation columns can only be written through the
 * sealing helpers, and that the envelope lives in the EXISTING columns
 * (no schema migration is required for the format).
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, '..', relative), 'utf8').replace(/\r\n/g, '\n');

const REPOSITORY = read('src/db/repository.ts');
const CRYPTO = read('src/db/invocation-crypto.ts');
const COMPOSITION = read('src/composition.ts');
const MIGRATION_001 = read('src/db/migrations/001_connector.sql');
const MIGRATION_009 = read('src/db/migrations/009_connector_invocation_session_ref.sql');

describe('SEC-ENC-02 schema/source pins', () => {
  test('no plaintext request/result/session JSON is passed to SQL', () => {
    expect(REPOSITORY).not.toMatch(/JSON\.stringify\(request\)/);
    expect(REPOSITORY).not.toMatch(/JSON\.stringify\(result\)/);
    expect(REPOSITORY).toMatch(/JSON\.stringify\(sealedRequest\)/);
    expect(REPOSITORY).toMatch(/JSON\.stringify\(sealedResult\)/);
    expect(REPOSITORY).toMatch(/sealedSessionRef/);
  });

  test('all three sensitive fields are sealed/opened through slot-bound contexts', () => {
    for (const slot of [
      'connector_invocations.request',
      'connector_invocations.result',
      'connector_invocations.session_ref',
    ]) {
      expect(REPOSITORY).toContain(slot);
    }
    expect(REPOSITORY).toMatch(/private async sealField/);
    expect(REPOSITORY).toMatch(/private async openField/);
    expect(REPOSITORY).toMatch(/private async openSessionRef/);
  });

  test('the envelope format is versioned and uses AES-256-GCM only', () => {
    expect(CRYPTO).toMatch(/INVOCATION_ENVELOPE_VERSION = 1 as const/);
    expect(CRYPTO).toMatch(/INVOCATION_ENVELOPE_ALGORITHM = 'aes-256-gcm' as const/);
    expect(CRYPTO).toMatch(/createCipheriv\(INVOCATION_ENVELOPE_ALGORITHM/);
    expect(CRYPTO).toMatch(/timingSafeEqual\(storedAad, expectedAad\)/);
  });

  test('the production composition injects the sealing options into the ledger', () => {
    expect(COMPOSITION).toMatch(/resolveInvocationStorageCryptoFromEnv\(process\.env\)/);
    expect(COMPOSITION).toMatch(/new PostgresInvocationLedger\(\s*database,\s*config\.invocationStorageCrypto/);
  });

  test('the format reuses existing columns: request/result jsonb + session_ref text', () => {
    expect(MIGRATION_001).toMatch(/request JSONB NOT NULL/);
    expect(MIGRATION_001).toMatch(/result JSONB/);
    expect(MIGRATION_009).toMatch(/ADD COLUMN IF NOT EXISTS session_ref TEXT/);
  });
});
