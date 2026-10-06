import { createHash } from 'node:crypto';
import type { Db } from '../src/db/db';
import { createGrantService } from '../src/modules/grants/grants';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN_ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const CONTENT = Buffer.from('offline OCR fixture');
const SHA256 = createHash('sha256').update(CONTENT).digest('hex');

function makeGrantService(artifactOverrides: Record<string, unknown> = {}) {
  const artifact = {
    artifactId: ARTIFACT_ID,
    tenantId: 'tenant-a',
    operationId: OPERATION_ID,
    purpose: 'input',
    state: 'READY',
    storageBackend: 's3',
    storageVersionId: 's3-version-1',
    fileName: 'scan.png',
    mimeType: 'image/png',
    sizeBytes: CONTENT.length,
    sha256: SHA256,
    ...artifactOverrides,
  };
  const statements: string[] = [];
  const client = {
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
      statements.push(sql);
      if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
        return {
          rowCount: 1,
          rows: [{
            lease_epoch: 7,
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            state: 'RUNNING',
            operation_id: OPERATION_ID,
            tenant_id: 'tenant-a',
            business_id: 'document-core',
            business_version: '1.0.0',
            action: 'ingest',
            connector_bindings: null,
            submitArtifacts: [],
          }],
        };
      }
      if (sql.includes('FROM ARTIFACTS WHERE ID = ANY')) {
        return { rowCount: 1, rows: [artifact] };
      }
      if (sql.includes('FROM INVOCATION_GRANTS')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('INSERT INTO INVOCATION_GRANTS')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected grant SQL: ${sql}`);
    },
  };
  const db = {
    tx: async <T>(callback: (transaction: typeof client) => Promise<T>) => callback(client),
  } as unknown as Db;
  const service = createGrantService(db, {
    getEnabledVersion: async () => ({
      manifest: { actions: [{ name: 'ingest', connectorSlots: [{ name: 'ocr' }] }] },
    }),
  }, {
    connectorId: 'connector-1',
    connectorRevision: 2,
    secret: Buffer.from('test-invocation-grant-secret'),
  });
  return { service, statements };
}


  /** Same harness, but with control over the TASK lease (epoch and expiry). */
  function makeGrantServiceWithLease(
    tenantId: string,
    leaseExpiresAt: string,
    leaseEpoch = 7,
  ) {
    const artifact = {
      artifactId: ARTIFACT_ID,
      tenantId,
      operationId: OPERATION_ID,
      purpose: 'input',
      state: 'READY',
      storageBackend: 's3',
      storageVersionId: 's3-version-1',
      fileName: 'scan.png',
      mimeType: 'image/png',
      sizeBytes: CONTENT.length,
      sha256: SHA256,
    };
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
        statements.push(sql);
        if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
          return {
            rowCount: 1,
            rows: [{
              lease_epoch: leaseEpoch,
              lease_expires_at: leaseExpiresAt,
              state: 'RUNNING',
              operation_id: OPERATION_ID,
              tenant_id: 'tenant-a',
              business_id: 'document-core',
              business_version: '1.0.0',
              action: 'ingest',
              connector_bindings: null,
              submitArtifacts: [],
            }],
          };
        }
        if (sql.includes('FROM ARTIFACTS WHERE ID = ANY')) return { rowCount: 1, rows: [artifact] };
        if (sql.includes('FROM INVOCATION_GRANTS')) return { rowCount: 0, rows: [] };
        if (sql.startsWith('INSERT INTO INVOCATION_GRANTS')) return { rowCount: 1, rows: [] };
        throw new Error('Unexpected grant SQL: ' + sql);
      },
    };
    const db = { tx: async <T>(cb: (c: typeof client) => Promise<T>) => cb(client) } as unknown as Db;
    const service = createGrantService(db, {
      getEnabledVersion: async () => ({
        manifest: { actions: [{ name: 'ingest', connectorSlots: [{ name: 'ocr' }] }] },
      }),
    }, {
      connectorId: 'connector-1',
      connectorRevision: 2,
      secret: Buffer.from('test-invocation-grant-secret'),
    });
    return { service, statements };
  }

describe('invocation grant artifact pins', () => {
  const request = {
    leaseEpoch: 7,
    stepKey: 'ingest.ocr',
    bindingSlot: 'ocr',
    inputHash: 'sha256:bound-input',
    artifactIds: [ARTIFACT_ID],
  };

  it('signs the READY artifact tenant scope, content identity and immutable version', async () => {
    const { service, statements } = makeGrantService();
    const result = await service.issue(TASK_ID, 7, request);
    const claims = JSON.parse(Buffer.from(result.grant.split('.')[1]!, 'base64url').toString('utf8')) as {
      tenantId: string;
      artifactIds: string[];
      artifactPins: Array<Record<string, unknown>>;
    };

    expect(claims.tenantId).toBe('tenant-a');
    expect(claims.artifactIds).toEqual([ARTIFACT_ID]);
    expect(claims.artifactPins).toEqual([{
      artifactId: ARTIFACT_ID,
      fileName: 'scan.png',
      mimeType: 'image/png',
      sizeBytes: CONTENT.length,
      sha256: SHA256,
      storageVersionId: 's3-version-1',
    }]);
    expect(statements.some((sql) => sql.includes('FROM ARTIFACTS') && sql.includes('FOR SHARE'))).toBe(true);
  });

  it.each([
    ['foreign tenant', { tenantId: 'tenant-b' }],
    ['another operation', { operationId: '55555555-5555-4555-8555-555555555555' }],
    ['STAGING state', { state: 'STAGING' }],
    ['unpinned S3 version', { storageVersionId: null }],
    ['mutable S3 null version', { storageVersionId: 'null' }],
  ])('rejects %s references before issuing a grant', async (_name, overrides) => {
    const { service, statements } = makeGrantService(overrides);
    await expect(service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(statements.some((sql) => sql.startsWith('INSERT INTO INVOCATION_GRANTS'))).toBe(false);
  });

  it('rejects a request that names an artifact row not returned by the tenant-scoped lookup', async () => {
    const { service } = makeGrantService({ artifactId: FOREIGN_ARTIFACT_ID });
    await expect(service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  });

  // Turn 333 / W-PLAT-CR28-01-GRANT-ARTIFACT-PINS-NEGATIVE.
  //
  // Two packet items do not correspond to behaviour that exists, and I am not
  // going to write a green test that pretends otherwise. See the two findings
  // at the end of this block; both are recorded rather than papered over.
  describe('packet negatives: cross-tenant, pin liveness, and integrity drift', () => {
    const request = {
      leaseEpoch: 7,
      stepKey: 'ingest.ocr',
      bindingSlot: 'ocr',
      inputHash: 'sha256:bound-input',
      artifactIds: [ARTIFACT_ID],
    };

    // 1) cross-tenant access is fail-closed ---------------------------------
    it('refuses a foreign tenant, and refuses it BEFORE the grant row is written', async () => {
      // The tenant compared is the TASK's tenant against the ARTIFACT's, so a
      // forged artifact row claiming our own tenant but a foreign operation is
      // caught by the second guard rather than the first. Both must deny.
      const { service, statements } = makeGrantService({ tenantId: 'tenant-b' });
      await expect(service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
      expect(statements.some((sql) => sql.startsWith('INSERT INTO INVOCATION_GRANTS'))).toBe(false);
    });

    it('refuses a cross-tenant artifact even when the row otherwise looks READY and pinned', async () => {
      // Every OTHER pin field is valid here. Only the tenant differs, so this
      // isolates tenant as the deciding input and nothing else masks it.
      const { service, statements } = makeGrantService({
        tenantId: 'tenant-b',
        state: 'READY',
        purpose: 'input',
        storageBackend: 's3',
        storageVersionId: 's3-version-1',
        sha256: SHA256,
      });
      await expect(service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
      expect(statements.some((sql) => sql.startsWith('INSERT INTO INVOCATION_GRANTS'))).toBe(false);
    });

    // 2) pin liveness ------------------------------------------------------
    it('an EXPIRED task lease refuses the grant; the pin is never minted', async () => {
      // The pin's liveness window is the TASK LEASE, not the artifact. A grant
      // issued against a dead lease would hand the connector authority nobody
      // can revoke, so this must refuse even though the artifact is pristine.
      const { service, statements } = makeGrantService();
      const client = { query: async () => ({ rowCount: 1, rows: [] }) };
      // Re-harness with an already-expired lease.
      const expired = makeGrantServiceWithLease('tenant-a', new Date(Date.now() - 60_000).toISOString());
      void client;
      await expect(expired.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(expired.statements.some((sql) => sql.startsWith('INSERT INTO INVOCATION_GRANTS'))).toBe(false);
      void statements;
    });

    it('a STALE lease epoch is refused before the artifact is even inspected', async () => {
      const stale = makeGrantServiceWithLease('tenant-a', new Date(Date.now() + 60_000).toISOString(), 99);
      await expect(stale.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(stale.statements.some((sql) => sql.includes('FROM ARTIFACTS'))).toBe(false);
    });

    // 3) integrity drift on hash / storage version -------------------------
    it.each([
      ['missing sha256', { sha256: null }],
      ['empty sha256', { sha256: '' }],
      ['missing fileName', { fileName: null }],
      ['missing mimeType', { mimeType: null }],
      ['zero sizeBytes', { sizeBytes: 0 }],
      ['negative sizeBytes', { sizeBytes: -1 }],
      ['fractional sizeBytes', { sizeBytes: 1.5 }],
      ['non-numeric sizeBytes', { sizeBytes: 'not-a-number' }],
    ])('refuses an artifact with %s rather than pinning a lie', async (_name, overrides) => {
      const { service, statements } = makeGrantService(overrides);
      await expect(service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
      expect(statements.some((sql) => sql.startsWith('INSERT INTO INVOCATION_GRANTS'))).toBe(false);
    });

    it('a postgres artifact derives its immutable version from sha256; s3 does not', async () => {
      // postgres has no object version, so the code substitutes the content hash
      // as the immutability anchor. My first draft assumed postgres with no
      // version would be REFUSED; it is not, and reading the source is what
      // corrected that. Asserting the real rule: the hash IS the version there.
      const derived = makeGrantService({ storageBackend: 'postgres', storageVersionId: null });
      const ok = await derived.service.issue(TASK_ID, 7, request);
      const claims = JSON.parse(Buffer.from(ok.grant.split('.')[1]!, 'base64url').toString('utf8')) as {
        artifactPins: Array<{ storageVersionId: string }>;
      };
      expect(claims.artifactPins[0]?.storageVersionId).toBe(SHA256);

      // s3 has a real object version, so the mutable literal 'null' is refused
      // rather than substituted. The two backends are deliberately different.
      const mutable = makeGrantService({ storageBackend: 's3', storageVersionId: 'null' });
      await expect(mutable.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });

      // And with no hash to stand in for it, postgres has nothing immutable left.
      const noHash = makeGrantService({ storageBackend: 'postgres', storageVersionId: null, sha256: null });
      await expect(noHash.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    });

    it('a mismatched artifact id in the request cannot borrow another row', async () => {
      // The lookup returns exactly one row; asking for a different id must not
      // silently pin the row that happened to come back.
      const { service } = makeGrantService();
      await expect(service.issue(TASK_ID, 7, { ...request, artifactIds: [FOREIGN_ARTIFACT_ID] }))
        .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    });

    it('an artifact outside the task operation is refused even when the tenant matches', async () => {
      const foreign = makeGrantService({ operationId: '55555555-5555-4555-8555-555555555555' });
      await expect(foreign.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    });

    it('FINDING: purpose is NOT restricted to input/output for a same-operation artifact', async () => {
      // I assumed an unknown purpose would be refused. Reading the source, the
      // purpose gate (line 241) only qualifies the DECLARED-REFERENCE path; a
      // same-operation artifact passes on that path alone, so 'intermediate' is
      // legitimately pinnable. Recording the real rule instead of forcing the
      // test to match my assumption.
      const odd = makeGrantService({ purpose: 'intermediate' });
      const result = await odd.service.issue(TASK_ID, 7, request);
      const claims = JSON.parse(Buffer.from(result.grant.split('.')[1]!, 'base64url').toString('utf8')) as {
        artifactPins: Array<{ artifactId: string }>;
      };
      expect(claims.artifactPins[0]?.artifactId).toBe(ARTIFACT_ID);

      // The gate DOES bite when the artifact belongs to another operation and is
      // not in submit_artifacts, because neither path is then available.
      const foreign = makeGrantService({ operationId: '55555555-5555-4555-8555-555555555555' });
      await expect(foreign.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    });

    // Findings, recorded rather than asserted as passing behaviour.
    it('FINDING: an artifact sha256 is PRESENCE-checked, never CONTENT-verified, at pin time', async () => {
      // The grant signer copies artifact.sha256 into the pin. It does not recompute
      // the digest of the bytes, so a drifted/rewritten row is pinned faithfully
      // and only detected downstream (or never). This test documents the real
      // boundary; it is NOT an assertion that drift is caught here.
      const drifted = makeGrantService({ sha256: 'f'.repeat(64) });
      const result = await drifted.service.issue(TASK_ID, 7, request);
      const claims = JSON.parse(Buffer.from(result.grant.split('.')[1]!, 'base64url').toString('utf8')) as {
        artifactPins: Array<{ sha256: string }>;
      };
      // The bogus hash is carried through verbatim: pinned as-is, not verified.
      expect(claims.artifactPins[0]?.sha256).toBe('f'.repeat(64));
    });

    it('FINDING: the artifact table has no expiry column, so there is no expired-PIN to refuse', async () => {
      // artifacts are invalidated by state (STAGING/EXPIRED/DELETED), never by a
      // timestamp on the pin. The only expiries in this path are the task lease
      // and the grant TTL. Asserted here so the absence is visible and cannot be
      // mistaken for untested behaviour.
      const st = makeGrantService({ state: 'EXPIRED' });
      await expect(st.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
      const del = makeGrantService({ state: 'DELETED' });
      await expect(del.service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    });
  });
});
