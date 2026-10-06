import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import {
  createSubmissionService,
  type SubmitContext,
} from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';

const TENANT_ID = '73000000-0000-4000-8000-000000000001';
const FOREIGN_TENANT_ID = '73000000-0000-4000-8000-000000000002';
const ARTIFACT_ID = '75000000-0000-4000-8000-000000000001';

interface ArtifactRow extends QueryResultRow {
  id: string;
  state: string;
  expired: boolean;
  tenant_id: string;
}

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows: rows as T[],
    fields: [],
  };
}

function makeSubmitService(rows: ArtifactRow[], maxBlobBytes = 1024) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const ids = Array.isArray(params[0]) ? params[0] as string[] : [];
      const tenantId = params[1];
      return queryResult<T>(rows.filter((row) => row.tenant_id === tenantId && ids.includes(row.id)));
    },
    tx: async () => {
      throw new Error('guard rejection must happen before opening a write transaction');
    },
    close: async () => undefined,
  } as unknown as Db;
  const profiles = {
    resolveBinding: async () => ({ mode: "legacy" as const }),
    resolveEffectiveProfile: async () => ({ mode: "legacy" as const }),
  } as unknown as ProfileService;
  const service = createSubmissionService(
    db,
    {} as RegistryService,
    profiles,
    { maxBlobBytes }
  );
  return { service, queries };
}

function context(submission: unknown): SubmitContext {
  return {
    tenantId: TENANT_ID,
    apiKeyId: '74000000-0000-4000-8000-000000000001',
    businessId: 'example-business',
    action: 'ingest',
    submission,
  };
}

