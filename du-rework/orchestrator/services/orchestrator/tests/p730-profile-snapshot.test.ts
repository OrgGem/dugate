import type { QueryResult, QueryResultRow } from 'pg';
import { ProfilePolicySnapshotSchema } from '@du/contracts';
import { redactString } from '@du/observability';
import type { Db } from '../src/db/db';
import { createSubmissionService } from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import { bullMqPriorityFor } from '../src/modules/profiles/policy';
import type { RegistryService } from '../src/modules/registry/registry';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { scanForSentinels } from '../../../../tests/harness/network-boundaries/sink-scan';
import { mkSentinel, sentinelShapeViolations } from '../../../../tests/harness/network-boundaries/sentinels';

const TENANT_ID = '73000000-0000-4000-8000-000000000001';
const API_KEY_ID = '73000000-0000-4000-8000-000000000002';
const PROFILE_ID = '73000000-0000-4000-8000-000000000003';
const OPERATION_ID = '73000000-0000-4000-8000-000000000004';
const TASK_ID = '73000000-0000-4000-8000-000000000005';
const ARTIFACT_ID = '73000000-0000-4000-8000-000000000006';
const BUSINESS_ID = 'document-core';
const PROFILE_REVISION = 7;
const SENTINELS = [mkSentinel('p730', 'bearer'), mkSentinel('p730', 'header'), mkSentinel('p730', 'query')];

const AUTH_CONFIG = {
  type: 'bearer' as const,
  token: SENTINELS[0],
  header_name: 'X-Api-Key',
  header_value: SENTINELS[1],
  query_key: 'api_key',
  query_value: SENTINELS[2],
};

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type SqlCall = { sql: string; params: unknown[] };

function hitPaths(value: unknown): string[] {
  return scanForSentinels(value, SENTINELS).map((hit) => hit.path);
}

function makeSubmissionDb(artifactFileName?: string) {
  const calls: SqlCall[] = [];
  let operationRow: Record<string, unknown> | undefined;
  const artifactRows = artifactFileName
    ? [{ id: ARTIFACT_ID, state: 'READY', expired: false, fileName: artifactFileName }]
    : [];

  const query = async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM business_versions/i.test(sql)) {
      return queryResult<T>([{
        version: '1.0.0',
        digest: 'sha256:p730-offline',
        queue: 'document-core',
        manifest: {
          actions: [{ name: 'extract', inputSchema: { type: 'object', additionalProperties: true } }],
          runtime: { handlerKinds: ['root'] },
        },
      }]);
    }
    if (/FROM artifacts/i.test(sql)) return queryResult<T>(artifactRows);
    if (/FROM operations/i.test(sql)) {
      return queryResult<T>(operationRow ? [operationRow] : []);
    }
    return queryResult<T>([]);
  };

  const db = {
    query,
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => fn({
      query: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM artifacts/i.test(sql)) return queryResult<R>(artifactRows);
        if (/INSERT INTO operations/i.test(sql)) {
          operationRow = {
            id: params[0],
            tenant_id: params[1],
            business_id: params[3],
            business_version: params[4],
            action: params[5],
            state: params[6],
            state_version: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deadline_at: null,
          };
        }
        return queryResult<R>([], 'INSERT');
      },
    } as never),
    close: async () => undefined,
  } as unknown as Db;

  return { db, calls };
}

function pinnedProfile(input: Record<string, unknown> = {}) {
  return {
    mode: 'pinned' as const,
    profileId: PROFILE_ID,
    revision: PROFILE_REVISION,
    bindings: { primary: 'connector-a@3' },
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH' as const,
      allowedFileExtensions: '.pdf,.docx',
      connectionsOverride: [],
      fileUrlAuthConfig: AUTH_CONFIG,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: input,
    bullMqPriority: 1,
  };
}

function submissionService(db: Db, input: Record<string, unknown> = {}) {
  const profiles = {
    resolveBinding: async () => ({ mode: 'legacy' as const }),
    resolveEffectiveProfile: async () => pinnedProfile(input),
  } as unknown as ProfileService;
  return createSubmissionService(db, {} as RegistryService, profiles, { storageBackend: 's3' });
}

function submitContext(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    apiKeyId: API_KEY_ID,
    businessId: BUSINESS_ID,
    action: 'extract',
    submission: { input, ...extra },
  };
}

function mustCall(calls: SqlCall[], pattern: RegExp): SqlCall {
  const call = calls.find((candidate) => pattern.test(candidate.sql));
  if (!call) throw new Error(`missing SQL statement ${String(pattern)}`);
  return call;
}

type RuntimeWorldOptions = {
  snapshot: unknown;
  tenantId?: string;
  profileId?: string;
  profileRevision?: number;
};

