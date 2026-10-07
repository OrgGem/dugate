import { createHash } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createSubmissionService, buildPromptRevisionsPin } from '../src/modules/operations/submission';
import { parsePromptRevisionsPin } from '../src/modules/runtime/runtime';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import type { PromptOverrideService } from '../src/modules/profiles/prompt-overrides';
import type { PromptOverrideRead } from '@du/contracts';

/**
 * P745-PRODUCER-IMPL (step 1, marker-only) — the producer→claim pin.
 *
 * Producer: a pinned-mode submit resolves the override bucket ONCE
 * (`listFor(apiKeyId, action, tenant)`) and writes non-secret revision
 * markers into `operations.prompt_revisions_pin`. Claim: the column maps to
 * `pinned.promptRevisions` keyed `connectionId::stepId`; NULL keeps `{}`;
 * a malformed pin fails the claim closed.
 *
 * The harness is the W1 T-SUB-02 one (supervised fake, same INSERT path), so
 * the assertions read the REAL statement the service issues.
 */

const TENANT = '7a000000-0000-4000-8000-000000000001';
const KEY = '7a000000-0000-4000-8000-000000000002';
const PROFILE_ID = '7a000000-0000-4000-8000-000000000003';
const REVISION = 7;
const CONN_A = '7a000000-0000-4000-8000-00000000000a';
const CONN_B = '7a000000-0000-4000-8000-00000000000b';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

function makeDb() {
  const calls: Call[] = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(statement: string, params: unknown[] = []) => {
      calls.push({ sql: statement, params });
      if (/business_versions/i.test(statement)) {
        return result<T>([{
          version: '1.0.0',
          digest: 'sha256:test',
          queue: 'q',
          manifest: {
            actions: [{ name: 'ingest', inputSchema: { type: 'object' } }],
            runtime: { handlerKinds: ['root'] },
          },
        }]);
      }
      if (/FROM operations/i.test(statement)) {
        return result<T>([{
          id: '7a000000-0000-4000-8000-000000000009',
          tenant_id: TENANT,
          business_id: 'demo',
          business_version: '1.0.0',
          action: 'ingest',
          state: 'ACCEPTED',
          state_version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deadline_at: null,
        }]);
      }
      return result<T>([]);
    },
    tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({
      query: async (statement: string, params: unknown[] = []) => {
        calls.push({ sql: statement, params });
        return result([]);
      },
    }),
    close: async () => undefined,
  } as unknown as Db;
  return { db, calls };
}

function pinnedProfile() {
  return {
    mode: 'pinned' as const,
    profileId: PROFILE_ID,
    revision: REVISION,
    bindings: { slot: 'connector-1@2' },
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH' as const,
      allowedFileExtensions: '',
      connectionsOverride: [],
      fileUrlAuthConfig: null,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: {},
    bullMqPriority: 1,
  };
}

function overrideRow(connectionId: string, stepId: string, promptOverride: string | null): PromptOverrideRead {
  return {
    connectionId,
    apiKeyId: KEY,
    endpointSlug: 'ingest',
    stepId,
    promptOverride,
    isActive: true,
    updatedAt: new Date().toISOString(),
  };
}

function service(db: Db, profile: unknown, promptOverrides?: PromptOverrideService) {
  const profiles = {
    resolveBinding: async () => ({ mode: 'legacy' as const }),
    resolveEffectiveProfile: async () => profile,
  } as unknown as ProfileService;
  return createSubmissionService(db, {} as RegistryService, profiles, {
    ...(promptOverrides ? { promptOverrides } : {}),
  });
}

function ctx() {
  return {
    tenantId: TENANT,
    apiKeyId: KEY,
    businessId: 'demo',
    action: 'ingest',
    submission: { input: { text: 'inline only' } },
  };
}

function mustCall(calls: Call[], pattern: RegExp): Call {
  const hit = calls.find((call) => pattern.test(call.sql));
  if (!hit) throw new Error(`no statement matched ${pattern}`);
  return hit;
}

function expectedRevision(connectionId: string, stepId: string, content: string): string {
  return 'sha256:' + createHash('sha256').update(`${connectionId}|${stepId}|${content}`).digest('hex');
}

function pinParam(calls: Call[]): unknown {
  return mustCall(calls, /INSERT INTO operations/i).params[16];
}

