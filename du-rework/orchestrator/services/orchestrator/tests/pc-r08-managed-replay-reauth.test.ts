import { randomUUID } from 'node:crypto';
import {
  PC09_BUSINESS,
  PC09_VERSION_V2,
  buildCohortC2,
  createPc09Tenant,
  pc09SelectorFor,
  pc09Submission,
  seedPc09Business,
  type Pc09Cohort,
} from './helpers/profile-control-plane-harness';
import { withScratchDatabase, type ScratchDatabase } from './helpers/scratch-db';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createRegistryService } from '../src/modules/registry/registry';
import { createSubmissionService, loadOperationView } from '../src/modules/operations/submission';
import type { TenantDefaultsSnapshot } from '@du/contracts';
import type { MetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import { tenantDefaultsSnapshotDigest } from '../src/modules/global-settings/snapshot';

/**
 * PC-R08 — a managed replay must be reauthorized, and PC-R04 — the submission
 * fingerprint must carry the prompt/AI/defaults snapshot.
 *
 * PC-R08: the replay paths answered from an idempotency row before current
 * authority was consulted, so a key whose root grant was revoked could still
 * receive a `replayed: true` acknowledgement. Every replay return now runs
 * `assertManagedReplayAuthorized` first.
 *
 * PC-R04: the fingerprint carried only the AI revision, so a prompt-only
 * publish (`promptRevision` + digest change, `aiRevision` unchanged) could not
 * invalidate a stale preview. It now carries AI revision, prompt revision and
 * the admitted snapshot digest.
 *
 * Window-gated: without `DU_LIVE_INFRA=1` every test self-skips.
 */

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('pc-r08-managed-replay-reauth.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.');
}

const ACTION = 'extract' as const;

/**
 * Build a snapshot whose settingsDigest is the digest the admission path
 * recomputes. A hand-written digest is rejected before any fingerprint is
 * produced, so the fixture must use the same helper the service does.
 */
function defaultsSnapshot(promptRevision: number | null, aiRevision: number | null): TenantDefaultsSnapshot {
  const content = {
    aiRevision,
    promptRevision,
    ai: { provider: null, model: null, connectorId: null, connectorRevision: null },
    prompts: { image: null, pdf: null, docx: null, compare: null, generate: null },
  };
  return { ...content, settingsDigest: tenantDefaultsSnapshotDigest(content) } as TenantDefaultsSnapshot;
}