function makeRuntimeWorld(options: RuntimeWorldOptions) {
  const committedWrites: string[] = [];
  const taskRow: Record<string, unknown> = {
    id: TASK_ID,
    operation_id: OPERATION_ID,
    task_key: 'root',
    kind: 'root',
    payload_ref: {},
    state: 'READY',
    attempt: 0,
    lease_epoch: 0,
    lease_expires_at: null,
    leased_by: null,
    last_delivery_id: null,
    tenant_id: options.tenantId ?? TENANT_ID,
    business_id: BUSINESS_ID,
    business_version: '1.0.0',
    action: 'extract',
    input_ref: { body: 'offline' },
    deadline_at: null,
    manifest_digest: 'sha256:p730-offline',
    profile_id: options.profileId ?? PROFILE_ID,
    profile_revision: options.profileRevision ?? PROFILE_REVISION,
    connector_bindings: { primary: 'connector-a@3' },
    profile_policy_snapshot: options.snapshot,
    op_cancel_requested: false,
    op_state: 'ACCEPTED',
  };

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in p730 profile snapshot test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const pendingWrites: string[] = [];
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<R>> => {
          if (/FROM tasks t/i.test(sql) && /JOIN operations o/i.test(sql)) {
            return queryResult<R>([taskRow]);
          }
          if (/SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: 'ACCEPTED' }]);
          }
          if (/FROM step_checkpoints/i.test(sql)) return queryResult<R>([]);
          if (/^\s*UPDATE /i.test(sql)) {
            pendingWrites.push(sql);
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          throw new Error(`unexpected transaction query in p730 profile snapshot test: ${sql}`);
        },
      };
      const value = await fn(client as never);
      committedWrites.push(...pendingWrites);
      return value;
    },
    close: async () => undefined,
  } as unknown as Db;

  return { runtime: createRuntimeService(db), committedWrites };
}

