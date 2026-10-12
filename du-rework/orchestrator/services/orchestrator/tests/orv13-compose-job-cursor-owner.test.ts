import type { AuditService } from '../src/modules/audit/audit';
import type { Db } from '../src/db/db';
import { createComposeOperationsService } from '../src/modules/compose-operations/service';

const NEWER_JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLDER_JOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function jobRow(input: { jobId: string; createdAt: string; cursorCreatedAt: string }): Record<string, unknown> {
  return {
    job_id: input.jobId,
    preview_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    host_id: 'host-one',
    project_id: 'project-one',
    action: 'restart_service',
    release_id: null,
    service_id: 'api',
    target_release_digest: null,
    target_services: ['api'],
    reason: 'cursor pagination fixture',
    actor_label: 'admin-session',
    state: 'SUCCEEDED',
    state_version: 2,
    expected_target_revision: 0,
    target_revision: 1,
    created_at: new Date(input.createdAt),
    cursor_created_at: input.cursorCreatedAt,
    started_at: null,
    completed_at: null,
    claim_expires_at: null,
    observed_before_digest: 'a'.repeat(64),
    start_expected_observed_digest: 'a'.repeat(64),
    observed_before: [],
    observed_after: null,
    observed_after_digest: null,
    per_service_outcomes: [],
    uncertain_reason: null,
  };
}

describe('UI13 Compose job cursor precision', () => {
  test('keeps PostgreSQL microseconds across descending limit-one pages', async () => {
    const exactNewer = '2026-10-11T17:00:00.000456Z';
    const exactOlder = '2026-10-11T17:00:00.000123Z';
    const pages = [
      [
        jobRow({ jobId: NEWER_JOB, createdAt: exactNewer, cursorCreatedAt: exactNewer }),
        jobRow({ jobId: OLDER_JOB, createdAt: exactOlder, cursorCreatedAt: exactOlder }),
      ],
      [jobRow({ jobId: OLDER_JOB, createdAt: exactOlder, cursorCreatedAt: exactOlder })],
    ];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const rows = pages.shift() ?? [];
        return { rows, rowCount: rows.length };
      },
      tx: async (fn: (client: { query: () => Promise<{ rows: never[]; rowCount: number }> }) => Promise<unknown>) => fn({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
      close: async () => undefined,
      pool: {},
    } as unknown as Db;
    const audit = { record: async () => undefined } as unknown as AuditService;
    const service = createComposeOperationsService(db, audit);
    const query = { hostId: 'host-one', limit: 1 };

    const firstPage = await service.listJobs(query);
    expect(firstPage.items.map((job) => job.jobId)).toEqual([NEWER_JOB]);
    expect(firstPage.hasMore).toBe(true);
    expect(calls[0]!.sql).toMatch(/to_char\(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS cursor_created_at/);
    const cursor = JSON.parse(Buffer.from(firstPage.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(cursor['createdAt']).toBe(exactNewer);

    const secondPage = await service.listJobs({ ...query, cursor: firstPage.nextCursor });
    expect(secondPage.items.map((job) => job.jobId)).toEqual([OLDER_JOB]);
    expect(secondPage.hasMore).toBe(false);
    expect(calls[1]!.sql).toMatch(/\(created_at,job_id\) < \(\$\d+::timestamptz,\$\d+::uuid\)/);
    expect(calls[1]!.params).toContain(exactNewer);

    const truncatedCursor = Buffer.from(JSON.stringify({ ...cursor, createdAt: '2026-10-11T17:00:00.000Z' }), 'utf8').toString('base64url');
    await expect(service.listJobs({ ...query, cursor: truncatedCursor })).rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    await expect(service.listJobs({ hostId: 'host-two', limit: 1, cursor: firstPage.nextCursor }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(2);
  });
});