liveDescribe('PC-R08 managed replay reauthorization', () => {
  let scratch: ScratchDatabase;
  let submission: ReturnType<typeof createSubmissionService>;
  let submissionWithDefaults: ReturnType<typeof createSubmissionService>;
  let cohort: Pc09Cohort;
  let tenantId: string;
  let defaults: TenantDefaultsSnapshot = defaultsSnapshot(1, 1);

  const groupId = () => cohort.groupId!;
  const apiKeyId = () => cohort.keys[0]!.apiKeyId;
  const child = () => cohort.children.find((candidate) => candidate.action === ACTION)!;

  async function grantState(state: 'ACTIVE' | 'REVOKED'): Promise<void> {
    await scratch.db.query(
      `UPDATE profile_group_api_keys
          SET state=$2,
              revoked_at = CASE WHEN $2='REVOKED' THEN now() ELSE NULL END,
              revoked_by = CASE WHEN $2='REVOKED' THEN 'pc-r08' ELSE NULL END
        WHERE api_key_id=$1`,
      [apiKeyId(), state],
    );
  }

  async function keyStatus(status: 'ACTIVE' | 'REVOKED'): Promise<void> {
    await scratch.db.query('UPDATE api_keys SET status=$2 WHERE id=$1', [apiKeyId(), status]);
  }

  async function childEnabled(enabled: boolean): Promise<void> {
    const pin = child();
    await scratch.db.query(
      'UPDATE profile_bindings SET enabled=$3 WHERE profile_id=$1 AND revision=$2',
      [pin.profileId, pin.revision, enabled],
    );
  }

  function manageV1(idempotencyKey: string, input: Record<string, unknown> = { note: 'pc-r08' }) {
    const pin = child();
    return submission.submit({
      tenantId,
      apiKeyId: apiKeyId(),
      businessId: PC09_BUSINESS,
      action: ACTION,
      profileEndpointSlug: pin.endpointSlug,
      idempotencyKey,
      submission: pc09Submission(input),
    });
  }

  beforeAll(async () => {
    scratch = await withScratchDatabase({ suite: 'pc-r08-replay' });
    await seedPc09Business(scratch.db, { activeVersion: PC09_VERSION_V2 });
    tenantId = await createPc09Tenant(scratch.db, 'r08');
    cohort = await buildCohortC2(scratch.db, {
      tenantId,
      businessVersion: PC09_VERSION_V2,
      actions: [ACTION],
    });
    const profiles = createProfileService(scratch.db, { cryptoEnv: {} });
    // The v1 replay tests need NO tenant-defaults snapshot: a non-null snapshot
    // requires metadata encryption at admission. The v2 fingerprint tests do
    // need one, so they get their own service with a deterministic envelope.
    submission = createSubmissionService(scratch.db, createRegistryService(scratch.db), profiles, { cryptoEnv: {} });
    const cryptoDouble = {
      isSealed: (value: unknown): boolean =>
        typeof value === 'object' && value !== null && '__sealed' in (value as Record<string, unknown>),
      seal: async (value: unknown) => ({ __sealed: JSON.stringify(value) }),
      open: async (sealed: unknown) => JSON.parse(String((sealed as { __sealed: string }).__sealed)),
      readStored: async (value: unknown) => value,
    } as unknown as MetadataCrypto;
    submissionWithDefaults = createSubmissionService(scratch.db, createRegistryService(scratch.db), profiles, {
      cryptoEnv: {},
      metadataCrypto: cryptoDouble,
      globalSettings: { getTenantDefaultsSnapshot: async () => defaults },
    });
  }, 300_000);

  afterAll(async () => {
    await scratch?.close();
  }, 60_000);

  beforeEach(async () => {
    await grantState('ACTIVE');
    await keyStatus('ACTIVE');
    await childEnabled(true);
    defaults = defaultsSnapshot(1, 1);
  });

  test('a managed v1 submit succeeds and replays the same operation', async () => {
    const key = `r08-${randomUUID()}`;
    const first = await manageV1(key);
    expect(first.replayed).toBe(false);

    const replay = await manageV1(key);
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
  });

  test('revoking the root grant denies the replay but leaves the result readable', async () => {
    const key = `r08-${randomUUID()}`;
    const first = await manageV1(key);

    await grantState('REVOKED');

    await expect(manageV1(key)).rejects.toMatchObject({ status: 409, code: 'GRANT_REVOKED' });

    // Historical reads are a different authority decision: the key is still
    // ACTIVE, so the admitted operation remains readable.
    const view = await loadOperationView(scratch.db, first.operation.id);
    expect(view.id).toBe(first.operation.id);

    // Restoring authority restores replay, and it is the SAME operation.
    await grantState('ACTIVE');
    const replayed = await manageV1(key);
    expect(replayed).toMatchObject({ replayed: true });
    expect(replayed.operation.id).toBe(first.operation.id);
  });

  test('a globally revoked key is denied on replay', async () => {
    const key = `r08-${randomUUID()}`;
    await manageV1(key);

    await keyStatus('REVOKED');
    await expect(manageV1(key)).rejects.toMatchObject({ status: 409, code: 'API_KEY_REVOKED' });
  });

  test('a disabled function is denied on replay', async () => {
    const key = `r08-${randomUUID()}`;
    await manageV1(key);

    await childEnabled(false);
    await expect(manageV1(key)).rejects.toMatchObject({ status: 409, code: 'ENDPOINT_DISABLED' });
  });

  test('permitted configuration drift still replays', async () => {
    const key = `r08-${randomUUID()}`;
    const first = await manageV1(key);

    // A config save bumps the group's access version without touching this
    // key's authority: the replay must survive it (RCR-03/T-SUB-04).
    await scratch.db.query('UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id=$1', [groupId()]);

    const replay = await manageV1(key);
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.operation.id).toBe(first.operation.id);
  });

  test('a changed body under the same key is an idempotency conflict', async () => {
    const key = `r08-${randomUUID()}`;
    await manageV1(key);

    await expect(manageV1(key, { note: 'different body' }))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('PC-R04: a prompt-only revision change invalidates a stale v2 fingerprint', async () => {
    const pin = child();
    const request = {
      tenantId,
      apiKeyId: apiKeyId(),
      groupId: groupId(),
      selector: pc09SelectorFor(cohort, pin),
      submission: pc09Submission({ note: 'pc-r04' }),
    };

    defaults = defaultsSnapshot(1, 1);
    const previewAi1Prompt1 = await submissionWithDefaults.previewProfileV2(request);

    // Prompt-only publish: the AI revision does not move.
    defaults = defaultsSnapshot(2, 1);
    const previewAi1Prompt2 = await submissionWithDefaults.previewProfileV2(request);

    expect(previewAi1Prompt2.resolutionFingerprint).not.toBe(previewAi1Prompt1.resolutionFingerprint);

    // The stale preview is refused at submit time.
    await expect(submissionWithDefaults.submitProfileV2({
      ...request,
      resolutionFingerprint: previewAi1Prompt1.resolutionFingerprint,
      idempotencyKey: `r04-${randomUUID()}`,
    })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });

    const accepted = await submissionWithDefaults.submitProfileV2({
      ...request,
      resolutionFingerprint: previewAi1Prompt2.resolutionFingerprint,
      idempotencyKey: `r04-${randomUUID()}`,
    });
    expect(accepted.operation.id).toBeTruthy();

    // And the fingerprint is a function of the AI revision too.
    defaults = defaultsSnapshot(2, 2);
    const previewAi2Prompt2 = await submissionWithDefaults.previewProfileV2(request);
    expect(previewAi2Prompt2.resolutionFingerprint).not.toBe(previewAi1Prompt2.resolutionFingerprint);
  });

  test('PC-R04: the same defaults snapshot yields the same fingerprint', async () => {
    const pin = child();
    const request = {
      tenantId,
      apiKeyId: apiKeyId(),
      groupId: groupId(),
      selector: pc09SelectorFor(cohort, pin),
      submission: pc09Submission({ note: 'stable' }),
    };
    defaults = defaultsSnapshot(3, 2);
    const first = await submissionWithDefaults.previewProfileV2(request);
    const second = await submissionWithDefaults.previewProfileV2(request);
    expect(second.resolutionFingerprint).toBe(first.resolutionFingerprint);
  });
});