describe('DATA-02 public artifact submit guards', () => {
  it('rejects an artifact that has not been finalized from STAGING', async () => {
    const { service, queries } = makeSubmitService([
      { id: ARTIFACT_ID, state: 'STAGING', expired: false, tenant_id: TENANT_ID },
    ]);

    await expect(service.submit(context({
      input: {},
      artifacts: [{ artifactId: ARTIFACT_ID, role: 'source' }],
    }))).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toMatch(/tenant_id\s*=\s*\$2[\s\S]*FOR SHARE/i);
    expect(queries[0]?.params).toEqual([[ARTIFACT_ID], TENANT_ID]);
  });

  it('fails closed when a referenced artifact belongs to another tenant', async () => {
    // Tenant-scoped queries return no row for a foreign-owned artifact, which
    // is intentionally indistinguishable from an ID that does not exist.
    const { service, queries } = makeSubmitService([
      { id: ARTIFACT_ID, state: 'READY', expired: false, tenant_id: FOREIGN_TENANT_ID },
    ]);

    let thrown: unknown;
    try {
      await service.submit(context({
        input: { attachments: [{ artifactId: ARTIFACT_ID }] },
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(queries[0]?.params).toEqual([[ARTIFACT_ID], TENANT_ID]);
    expect(thrown).toHaveProperty('message', 'artifact not found or expired');
  });

  it('rejects an embedded base64 file payload over maxBlobBytes before database access', async () => {
    const { service, queries } = makeSubmitService([], 4);
    const encodedFile = Buffer.from([1, 2, 3, 4, 5]).toString('base64');

    await expect(service.submit(context({
      input: { file: { name: 'fixture.bin', contentBase64: encodedFile } },
    }))).rejects.toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(queries).toHaveLength(0);
  });

  it('rejects embedded numeric file bytes over maxBlobBytes', async () => {
    const { service, queries } = makeSubmitService([], 4);

    await expect(service.submit(context({
      input: { attachment: { fileName: 'fixture.bin', data: [1, 2, 3, 4, 5] } },
    }))).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(queries).toHaveLength(0);
  });

  it('rejects expired references even when their persisted state is READY', async () => {
    const { service } = makeSubmitService([
      { id: ARTIFACT_ID, state: 'READY', expired: true, tenant_id: TENANT_ID },
    ]);

    await expect(service.submit(context({
      input: {},
      artifacts: [{ artifactId: ARTIFACT_ID, role: 'source' }],
    }))).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  // W-PLAT-CR28-02-ARTIFACT-SUBMIT-GUARDS-NEGATIVE: shape, scope and budget
  // negatives. Two packet items turned out to have NO corresponding guard; those
  // are recorded as FINDING tests so the absence is visible rather than
  // mistaken for untested behaviour.
  describe('submit guards: shape, scope, and budget negatives', () => {
    // (1) malformed submit payload shape -----------------------------------
    it.each([
      ['null body', null],
      ['undefined body', undefined],
      ['missing input', {}],
      ['input is a string', { input: 'not-an-object' }],
      ['input is an array', { input: [] }],
      ['input is null', { input: null }],
      ['artifacts is not an array', { input: {}, artifacts: { artifactId: ARTIFACT_ID } }],
      ['artifact entry is not an object', { input: {}, artifacts: ['nope'] }],
      ['artifact id is not a uuid', { input: {}, artifacts: [{ artifactId: 'not-a-uuid', role: 'source' }] }],
      ['artifact role is empty', { input: {}, artifacts: [{ artifactId: ARTIFACT_ID, role: '' }] }],
      ['unknown top-level field (schema is strict)', { input: {}, sneaky: true }],
      ['sourceUrl is a number', { input: {}, sourceUrl: 42 }],
    ])('rejects %s with 422 before any database access', async (_name, body) => {
      const { service, queries } = makeSubmitService([]);
      await expect(service.submit(context(body))).rejects.toMatchObject({
        status: 422,
        code: 'INVALID_SCHEMA',
      });
      // Shape is validated before anything is read or written.
      expect(queries).toHaveLength(0);
    });

    it('reports the offending pointer rather than a bare 422', async () => {
      const { service } = makeSubmitService([]);
      let thrown: unknown;
      try {
        await service.submit(context({ input: {}, artifacts: [{ artifactId: 'nope', role: 'source' }] }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      // HttpError keeps the third constructor argument on `.extra` (errors.ts:13)
      // and toProblem() spreads it into the problem body. My first draft read a
      // `.detail` field that does not exist.
      const extra = (thrown as { extra?: { errors?: Array<{ pointer: string }> } }).extra;
      expect(Array.isArray(extra?.errors)).toBe(true);
      expect((extra?.errors ?? []).length).toBeGreaterThan(0);
    });

    // (2) submit outside the allowed scope ---------------------------------
    it('refuses URL ingestion when the deployment is not on s3 (default fail-closed)', async () => {
      // storageBackend defaults to postgres, so this is the DEFAULT deployment
      // shape: URL ingestion must be refused with zero database access, so no
      // operation/task/outbox row is parked in a state no consumer can open.
      const { service, queries } = makeSubmitService([]);
      await expect(service.submit(context({
        input: {},
        sourceUrl: 'https://example.com/doc.pdf',
      }))).rejects.toMatchObject({
        status: 422,
        code: 'UNSUPPORTED_STORAGE_BACKEND',
      });
      expect(queries).toHaveLength(0);
    });

    it('refuses a URL ingestion pointing at a non-http scheme or a private host', async () => {
      const { queries } = makeSubmitService([]);
      const db = {
        query: async () => queryResult([]),
        tx: async () => { throw new Error('guard rejection must happen before opening a write transaction'); },
        close: async () => undefined,
      } as unknown as Db;
      const s3 = createSubmissionService(
        db,
        {} as RegistryService,
        {
          resolveBinding: async () => ({ mode: 'legacy' as const }),
          resolveEffectiveProfile: async () => ({ mode: 'legacy' as const }),
        } as unknown as ProfileService,
        { storageBackend: 's3' },
      );
      for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'http://127.0.0.1/x', 'http://169.254.169.254/']) {
        await expect(s3.submit(context({ input: {}, sourceUrl: bad }))).rejects.toBeInstanceOf(HttpError);
      }
      expect(queries).toHaveLength(0);
    });

    // (3) budget boundary: the exact edge, both sides of it ----------------
    it('accepts embedded bytes exactly AT the limit and refuses one byte over', async () => {
      const atLimit = makeSubmitService([], 4);
      const overLimit = makeSubmitService([], 4);
      const exact = Buffer.from([1, 2, 3, 4]);

      // The boundary is `> maxBytes`, so exactly-at must NOT trip the size guard.
      // Asserting only the over-limit case would let an off-by-one (>= instead
      // of >) pass unnoticed.
      let atError: unknown;
      try {
        await atLimit.service.submit(context({
          input: { file: { name: 'at.bin', contentBase64: exact.toString('base64') } },
        }));
      } catch (error) {
        atError = error;
      }
      expect((atError as { code?: string } | undefined)?.code).not.toBe('PAYLOAD_TOO_LARGE');

      await expect(overLimit.service.submit(context({
        input: { file: { name: 'over.bin', contentBase64: Buffer.from([1, 2, 3, 4, 5]).toString('base64') } },
      }))).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    });

    it('FINDING: a ZERO-byte embedded file is NOT rejected, the budget is only an upper bound', async () => {
      // The packet asked for zero-byte rejection. Reading the guard first
      // (`totalBytes > maxBytes`) says otherwise: zero is under every ceiling, so
      // an empty file sails through. Recording the real rule instead of writing a
      // green test asserting a rejection that never happens.
      const { service } = makeSubmitService([], 4);
      let thrown: unknown;
      try {
        await service.submit(context({
          input: { file: { name: 'empty.bin', contentBase64: '' } },
        }));
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string } | undefined)?.code).not.toBe('PAYLOAD_TOO_LARGE');
    });

    // (4) tenant identity ---------------------------------------------------
    it('FINDING: a MISSING tenantId is not validated before the artifact query', async () => {
      // `submit` has no assertTenantId; the tenant is only ever a query
      // parameter. A missing tenant therefore produces no distinct rejection,
      // only a lookup that cannot match. Asserted so the gap is explicit: this is
      // NOT a tenant isolation boundary, it is the ABSENCE of one at this layer
      // (the HTTP layer is expected to enforce it before calling submit).
      const { service, queries } = makeSubmitService([
        { id: ARTIFACT_ID, state: 'READY', expired: false, tenant_id: TENANT_ID },
      ]);
      let thrown: unknown;
      try {
        await service.submit({ ...context({
          input: {},
          artifacts: [{ artifactId: ARTIFACT_ID, role: 'source' }],
        }), tenantId: undefined as unknown as string });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.params?.[1]).toBeUndefined();
    });

    it('a foreign tenantId still cannot reach another tenant artifact', async () => {
      // The contrast that keeps the previous finding safe rather than alarming:
      // the TENANT-SCOPED QUERY is the real fence. Even with a wrong tenant id,
      // no foreign row is ever returned.
      const { service } = makeSubmitService([
        { id: ARTIFACT_ID, state: 'READY', expired: false, tenant_id: TENANT_ID },
      ]);
      await expect(service.submit({ ...context({
        input: {},
        artifacts: [{ artifactId: ARTIFACT_ID, role: 'source' }],
      }), tenantId: FOREIGN_TENANT_ID })).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  });
});
