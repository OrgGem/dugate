/**
 * G-SEC offline gate prep (cycle 139), connector side: the read-path redaction
 * negative. A revision whose header VALUES carry provider secrets must never
 * leak them through redactConnectorRevision (the shape every GET revisions
 * response uses); credential_source passes through because 007 stores ONLY ref
 * coordinates - a vault TOKEN placed there by a buggy writer would still be
 * caught by the scan.
 * Run: pnpm --dir services/connector exec jest tests/gsec-redaction.boundary.test.ts --runInBand
 */
import { redactConnectorRevision } from '../src/config';
import { mkSentinel } from '../../../tests/harness/network-boundaries/sentinels';
import { scanForSentinels } from '../../../tests/harness/network-boundaries/sink-scan';

const APIKEY = mkSentinel('provkey', 'header');
const VAULT_TOKEN = mkSentinel('vaulttok', 'leak');
const CONN_SECRET = mkSentinel('connsec', 'ref');

function revisionFixture() {
  return {
    connectorId: 'mock-llm',
    revision: 1,
    adapter: 'openai-http',
    config: {
      baseUrl: 'https://api.example.test',
      path: '/v1',
      timeoutMs: 5000,
      headers: { 'x-api-key': APIKEY, authorization: 'Bearer ' + VAULT_TOKEN, 'x-public': 'visible-ok' },
    },
    credentialRef: 'slot-' + CONN_SECRET,
    state: 'ACTIVE',
    credentialSource: { kind: 'vault', mount: 'secret', path: 'du/prov', key: 'api-key', version: 3 },
  } as never;
}

describe('G-SEC offline - connector read-path redaction', () => {
  it('[LOCK] header VALUES never survive redaction; names and non-secret config do', () => {
    const out = redactConnectorRevision(revisionFixture());
    const json = JSON.stringify(out);
    const hits = scanForSentinels([json], [APIKEY, VAULT_TOKEN]);
    expect(hits).toEqual([]);
    // positive control: redaction must not be an empty-object accident - structure survives
    expect((out.config.headers as Record<string, string>)['x-api-key']).toBe('[REDACTED]');
    expect((out.config.headers as Record<string, string>)['authorization']).toBe('[REDACTED]');
    expect(out.config.baseUrl).toBe('https://api.example.test');
    expect(out.state).toBe('ACTIVE');
  });

  it('[LOCK] credential_source is metadata-only; a stray token in it would still be caught', () => {
    const rev = revisionFixture() as never as { credentialSource: Record<string, unknown> };
    rev.credentialSource = { kind: 'vault', mount: 'secret', path: 'du/prov', key: 'api-key', version: 3 };
    const out = redactConnectorRevision(rev as never);
    expect(JSON.stringify(out.credentialSource)).not.toContain(VAULT_TOKEN);
    // negative fixture variant: poison the source with a token -> scan must FLAG it
    // (proves the scan has teeth on this surface, not a vacuous green).
    const poisoned = { ...rev, credentialSource: { ...(rev as unknown as { credentialSource: object }).credentialSource, token: VAULT_TOKEN } };
    expect(scanForSentinels([JSON.stringify(redactConnectorRevision(poisoned as never))], [VAULT_TOKEN]).length).toBeGreaterThan(0);
  });
});