async function capturedOutput<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown; text: string }> {
  const chunks: string[] = [];
  const intercept = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.();
    return true;
  };
  const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(intercept as typeof process.stdout.write);
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(intercept as typeof process.stderr.write);
  try {
    return { value: await run(), text: chunks.join('') };
  } catch (error) {
    return { error, text: chunks.join('') };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('P730 W2-B profile policy snapshot producer and claim consumer', () => {
  it('uses redactor-invisible positive controls before scanning real submit/claim sinks', async () => {
    expect(SENTINELS.flatMap((sentinel) => sentinelShapeViolations(sentinel, redactString))).toEqual([]);
    expect(hitPaths(AUTH_CONFIG)).toEqual(['$.query_value', '$.header_value', '$.token']);

    const { db, calls } = makeSubmissionDb();
    const submitted = await capturedOutput(async () => submissionService(db).submit(submitContext({ text: 'offline' })));
    expect(submitted.error).toBeUndefined();

    const operationInsert = mustCall(calls, /INSERT INTO operations/i);
    const taskInsert = mustCall(calls, /INSERT INTO tasks/i);
    const outboxInsert = mustCall(calls, /INSERT INTO outbox/i);
    const snapshot = JSON.parse(String(operationInsert.params[15])) as Record<string, unknown>;
    const outboxPayload = JSON.parse(String(outboxInsert.params[2])) as Record<string, unknown>;
    const taskPayload = JSON.parse(String(taskInsert.params[3])) as unknown;
    const claimWorld = makeRuntimeWorld({ snapshot });
    const claimed = await capturedOutput(() => claimWorld.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));

    expect(claimed.error).toBeUndefined();
    expect(snapshot).toEqual({
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf,.docx',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: PROFILE_REVISION },
    });
    expect(outboxPayload.priority).toBe(1);
    expect(ProfilePolicySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(claimed.value?.executionSnapshot.pinned.profilePolicy?.credentialRef).toEqual({
      tenantId: TENANT_ID,
      profileId: PROFILE_ID,
      profileRevision: PROFILE_REVISION,
    });

    const sinks = {
      databaseCalls: calls,
      operationSnapshot: snapshot,
      taskPayload,
      outboxPayload,
      claim: claimed.value,
      submitLogs: submitted.text,
      claimLogs: claimed.text,
    };
    expect(hitPaths(sinks)).toEqual([]);
  });

  it('keeps F-PP1 priority direction from profile to outbox', async () => {
    expect({
      LOW: bullMqPriorityFor('LOW'),
      MEDIUM: bullMqPriorityFor('MEDIUM'),
      HIGH: bullMqPriorityFor('HIGH'),
    }).toEqual({ LOW: 20, MEDIUM: 10, HIGH: 1 });

    const { db, calls } = makeSubmissionDb();
    await submissionService(db).submit(submitContext({ text: 'offline' }));
    const outbox = JSON.parse(String(mustCall(calls, /INSERT INTO outbox/i).params[2])) as Record<string, unknown>;
    expect(outbox.priority).toBe(1);
  });

  it('rejects unknown snapshot keys at claim time and leaves the lease transaction uncommitted', async () => {
    const snapshot = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: PROFILE_REVISION },
      fileUrlAuthConfig: AUTH_CONFIG,
    };
    const world = makeRuntimeWorld({ snapshot });
    const result = await capturedOutput(() => world.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));
    expect(result.error).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(world.committedWrites).toHaveLength(0);
    expect(hitPaths(result.error)).toEqual([]);
  });

  it('rejects unknown credentialRef fields and malformed refs fail-closed', async () => {
    const validSnapshot = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: PROFILE_REVISION, token: SENTINELS[0] },
    };
    expect(ProfilePolicySnapshotSchema.safeParse(validSnapshot).success).toBe(false);
    const world = makeRuntimeWorld({ snapshot: validSnapshot });
    const result = await capturedOutput(() => world.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));
    expect(result.error).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(world.committedWrites).toHaveLength(0);
    expect(hitPaths(result.error)).toEqual([]);

    const malformed = {
      ...validSnapshot,
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: 0 },
    };
    const malformedWorld = makeRuntimeWorld({ snapshot: malformed });
    const malformedResult = await capturedOutput(() => malformedWorld.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));
    expect(malformedResult.error).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(malformedWorld.committedWrites).toHaveLength(0);
  });

  it('fail-closes a credential ref whose tenant does not match the claimed operation', async () => {
    const snapshot = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: '73000000-0000-4000-8000-000000000099', profileId: PROFILE_ID, profileRevision: PROFILE_REVISION },
    };
    const world = makeRuntimeWorld({ snapshot });
    const result = await capturedOutput(() => world.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));
    expect({
      claimFailed: result.error !== undefined,
      committedWrites: world.committedWrites.length,
      returnedRef: result.value?.executionSnapshot.pinned.profilePolicy?.credentialRef,
    }).toEqual({
      claimFailed: true,
      committedWrites: 0,
      returnedRef: undefined,
    });
  });

  it('fail-closes a credential ref whose profile id does not match the operation pin', async () => {
    const snapshot = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT_ID, profileId: '73000000-0000-4000-8000-000000000099', profileRevision: PROFILE_REVISION },
    };
    const world = makeRuntimeWorld({ snapshot });
    const result = await capturedOutput(() => world.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));
    expect({
      claimFailed: result.error !== undefined,
      committedWrites: world.committedWrites.length,
      returnedRef: result.value?.executionSnapshot.pinned.profilePolicy?.credentialRef,
    }).toEqual({
      claimFailed: true,
      committedWrites: 0,
      returnedRef: undefined,
    });
  });

  it('fail-closes a credential ref whose revision does not match the operation pin', async () => {
    const snapshot = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: PROFILE_REVISION + 1 },
    };
    const world = makeRuntimeWorld({ snapshot });
    const result = await capturedOutput(() => world.runtime.claimTask(TASK_ID, 'delivery-p730', 'worker-p730', BUSINESS_ID));
    expect({
      claimFailed: result.error !== undefined,
      committedWrites: world.committedWrites.length,
      returnedRef: result.value?.executionSnapshot.pinned.profilePolicy?.credentialRef,
    }).toEqual({
      claimFailed: true,
      committedWrites: 0,
      returnedRef: undefined,
    });
  });

  it('enforces the profile extension CSV on declared fileUrls names before writes', async () => {
    const { db, calls } = makeSubmissionDb();
    await expect(submissionService(db, {
      fileUrls: [{ filename: 'invoice.exe', url: 'https://example.com/invoice.pdf' }],
    }).submit(submitContext({ fileUrls: [{ filename: 'invoice.exe', url: 'https://example.com/invoice.pdf' }] })))
      .rejects.toMatchObject({ status: 422, code: 'PROFILE_EXTENSION_DENIED' });
    expect(calls.some((call) => /INSERT INTO/i.test(call.sql))).toBe(false);
  });

  it('enforces the profile extension CSV on READY submitted artifact file names', async () => {
    const { db, calls } = makeSubmissionDb('invoice.exe');
    await expect(submissionService(db, {}).submit(submitContext({}, { artifacts: [{ artifactId: ARTIFACT_ID, role: 'input' }] })))
      .rejects.toMatchObject({ status: 422, code: 'PROFILE_EXTENSION_DENIED' });
    expect(calls.some((call) => /INSERT INTO/i.test(call.sql))).toBe(false);
  });

  it('enforces top-level sourceUrl path extensions without making a network request', async () => {
    const { db, calls } = makeSubmissionDb();
    await expect(submissionService(db).submit(submitContext({}, { sourceUrl: 'https://example.com/invoice.exe' })))
      .rejects.toMatchObject({ status: 422, code: 'PROFILE_EXTENSION_DENIED' });
    expect(calls.some((call) => /INSERT INTO/i.test(call.sql))).toBe(false);
  });

  it('does not treat query text as a file extension and admits allowed source paths', async () => {
    const { db, calls } = makeSubmissionDb();
    await expect(submissionService(db).submit(submitContext({}, { sourceUrl: 'https://example.com/report.pdf?download=invoice.exe' })))
      .resolves.toMatchObject({ replayed: false });
    expect(calls.some((call) => /INSERT INTO operations/i.test(call.sql))).toBe(true);
  });
});