describe('P745-PRODUCER — submit pins non-secret revision markers', () => {
  it('pins sorted markers for content-bearing rows, skipping cleared rows', async () => {
    const rows = [
      overrideRow(CONN_B, 'step-2', 'PROMPT-B2'),
      overrideRow(CONN_A, 'extract_invoice', 'PROMPT-A'),
      overrideRow(CONN_A, '_default', 'PROMPT-DEFAULT'),
      overrideRow(CONN_A, 'cleared-step', null),
    ];
    const listFor = jest.fn(async () => rows);
    const { db, calls } = makeDb();
    await service(db, pinnedProfile(), { listFor } as unknown as PromptOverrideService).submit(ctx());

    expect(listFor).toHaveBeenCalledTimes(1);
    expect(listFor).toHaveBeenCalledWith(KEY, 'ingest', TENANT);

    const pin = JSON.parse(String(pinParam(calls))) as Array<Record<string, string>>;
    expect(pin).toEqual([
      { connectionId: CONN_A, stepId: '_default', revision: expectedRevision(CONN_A, '_default', 'PROMPT-DEFAULT') },
      { connectionId: CONN_A, stepId: 'extract_invoice', revision: expectedRevision(CONN_A, 'extract_invoice', 'PROMPT-A') },
      { connectionId: CONN_B, stepId: 'step-2', revision: expectedRevision(CONN_B, 'step-2', 'PROMPT-B2') },
    ]);
    // Cleared rows pin nothing: no marker may claim a revision that does not exist.
    expect(pin.some((m) => m.stepId === 'cleared-step')).toBe(false);
  });

  it('round-trips: the stored pin maps to composite-key revisions at claim', async () => {
    const rows = [
      overrideRow(CONN_A, 'extract_invoice', 'PROMPT-A'),
      overrideRow(CONN_A, '_default', 'PROMPT-DEFAULT'),
    ];
    const { db, calls } = makeDb();
    await service(db, pinnedProfile(), { listFor: async () => rows } as unknown as PromptOverrideService).submit(ctx());

    const map = parsePromptRevisionsPin(JSON.parse(String(pinParam(calls))));
    expect(map).toEqual({
      [`${CONN_A}::_default`]: expectedRevision(CONN_A, '_default', 'PROMPT-DEFAULT'),
      [`${CONN_A}::extract_invoice`]: expectedRevision(CONN_A, 'extract_invoice', 'PROMPT-A'),
    });
  });

  it('identical buckets pin byte-identical JSON regardless of row order', async () => {
    const forward = [
      overrideRow(CONN_A, 'extract_invoice', 'PROMPT-A'),
      overrideRow(CONN_B, 'step-1', 'PROMPT-B1'),
    ];
    const reverse = [forward[1]!, forward[0]!];
    const first = makeDb();
    await service(first.db, pinnedProfile(), { listFor: async () => forward } as unknown as PromptOverrideService).submit(ctx());
    const second = makeDb();
    await service(second.db, pinnedProfile(), { listFor: async () => reverse } as unknown as PromptOverrideService).submit(ctx());
    expect(String(pinParam(first.calls))).toBe(String(pinParam(second.calls)));
  });

  it('no override rows → empty pin → claim map {}', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile(), { listFor: async () => [] } as unknown as PromptOverrideService).submit(ctx());
    expect(String(pinParam(calls))).toBe('[]');
    expect(parsePromptRevisionsPin(JSON.parse(String(pinParam(calls))))).toEqual({});
  });

  it('legacy-mode submit keeps the NULL pin and never reads the overrides table', async () => {
    const listFor = jest.fn(async () => [overrideRow(CONN_A, 'extract_invoice', 'PROMPT-A')]);
    const { db, calls } = makeDb();
    await service(db, { mode: 'legacy' }, { listFor } as unknown as PromptOverrideService).submit(ctx());
    expect(pinParam(calls)).toBeNull();
    expect(listFor).not.toHaveBeenCalled();
  });

  it('pinned submit without the promptOverrides seam keeps the NULL pin (feature dark)', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile()).submit(ctx());
    expect(pinParam(calls)).toBeNull();
  });
});

