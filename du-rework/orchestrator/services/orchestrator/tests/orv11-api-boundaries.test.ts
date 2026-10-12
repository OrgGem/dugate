import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Ajv from 'ajv';
import { canonicalRequestHash } from '@du/contracts';
import { legacyCompatHost } from '../src/compat/legacy-host-adapter';
import { decodeLegacyWire } from '../src/compat/legacy-wire-decoders';
import { maybeScheduleWebhook, type DbClient } from '../src/modules/webhooks/webhooks';
import type { RouteContext } from '../src/server';
import { assertNoLegacyArtifactCount, withLegacyArtifactCount, type SubmitContext, type LegacyWorkflowPreflightContext } from '../src/modules/operations/submission';
import { documentCoreManifest } from '../../../../businesses/document-core/src/manifest/document-core.manifest';
import { documentCoreHandlers } from '../../../../businesses/document-core/src/worker';
import { MockTaskContext } from '../../../../businesses/document-core/tests/fixtures/mock-context';

jest.mock('../src/compat/legacy-url-input', () => ({ acquireLegacyUrl: async (entry: Record<string, unknown>) => { const bytes = Buffer.from(String(entry.url)); return { name: 'url.txt', type: 'text/plain', size: bytes.length, bytes }; } }));

const principal = { tenantId: randomUUID(), apiKeyId: randomUUID() };
function harness() {
  const worker = new MockTaskContext({ tenantId: principal.tenantId });
  const operations = new Map<string, Record<string, unknown>>();
  const identities = new Map<string, { hash: string; id: string }>();
  let uploads = 0;
  let preflights = 0;
  const context = {
    db: { query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM operations')) {
        expect(sql).toContain('api_key_id = $3');
        const row = operations.get(String(params[0]));
        const rows = row && params[1] === row.tenant_id && params[2] === row.api_key_id ? [row] : [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('FROM artifacts')) {
        expect(sql).toContain('tenant_id=$2 AND operation_id=$3');
        const exists = params[1] === principal.tenantId && operations.has(String(params[2])) && worker.artifactsStore.has(String(params[0]));
        return { rowCount: exists ? 1 : 0, rows: exists ? [{ storage_key: params[0] }] : [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    } },
    artifacts: {
      assertPublicArtifactEncryptionReady: jest.fn(),
      cleanupUnlinkedPublicArtifacts: jest.fn(async () => ({ deleted: 0, deferred: 0 })),
      putPublicArtifact: async (file: { bytes: Buffer; fileName: string; mimeType: string; requireEncryption: boolean }) => {
        expect(file.requireEncryption).toBe(true);
        uploads++;
        return worker.artifacts.write(file.bytes, file.fileName, file.mimeType);
      },
      getBlob: async (key: string) => Readable.from([worker.artifactsStore.get(key)!]),
    },
    submission: {
      replayLegacy: async (scope: { idempotencyKey?: string }, identity: Parameters<typeof canonicalRequestHash>[0]) => {
        const prior = identities.get(scope.idempotencyKey ?? '');
        if (!prior) return null;
        if (prior.hash !== canonicalRequestHash(identity)) throw Object.assign(new Error('conflict'), { status: 409 });
        return { operation: { id: prior.id }, replayed: true };
      },
      preflightLegacyWorkflow: async (input: LegacyWorkflowPreflightContext) => {
        preflights++;
        assertNoLegacyArtifactCount(input.input);
        const manifest = documentCoreManifest.actions.find((action) => action.name === input.action)!;
        const valid = new Ajv({ strict: false }).compile(manifest.inputSchema);
        if (!valid(input.input)) throw new Error(JSON.stringify(valid.errors));
        return { mode: 'legacy' };
      },
      submit: async (ctx: SubmitContext) => {
        const submission = ctx.submission as { input: Record<string, unknown>; output: { format: string } };
        const result = await documentCoreHandlers[ctx.action]!(worker, ctx.legacyEndpointSlug && ctx.action !== 'compare' ? withLegacyArtifactCount(submission.input) : submission.input);
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') throw new Error('not completed');
        const id = randomUUID();
        operations.set(id, { id, tenant_id: ctx.tenantId, api_key_id: ctx.apiKeyId, business_id: ctx.businessId, created_at: new Date('2026-10-11T00:00:00Z'), state: 'SUCCEEDED', result_ref: result.resultRef, output_format: submission.output.format });
        if (ctx.idempotencyKey) identities.set(ctx.idempotencyKey, { hash: canonicalRequestHash(ctx.legacyRequestIdentity!), id });
        return { operation: { id }, replayed: false };
      },
    },
    config: {},
  } as unknown as RouteContext;
  return { host: legacyCompatHost(context), worker, context, operations, counts: () => ({ uploads, preflights }) };
}
function file(name: string, text: string) { const bytes = Buffer.from(text); return { name, bytes, size: bytes.length, type: 'text/plain' }; }

describe('ORV11 compatibility producer to document worker and result reader', () => {
  it.each(['text', 'json', 'html', 'csv'])('uploads multipart, worker to %s result/download and replay without another blob', async (format) => {
    const h = harness();
    const request = () => decodeLegacyWire('ingest', { form: { mode: 'parse', file: file('doc.txt', 'Original document'), output_format: format }, headers: { 'Idempotency-Key': 'retry' } });
    const first = await h.host.submitLegacy!(principal, 'ingest', request());
    if (!first) throw new Error('submit did not return operation');
    const row = await h.host.loadOperation(first.operationId, principal.tenantId, principal.apiKeyId);
    expect(row?.createdAt).toBe('2026-10-11T00:00:00.000Z');
    expect(row?.outputContent).toContain('Original document');
    expect((await h.host.loadOutputContent!(first.operationId, principal.tenantId, principal.apiKeyId))?.toString()).toContain('Original document');
    expect(await h.host.submitLegacy!(principal, 'ingest', request())).toEqual({ ...first, replayed: true });
    expect(h.counts()).toEqual({ uploads: 1, preflights: 1 });
    expect(await h.host.loadOperation(first.operationId, principal.tenantId, randomUUID())).toBeNull();
    expect(await h.host.loadOperation(first.operationId, randomUUID(), principal.apiKeyId)).toBeNull();
  });

  it.each([11, 20])('runs %i URL inputs through the actual ingest worker', async (count) => {
    const h = harness();
    const decoded = decodeLegacyWire('ingest', { form: { mode: 'parse', file_urls: JSON.stringify(Array.from({ length: count }, (_, i) => ({ url: `http://example.com/${i}.txt` }))) } });
    expect((await h.host.submitLegacy!(principal, 'ingest', decoded))?.operationId).toBeTruthy();
    expect(h.counts().uploads).toBe(count);
  });
  it('preserves one multipart file plus twenty URLs through the actual worker', async () => {
    const h = harness();
    const decoded = decodeLegacyWire('ingest', { form: { mode: 'parse', file: file('local.txt', 'local'), file_urls: JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}.txt` }))) } });
    expect((await h.host.submitLegacy!(principal, 'ingest', decoded))?.operationId).toBeTruthy();
    expect(h.counts().uploads).toBe(21);
  });
  it('rejects extra compare inputs before any upload', async () => {
    const h = harness();
    const decoded = decodeLegacyWire('compare', { form: { mode: 'diff', 'files[]': [file('a.txt','a'), file('b.txt','b'), file('c.txt','c')] } });
    await expect(h.host.submitLegacy!(principal, 'compare', decoded)).rejects.toMatchObject({ status: 422 });
    expect(h.counts().uploads).toBe(0);
  });

  it('maps source_file and target_file into actual compare handler inputs', async () => {
    const h = harness();
    const decoded = decodeLegacyWire('compare', { form: { mode: 'diff', source_file: file('a.txt', 'Alpha beta'), target_file: file('b.txt', 'Alpha gamma') } });
    const result = await h.host.submitLegacy!(principal, 'compare', decoded);
    if (!result) throw new Error('submit did not return operation');
    const row = await h.host.loadOperation(result.operationId, principal.tenantId, principal.apiKeyId);
    expect(row?.extractedData).toContain('gamma');
    expect(h.counts().uploads).toBe(2);
  });

  it('does not replay reordered same-name files with different bytes', async () => {
    const h = harness();
    const request = (texts: string[]) => decodeLegacyWire('ingest', { form: { mode: 'parse', 'files[]': texts.map((text) => file('same.txt', text)) }, headers: { 'Idempotency-Key': 'ordered' } });
    await h.host.submitLegacy!(principal, 'ingest', request(['first', 'second']));
    await expect(h.host.submitLegacy!(principal, 'ingest', request(['second', 'first']))).rejects.toMatchObject({ status: 409 });
    expect(h.counts().uploads).toBe(2);
  });

  it('retains historical downloads larger than the result-envelope cap', async () => {
    const h = harness();
    const id = randomUUID();
    const blob = Buffer.alloc(9 * 1024 * 1024, 42);
    h.worker.artifactsStore.set('historical', blob);
    h.operations.set(id, { id, tenant_id: principal.tenantId, api_key_id: principal.apiKeyId, state: 'SUCCEEDED', output_file_path: 'historical' });
    expect((await h.host.loadOutputContent!(id, principal.tenantId, principal.apiKeyId))?.equals(blob)).toBe(true);
  });

  it('discovers document variants and three named workflows with profile visibility', async () => {
    const host = legacyCompatHost({
      db: { query: async () => ({ rowCount: 2, rows: [
        { business_id: 'document-core', version: '1.1.0', manifest: documentCoreManifest },
        { business_id: 'lc-checker', version: '1.0.0', manifest: { actions: [{ name: 'lc-checker', inputSchema: {} }] } },
      ] }) },
      profiles: { resolveEffectiveProfile: async (_key: string, _business: string, _version: string, _action: string, _input: unknown, _keys: unknown, slug: string) => {
        if (slug === 'extract:receipt') throw Object.assign(new Error('disabled'), { status: 403 });
        return { mode: 'legacy' };
      } },
    } as unknown as RouteContext);
    const services = await host.serviceCatalogue!(principal.apiKeyId);
    const workflows = services!.find(service => service.serviceId === 'workflows')!;
    expect((workflows.subCases as Array<{ id: string }>).map(entry => entry.id).sort()).toEqual(['disbursement', 'doc-compare', 'lc-checker']);
    const extract = services!.find(service => service.serviceId === 'extract')!;
    expect((extract.subCases as Array<{ id: string }>).map(entry => entry.id)).not.toContain('receipt');
  });

  it('freezes the legacy callback body without canonical delivery fields', async () => {
    let payload: unknown;
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rowCount: 1, rows: [{ id: 'op', tenant_id: principal.tenantId, state: 'SUCCEEDED', state_version: 2, callback_url: 'https://example.com/callback', updated_at: new Date().toISOString(), callback_policy: null, pipeline_json: [{ legacyCallback: true }] }] };
      if (sql.includes('INSERT')) { payload = JSON.parse(String(values![6])); return { rowCount: 1, rows: [{ delivery_id: 'delivery' }] }; }
      throw new Error('Legacy callback must not be stamped with canonical fields');
    });
    await maybeScheduleWebhook({ query } as unknown as DbClient, 'op');
    expect(payload).toEqual({ operation_id: 'op', state: 'SUCCEEDED', done: true });
  });
});
