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
    resolveBinding: async () => ({ mode: 'legacy' as const }),
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
});