describe('P745-PRODUCER — claim-side pin parser', () => {
  it('maps markers to connectionId::stepId keys (incl. _default)', () => {
    const revA = expectedRevision(CONN_A, 'extract_invoice', 'x');
    const revD = expectedRevision(CONN_A, '_default', 'y');
    const map = parsePromptRevisionsPin([
      { connectionId: CONN_A, stepId: 'extract_invoice', revision: revA },
      { connectionId: CONN_A, stepId: '_default', revision: revD },
    ]);
    expect(map).toEqual({
      [`${CONN_A}::extract_invoice`]: revA,
      [`${CONN_A}::_default`]: revD,
    });
  });

  it('NULL / undefined keep the legacy {} wire shape', () => {
    expect(parsePromptRevisionsPin(null)).toEqual({});
    expect(parsePromptRevisionsPin(undefined)).toEqual({});
  });

  it.each([
    ['not an array', { connectionId: CONN_A, stepId: 's', revision: 'sha256:' + 'a'.repeat(64) }],
    ['non-object marker', ['plain-string']],
    ['missing fields', [{ connectionId: CONN_A }]],
    ['bad revision format', [{ connectionId: CONN_A, stepId: 's', revision: 'v7' }]],
    ['empty connectionId', [{ connectionId: '', stepId: 's', revision: 'sha256:' + 'a'.repeat(64) }]],
    [
      'duplicate composite key',
      [
        { connectionId: CONN_A, stepId: 's', revision: 'sha256:' + 'a'.repeat(64) },
        { connectionId: CONN_A, stepId: 's', revision: 'sha256:' + 'b'.repeat(64) },
      ],
    ],
  ])('fails closed on malformed pin (%s) with INVALID_SCHEMA', (_label, raw) => {
    expect(() => parsePromptRevisionsPin(raw)).toThrow(
      expect.objectContaining({ code: 'INVALID_SCHEMA' })
    );
  });

  it('keeps the same step id on two connections as two distinct keys', () => {
    const revA = expectedRevision(CONN_A, 'step', 'x');
    const revB = expectedRevision(CONN_B, 'step', 'x');
    const map = parsePromptRevisionsPin([
      { connectionId: CONN_A, stepId: 'step', revision: revA },
      { connectionId: CONN_B, stepId: 'step', revision: revB },
    ]);
    expect(Object.keys(map)).toEqual([`${CONN_A}::step`, `${CONN_B}::step`]);
  });
});

describe('P745-PRODUCER — old operations stay pinned', () => {
  it('a later override edit changes NEW submits while the stored old pin is untouched', async () => {
    const before = [overrideRow(CONN_A, 'extract_invoice', 'PROMPT-BEFORE')];
    const first = makeDb();
    await service(first.db, pinnedProfile(), { listFor: async () => before } as unknown as PromptOverrideService).submit(ctx());
    const oldPinJson = String(pinParam(first.calls));

    // Admin edits the override content afterwards; a NEW submit re-reads.
    const after = [overrideRow(CONN_A, 'extract_invoice', 'PROMPT-AFTER')];
    const second = makeDb();
    await service(second.db, pinnedProfile(), { listFor: async () => after } as unknown as PromptOverrideService).submit(ctx());
    const newPinJson = String(pinParam(second.calls));

    expect(newPinJson).not.toBe(oldPinJson);
    // The OLD operation's stored pin still maps to the revision it captured —
    // the claim reads the row, never the live table.
    expect(parsePromptRevisionsPin(JSON.parse(oldPinJson))[`${CONN_A}::extract_invoice`]).toBe(
      expectedRevision(CONN_A, 'extract_invoice', 'PROMPT-BEFORE')
    );
    expect(parsePromptRevisionsPin(JSON.parse(newPinJson))[`${CONN_A}::extract_invoice`]).toBe(
      expectedRevision(CONN_A, 'extract_invoice', 'PROMPT-AFTER')
    );
  });

  it('buildPromptRevisionsPin is pure: same rows → same markers', () => {
    const rows = [overrideRow(CONN_A, 's', 'x'), overrideRow(CONN_A, 's2', null)];
    expect(buildPromptRevisionsPin(rows)).toEqual(buildPromptRevisionsPin(rows));
    expect(buildPromptRevisionsPin(rows)).toHaveLength(1);
  });
});
