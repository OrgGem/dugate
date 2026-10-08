import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseCurlImport } from '../../../orchestrator/apps/admin-web/src/features/connectors/curl-import';
import {
  buildConnectorUpsertParams,
  connectorActionGating,
  connectorActiveRevision,
  connectorConfigFromDraft,
  connectorIdSuggestions,
  parseConnectorCapabilities,
  parseConnectorList,
  parseConnectorRevisionRead,
  parseConnectorTestResult,
  summarizeConnectorConfig,
} from '../../../orchestrator/apps/admin-web/src/features/connectors/state';

/**
 * CONNECTOR-WIRE-B (UI lane) — the admin-web connector management wire.
 *
 * Offline, no browser and no backend: the readers/gating/mapping under test are
 * pure functions over an already-fetched body, exactly like the p745-ui-keys
 * slice. Static guards read the real screen/client sources so the wiring cannot
 * drift back to the placeholder-era disabled buttons.
 *
 * CJS-safe on purpose: the admin-web Playwright config transpiles specs to CJS,
 * so `import.meta` is unavailable (`__dirname` is).
 */

const SPEC_DIR = __dirname;
const STATE_PATH = join(SPEC_DIR, '../../../orchestrator/apps/admin-web/src/features/connectors/state.ts');
const SCREEN_PATH = join(SPEC_DIR, '../../../orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx');
const CLIENT_PATH = join(SPEC_DIR, '../../../orchestrator/apps/admin-web/src/lib/api/client.ts');

/** Single quote, kept as a character code so the fixtures stay quote-free. */
const SQ = String.fromCharCode(39);

const BEARER_SECRET = 'sk-live-2f9c41ab77de0055';
const API_KEY_SECRET = 'ak-prod-9931ee02c4';
const FORM_SECRET = 'hunter2-do-not-print';
const BASIC_SECRET = 'dXNlcjpwYXNz';
const FILE_PATH = 'C:/Users/op/private-dir/source.pdf';

const GOOD_BEARER = [
  'curl -X POST https://api.vendor.example/v1/extract\\',
  '  -H ' + SQ + 'authorization:Bearer ' + BEARER_SECRET + SQ + '\\',
  '  -H content-type:application/json\\',
  '  -F prompt=hello \\',
  '  -F api_key=' + FORM_SECRET + ' \\',
  '  -F file=@' + FILE_PATH,
].join('\n');

const GOOD_API_KEY = [
  'curl https://api.vendor.example/v1/extract\\',
  '  -H x-api-key:' + API_KEY_SECRET + '\\',
  '  --compressed\\',
  '  -F file=@' + FILE_PATH + '\\',
  '  -F model=gpt-4o',
].join('\n');

const NON_BEARER_BASIC = [
  'curl -X POST https://api.vendor.example/v1/extract\\',
  '  -H ' + SQ + 'authorization:Basic ' + BASIC_SECRET + SQ + '\\',
  '  -H content-type:application/json',
].join('\n');

/** Exact management DTO — the consumed surface of ConnectorManagementRevision. */
function managementRevision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectorId: 'vendor-extract',
    revision: 3,
    adapter: 'http-json',
    state: 'PENDING',
    config: {
      endpointUrl: 'https://api.vendor.example/v1/extract',
      headers: [{ name: 'content-type', value: 'application/json' }],
    },
    credentialRef: 'vault://du/vendor-extract',
    credentialSource: { mount: 'kv2', path: 'du/vendor-extract' },
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: 'acct-1',
    ...overrides,
  };
}

const LEGACY_PLACEHOLDER = {
  connectorId: 'vendor-extract',
  revision: 0,
  adapter: 'unknown',
  endpoint: { kind: 'configured', maskedHost: '***.example.com' },
  capabilities: [],
  state: 'disabled',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  secretSlots: [],
  testResult: null,
};

test.describe('CONNECTOR-WIRE-B — capability advertisement', () => {
  test('management:false still feeds configured connector IDs to revision lookup suggestions', () => {
    const knownConnectorIds = ['vendor-alpha', 'vendor-beta'];
    const capabilities = parseConnectorCapabilities({
      management: false,
      credentialWorkflow: false,
      test: false,
      knownConnectorIds,
    });
    expect(capabilities?.knownConnectorIds).toEqual(knownConnectorIds);
    expect(connectorIdSuggestions(capabilities, [])).toEqual(knownConnectorIds);

    const screen = readFileSync(SCREEN_PATH, 'utf8');
    expect(screen).toContain('connectorIdSuggestions(caps, listRows)');
    expect(screen).toContain('connector-id-suggestions');
  });

  test('1. all three booleans are required and unknown keys are rejected', () => {
    expect(parseConnectorCapabilities({ management: true, credentialWorkflow: false, test: true, knownConnectorIds: [] })).toEqual({
      management: true,
      credentialWorkflow: false,
      test: true,
      knownConnectorIds: [],
    });
    // `.strict()` upstream: an extra key means the advertisement is not trusted.
    expect(
      parseConnectorCapabilities({ management: true, credentialWorkflow: true, test: true, extra: 1 }),
    ).toBeNull();
    expect(parseConnectorCapabilities({ management: true, credentialWorkflow: true })).toBeNull();
    expect(parseConnectorCapabilities({ management: 'true', credentialWorkflow: true, test: true })).toBeNull();
    expect(parseConnectorCapabilities(null)).toBeNull();
    expect(parseConnectorCapabilities({ items: [] })).toBeNull();
  });

  test('2. gating is fail-closed: null capabilities disable every write', () => {
    const off = connectorActionGating(null);
    expect([off.upsert, off.activate, off.disable, off.retire, off.test, off.rotate]).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(off.reason.length).toBeGreaterThan(0);
  });

  test('3. each capability gates exactly its own controls, never more', () => {
    const managementOnly = connectorActionGating({
      management: true,
      credentialWorkflow: false,
      test: false,
      knownConnectorIds: [],
    });
    expect([managementOnly.upsert, managementOnly.activate, managementOnly.disable, managementOnly.retire]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([managementOnly.test, managementOnly.rotate]).toEqual([false, false]);

    const all = connectorActionGating({ management: true, credentialWorkflow: true, test: true, knownConnectorIds: [] });
    expect([all.upsert, all.activate, all.disable, all.retire, all.test, all.rotate]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(all.reason).toBe('');

    const testOnly = connectorActionGating({ management: false, credentialWorkflow: false, test: true, knownConnectorIds: [] });
    expect(testOnly.test).toBe(true);
    expect(testOnly.upsert).toBe(false);
  });
});

test.describe('CONNECTOR-WIRE-B — revision + list readers', () => {
  test('4. a real ledger revision parses; an unknown field fails it (strict mirror)', () => {
    const parsed = parseConnectorRevisionRead(managementRevision());
    expect(parsed?.kind).toBe('management');
    if (parsed?.kind !== 'management') return;
    expect(parsed.revision.connectorId).toBe('vendor-extract');
    expect(parsed.revision.revision).toBe(3);
    expect(parsed.revision.state).toBe('PENDING');
    expect(parsed.revision.credentialRef).toBe('vault://du/vendor-extract');

    // The platform rejects an unmodelled field (502) — so does the browser.
    expect(parseConnectorRevisionRead(managementRevision({ unexpected: true }))).toBeNull();
  });

  test('5. malformed management bodies never fall back to the degraded projection', () => {
    // `config` present but not a record: still a management body, still invalid.
    expect(parseConnectorRevisionRead(managementRevision({ config: 'nope' }))).toBeNull();
    expect(parseConnectorRevisionRead(managementRevision({ state: 'DISABLED' }))).toBeNull();
    expect(parseConnectorRevisionRead(managementRevision({ revision: 0 }))).toBeNull();
    expect(parseConnectorRevisionRead(managementRevision({ connectorId: '' }))).toBeNull();
    expect(parseConnectorRevisionRead(managementRevision({ credentialRef: 7 }))).toBeNull();
    // Both key sets at once: the strict management reader must reject it.
    expect(
      parseConnectorRevisionRead(managementRevision({ endpoint: { kind: 'configured', maskedHost: 'x' } })),
    ).toBeNull();
    expect(parseConnectorRevisionRead({ connectorId: 'x', revision: 1 })).toBeNull();
    expect(parseConnectorRevisionRead(null)).toBeNull();
  });

  test('6. the endpoint-only placeholder still reads as the degraded projection', () => {
    const parsed = parseConnectorRevisionRead(LEGACY_PLACEHOLDER);
    expect(parsed?.kind).toBe('legacy');
    if (parsed?.kind !== 'legacy') return;
    expect(parsed.revision.endpoint.maskedHost).toBe('***.example.com');
    expect(parsed.revision.state).toBe('disabled');
  });

  test('7. list read counts unreadable rows instead of dropping them silently', () => {
    const page = parseConnectorList({ items: [managementRevision(), LEGACY_PLACEHOLDER] });
    expect(page?.items).toHaveLength(1);
    expect(page?.skipped).toBe(1);

    expect(parseConnectorList({ items: [] })).toEqual({ items: [], skipped: 0 });
    expect(parseConnectorList({ items: 'nope' })).toBeNull();
    expect(parseConnectorList([])).toBeNull();
  });

  test('8. test result is narrow: ok required, errorCode optional + typed', () => {
    expect(parseConnectorTestResult({ ok: true })).toEqual({ ok: true });
    expect(parseConnectorTestResult({ connectorId: 'x', ok: false, errorCode: 'TIMEOUT' })).toEqual({
      ok: false,
      errorCode: 'TIMEOUT',
    });
    expect(parseConnectorTestResult({ ok: 'yes' })).toBeNull();
    expect(parseConnectorTestResult({ ok: false, errorCode: 5 })).toBeNull();
    expect(parseConnectorTestResult(null)).toBeNull();
  });

  test('9. the ACTIVE head is read from the list, never guessed', () => {
    const items = [
      managementRevision({ connectorId: 'a', revision: 1, state: 'RETIRED' }),
      managementRevision({ connectorId: 'a', revision: 2, state: 'ACTIVE' }),
      managementRevision({ connectorId: 'a', revision: 3, state: 'PENDING' }),
      managementRevision({ connectorId: 'b', revision: 9, state: 'ACTIVE' }),
    ].flatMap((raw) => {
      const parsed = parseConnectorRevisionRead(raw);
      return parsed !== null && parsed.kind === 'management' ? [parsed.revision] : [];
    });
    expect(connectorActiveRevision(items, 'a')).toBe(2);
    expect(connectorActiveRevision(items, 'b')).toBe(9);
    // No ACTIVE row for this connector → null (the caller disables Activate).
    expect(connectorActiveRevision(items, 'c')).toBeNull();
    expect(connectorActiveRevision([], 'a')).toBeNull();
  });

  test('10. config summary renders keys and header names only, never a value', () => {
    const summary = summarizeConnectorConfig({
      endpointUrl: 'https://api.vendor.example/v1/extract',
      headers: [
        { name: 'content-type', value: 'application/json' },
        { name: 'authorization', value: 'Basic ' + BASIC_SECRET },
        { name: 'x-api-key', value: '[REDACTED]' },
      ],
    });
    expect(summary.keys).toEqual(['endpointUrl', 'headers']);
    expect(summary.headerNames).toEqual(['content-type']);
    expect(summary.redactedHeaderNames).toEqual(['authorization', 'x-api-key']);
    expect(JSON.stringify(summary)).not.toContain(BASIC_SECRET);
    expect(JSON.stringify(summary)).not.toContain('application/json');
  });
});

test.describe('CONNECTOR-WIRE-B — draft → connector.upsert mapping', () => {
  test('11. a complete draft maps to mode "create" with trimmed coordinates', () => {
    const parsed = parseCurlImport(GOOD_BEARER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const plan = buildConnectorUpsertParams(parsed.draft, {
      connectorId: '  vendor-extract  ',
      adapter: ' http-json ',
      credentialRef: ' vault://du/vendor-extract ',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.params.mode).toBe('create');
    expect(plan.params.connectorId).toBe('vendor-extract');
    expect(plan.params.adapter).toBe('http-json');
    expect(plan.params.credentialRef).toBe('vault://du/vendor-extract');
    expect(typeof plan.params.config).toBe('object');
  });

  test('12. a missing coordinate names itself instead of being invented', () => {
    const parsed = parseCurlImport(GOOD_BEARER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const complete = { connectorId: 'c', adapter: 'a', credentialRef: 'r' };

    expect(buildConnectorUpsertParams(parsed.draft, { ...complete, connectorId: '  ' })).toEqual({
      ok: false,
      missing: 'connectorId',
    });
    expect(buildConnectorUpsertParams(parsed.draft, { ...complete, adapter: '' })).toEqual({
      ok: false,
      missing: 'adapter',
    });
    expect(buildConnectorUpsertParams(parsed.draft, { ...complete, credentialRef: '' })).toEqual({
      ok: false,
      missing: 'credentialRef',
    });
  });

  test('13. the upsert payload carries NO secret value and no local file path', () => {
    for (const text of [GOOD_BEARER, GOOD_API_KEY, NON_BEARER_BASIC]) {
      const parsed = parseCurlImport(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const plan = buildConnectorUpsertParams(parsed.draft, {
        connectorId: 'vendor-extract',
        adapter: 'http-json',
        credentialRef: 'vault://du/vendor-extract',
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const serialized = JSON.stringify(plan.params);
      for (const secret of [BEARER_SECRET, API_KEY_SECRET, FORM_SECRET, BASIC_SECRET]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain('private-dir');
      expect(serialized).not.toContain(FILE_PATH);
    }
  });

  test('14. secrets are reduced to structure; safe fields survive', () => {
    const parsed = parseCurlImport(GOOD_BEARER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = connectorConfigFromDraft(parsed.draft);

    expect(config['endpointUrl']).toBe('https://api.vendor.example/v1/extract');
    expect(config['httpMethod']).toBe('POST');
    expect(config['auth']).toEqual({ type: 'BEARER', headerName: 'authorization', secretPresent: true });
    expect(config['headers']).toEqual([{ name: 'content-type', value: 'application/json' }]);
    expect(config['formFields']).toEqual([{ name: 'prompt', value: 'hello' }]);
    expect(config['secretFormFieldNames']).toEqual(['api_key']);
    expect(config['fileFormFieldNames']).toEqual(['file']);

    // A non-Bearer authorization header is kept as a NAME only.
    const basic = parseCurlImport(NON_BEARER_BASIC);
    expect(basic.ok).toBe(true);
    if (!basic.ok) return;
    const basicConfig = connectorConfigFromDraft(basic.draft);
    expect(basicConfig['redactedHeaderNames']).toEqual(['authorization']);
    expect(basicConfig['headers']).toEqual([{ name: 'content-type', value: 'application/json' }]);
    expect(JSON.stringify(basicConfig)).not.toContain(BASIC_SECRET);
  });
});

test.describe('CONNECTOR-WIRE-B — wiring guards', () => {
  test('15. the screen reads capabilities and every action through the typed client', () => {
    const src = readFileSync(SCREEN_PATH, 'utf8');
    expect(src).toContain('client.getConnectorCapabilities()');
    expect(src).toContain('connectorActionGating(caps)');
    expect(src).toContain('client.listConnectors()');
    expect(src).toContain('client.upsertConnector(');
    expect(src).toContain('client.activateConnector(');
    expect(src).toContain('client.disableConnector(');
    expect(src).toContain('client.retireConnector(');
    expect(src).toContain('client.testConnector(');
    // The connector actions never bypass the typed client helpers.
    expect(src).not.toContain("postAction('connector");
    // The draft's in-memory secret is never rendered or forwarded by the screen.
    expect(src).not.toContain('secretValue');
    // P730 contract stays intact (labels + the masked summary hand-off).
    expect(src).toContain('Import cURL');
    expect(src).toContain('Save connection');
    expect(src).toContain('Test connection');
    expect(src).toContain('summary={summarizeCurlImport(draft)} draft={draft}');
  });

  test('16. every write control is gated on a real capability, and the client forwards the wire', () => {
    const screen = readFileSync(SCREEN_PATH, 'utf8');
    for (const gate of ['test', 'activate', 'disable', 'retire']) {
      expect(screen).toContain('disabled={!gating.' + gate);
    }
    expect(screen).toContain('!gating.upsert || !planOk');

    const state = readFileSync(STATE_PATH, 'utf8');
    // Redaction is structural in the mapping, not a runtime hope.
    expect(state).toContain('redactedHeaderNames');
    expect(state).toContain('secretFormFieldNames');
    expect(state).toContain('fileFormFieldNames');

    const client = readFileSync(CLIENT_PATH, 'utf8');
    expect(client).toContain("'GET', '/connectors/capabilities'");
    expect(client).toContain("'GET', '/connectors'");
    expect(client).toContain("runAction('connector.upsert'");
    expect(client).toContain("runAction('connector.activate'");
    expect(client).toContain("runAction('connector.disable'");
    expect(client).toContain("runAction('connector.retire'");
    expect(client).toContain("runAction('connector.test'");
  });
});
