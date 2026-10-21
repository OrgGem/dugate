import { createHash, createHmac, randomUUID } from 'node:crypto';
import { canonicalLegacyWorkflowPinBytes, parseLegacyWorkflowSchema } from '@du/contracts';
import {
  PC09_BUSINESS,
  PC09_VERSION_V2,
  buildCohortC2,
  createPc09Tenant,
  pc09Submission,
  seedPc09Business,
  type Pc09Cohort,
} from './helpers/profile-control-plane-harness';
import { withScratchDatabase, type ScratchDatabase } from './helpers/scratch-db';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createRegistryService } from '../src/modules/registry/registry';
import { createSubmissionService } from '../src/modules/operations/submission';
import { retryOperation } from '../src/modules/operations/retry';
import { createMetadataCrypto, type MetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { provisionLegacyWorkflowSchema } from '../src/modules/workflow-schemas/workflow-schemas';
import { tenantDefaultsSnapshotDigest } from '../src/modules/global-settings/snapshot';
import type { TenantDefaultsSnapshot } from '@du/contracts';

/**
 * PC-R02 — a workflow group function is an EXECUTION pin, not a label.
 *
 * The preview must resolve the registry snapshot behind the member's
 * `workflowRevision`, fold its digest into the resolution fingerprint, and
 * admission must persist the identity on the operation so the worker and a
 * retry can prove which workflow body ran.
 *
 * The identity is the member's `functionId` (the catalog declares workflow
 * functions by manifest action name) and the revision must still be ACTIVE:
 * a retired revision is not executable, so preview fails closed.
 *
 * Window-gated: without `DU_LIVE_INFRA=1` every test self-skips.
 */

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('pc-r02-workflow-execution-pins.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.');
}

const ACTION = 'ingest' as const;
const WORKFLOW_SLUG = 'discover';

/** Offline AES-less key provider: deterministic keystream XOR, enough for AEAD round-trips. */
function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'pc-r02').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}
function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}
function makeKeyProvider(): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + '#' + version, input.dek.length)).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + '#' + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> { return wrapped; },
  };
}

const WORKFLOW_SCHEMA = {
  slug: WORKFLOW_SLUG,
  name: 'Discovery workflow',
  nodes: [{ id: 'start', type: 'input', key: 'document' }],
  flow: ['start'],
};

function snapshot(aiRevision: number, promptRevision: number): TenantDefaultsSnapshot {
  const content = {
    aiRevision,
    promptRevision,
    ai: { provider: null, model: null, connectorId: null, connectorRevision: null },
    prompts: { image: null, pdf: null, docx: null, compare: null, generate: null },
  };
  return { ...content, settingsDigest: tenantDefaultsSnapshotDigest(content) } as TenantDefaultsSnapshot;
}

interface WorkflowRow {
  workflow_schema_slug: string | null;
  workflow_schema_revision: number | null;
  workflow_schema_digest: string | null;
  connector_recipe_pins_ref: unknown;
}

liveDescribe('PC-R02 workflow execution pins', () => {
  let scratch: ScratchDatabase;
  let crypto: MetadataCrypto;
  let submission: ReturnType<typeof createSubmissionService>;
  let cohort: Pc09Cohort;
  let tenantId: string;
  let childProfileId: string;
  /** Finding 3: the defaults the preview will fingerprint, and a divergent one. */
  let defaultsCalls = 0;
  let defaultsForFingerprint: TenantDefaultsSnapshot;
  let defaultsAfterPreview: TenantDefaultsSnapshot;

  const groupId = () => cohort.groupId!;
  const apiKeyId = () => cohort.keys[0]!.apiKeyId;

  function selectorFor(functionId: string) {
    return {
      businessId: PC09_BUSINESS,
      businessVersion: PC09_VERSION_V2,
      action: ACTION,
      functionId,
    };
  }

  function request(functionId = WORKFLOW_SLUG, note = 'pc-r02') {
    return {
      tenantId,
      apiKeyId: apiKeyId(),
      groupId: groupId(),
      selector: selectorFor(functionId),
      submission: pc09Submission({ note }),
    };
  }

  async function pinMember(memberFunctionId: string, revision: number): Promise<void> {
    await scratch.db.query(
      `UPDATE profile_group_members
          SET function_kind='workflow', function_id=$2, endpoint_slug=NULL, workflow_revision=$3
        WHERE group_id=$1 AND profile_id=$4`,
      [groupId(), memberFunctionId, revision, childProfileId],
    );
  }

  async function workflowRow(operationId: string): Promise<WorkflowRow> {
    const result = await scratch.db.query<WorkflowRow>(
      `SELECT workflow_schema_slug, workflow_schema_revision, workflow_schema_digest, connector_recipe_pins_ref
         FROM operations WHERE id=$1`,
      [operationId],
    );
    return result.rows[0]!;
  }

  async function operationCount(): Promise<number> {
    const result = await scratch.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM operations WHERE tenant_id=$1',
      [tenantId],
    );
    return Number(result.rows[0]!.n);
  }

  beforeAll(async () => {
    scratch = await withScratchDatabase({ suite: 'pc-r02-workflow' });
    crypto = createMetadataCrypto(adaptKeyProviderForMetadata(makeKeyProvider()) as MetadataKeyProvider, 'pc-r02');
    await seedPc09Business(scratch.db, { activeVersion: PC09_VERSION_V2 });
    tenantId = await createPc09Tenant(scratch.db, 'r02');
    cohort = await buildCohortC2(scratch.db, {
      tenantId,
      businessVersion: PC09_VERSION_V2,
      actions: [ACTION],
    });
    childProfileId = cohort.children[0]!.profileId;
    const profiles = createProfileService(scratch.db, { cryptoEnv: {} });
    submission = createSubmissionService(scratch.db, createRegistryService(scratch.db), profiles, {
      cryptoEnv: {},
      metadataCrypto: crypto,
      // Finding 3: the FIRST TWO reads (preview, then submit-time resolution)
      // return the fingerprinted snapshot; any THIRD read (the old admission
      // path) would return the divergent one.
      globalSettings: {
        getTenantDefaultsSnapshot: async () => {
          defaultsCalls += 1;
          return defaultsCalls <= 2 ? defaultsForFingerprint : defaultsAfterPreview;
        },
      },
    });
    await provisionLegacyWorkflowSchema(scratch.db, { tenantId, schema: WORKFLOW_SCHEMA }, crypto);


  }, 300_000);

  afterAll(async () => {
    await scratch?.close();
  }, 60_000);

  beforeEach(async () => {
    defaultsCalls = 0;
    defaultsForFingerprint = snapshot(1, 1);
    defaultsAfterPreview = snapshot(9, 9);
    await pinMember(WORKFLOW_SLUG, 1);
    // Exactly one active revision per (tenant, slug): the partial unique index
    // enforces it, so the reset must demote the newer revisions, not promote all.
    await scratch.db.query(
      `UPDATE legacy_workflow_schemas
          SET status = CASE WHEN revision=1 THEN 'active' ELSE 'retired' END
        WHERE tenant_id=$1 AND slug=$2`,
      [tenantId, WORKFLOW_SLUG],
    );
    await scratch.db.query(
      "UPDATE profile_group_api_keys SET state='ACTIVE', revoked_at=NULL, revoked_by=NULL WHERE api_key_id=$1",
      [apiKeyId()],
    );
    await scratch.db.query("UPDATE api_keys SET status='ACTIVE' WHERE id=$1", [apiKeyId()]);
  });

  test('preview resolves the registry snapshot and folds its digest into the fingerprint', async () => {
    const preview = await submission.previewProfileV2(request());
    const row = await scratch.db.query<{ digest: string; revision: number }>(
      'SELECT digest, revision FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2',
      [tenantId, WORKFLOW_SLUG],
    );
    expect(row.rows[0]!.revision).toBe(1);
    expect(preview.resolutionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The DIGEST — not just the revision number — is a fingerprint input.
    // Simulate a registry rewrite at the SAME revision: new sealed body, new
    // canonical digest. Without the digest in the payload the fingerprint would
    // be byte-identical here and a stale preview would still submit.
    const rewritten = { ...WORKFLOW_SCHEMA, description: 'rewritten body' };
    // The stored value is the registry ENVELOPE (schema + slot map + egress
    // origins), sealed under the catalog slot — not the bare schema.
    const parsedRewritten = parseLegacyWorkflowSchema(rewritten);
    const sealed = await crypto.seal(
      { schema: parsedRewritten, connectorSlotMap: {}, approvedEgressOrigins: [] },
      { tenantId, slot: 'legacy_workflow_schemas.schema_ref', refId: `${WORKFLOW_SLUG}:1` },
    );
    // The registry digests the PARSED schema (defaults/normalisation included),
    // so the fixture must do the same or the row fails its own integrity check.
    const rewrittenDigest = `sha256:${createHash('sha256')
      .update(canonicalLegacyWorkflowPinBytes(parsedRewritten, {}, []))
      .digest('hex')}`;
    await scratch.db.query(
      `UPDATE legacy_workflow_schemas SET schema_ref=$3, digest=$4
        WHERE tenant_id=$1 AND slug=$2 AND revision=1`,
      [tenantId, WORKFLOW_SLUG, sealed, rewrittenDigest],
    );

    const second = await submission.previewProfileV2(request());
    expect(second.resolutionFingerprint).not.toBe(preview.resolutionFingerprint);
  });

  test('submit persists slug, revision and digest on the operation', async () => {
    const preview = await submission.previewProfileV2(request());
    const accepted = await submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-submit-${randomUUID()}`,
    });

    const row = await workflowRow(accepted.operation.id);
    expect(row.workflow_schema_slug).toBe(WORKFLOW_SLUG);
    expect(row.workflow_schema_revision).toBe(1);
    // The persisted digest is the COMPILED pin digest (schema + recipe pins),
    // not the bare catalog digest — the runtime validates the compiled carrier.
    expect(row.workflow_schema_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The fixture schema declares no connector node, so the compiled recipe map
    // is empty — but it is still SEALED and written, which is the carrier the
    // runtime opens under the operation AAD.
    expect(row.connector_recipe_pins_ref).not.toBeNull();
    expect(crypto.isSealed(row.connector_recipe_pins_ref)).toBe(true);
  });

  test('retiring the revision between preview and submit denies with zero rows', async () => {
    const preview = await submission.previewProfileV2(request());
    await scratch.db.query(
      "UPDATE legacy_workflow_schemas SET status='retired' WHERE tenant_id=$1 AND slug=$2",
      [tenantId, WORKFLOW_SLUG],
    );

    const before = await operationCount();
    await expect(submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-retired-${randomUUID()}`,
    })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
    expect(await operationCount()).toBe(before);
  });

  test('moving the member to another revision invalidates the preview', async () => {
    const preview = await submission.previewProfileV2(request());
    await provisionLegacyWorkflowSchema(
      scratch.db,
      { tenantId, schema: { ...WORKFLOW_SCHEMA, description: 'newer body' } },
      crypto,
    );
    await pinMember(WORKFLOW_SLUG, 2);

    await expect(submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-stale-${randomUUID()}`,
    })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
  });

  test('retry preserves the original workflow pins', async () => {
    const preview = await submission.previewProfileV2(request());
    const accepted = await submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-retry-${randomUUID()}`,
    });
    const original = await workflowRow(accepted.operation.id);
    await scratch.db.query("UPDATE operations SET state='FAILED', error_code='PROVIDER_ERROR' WHERE id=$1", [
      accepted.operation.id,
    ]);

    const retried = await scratch.db.tx((client) => retryOperation(client, accepted.operation.id, tenantId, crypto));
    expect(retried.replayed).toBe(false);
    const copy = await workflowRow(String(retried.operationId));

    expect(copy.workflow_schema_slug).toBe(original.workflow_schema_slug);
    expect(copy.workflow_schema_revision).toBe(original.workflow_schema_revision);
    expect(copy.workflow_schema_digest).toBe(original.workflow_schema_digest);
    expect(copy.workflow_schema_slug).toBe(WORKFLOW_SLUG);
  });

  test('Finding 1: a v2 workflow member does not wrap the task payload in the legacy carrier', async () => {
    const preview = await submission.previewProfileV2(request());
    const accepted = await submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-f1-${randomUUID()}`,
    });
    const task = await scratch.db.query<{ id: string; payload_ref: unknown }>(
      'SELECT id, payload_ref FROM tasks WHERE operation_id=$1',
      [accepted.operation.id],
    );
    const row = task.rows[0]!;
    const payload = await crypto.readStored(row.payload_ref, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: row.id,
    }, true) as Record<string, unknown>;

    // The compiled pin still lands on the operation columns (PC-R02)...
    expect((await workflowRow(accepted.operation.id)).workflow_schema_slug).toBe(WORKFLOW_SLUG);
    // ...but a standard handler receives its DIRECT input: the effective input
    // map itself, never the `{ input, legacyWorkflowSchema }` carrier.
    expect(Object.hasOwn(payload, 'legacyWorkflowSchema')).toBe(false);
    expect(Object.hasOwn(payload, 'input')).toBe(false);
    expect(payload.note).toBe('pc-r02');
  });

  test('Finding 3: admission seals the defaults snapshot the fingerprint covered', async () => {
    defaultsCalls = 0;
    const preview = await submission.previewProfileV2(request());
    const accepted = await submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-f3-${randomUUID()}`,
    });

    const row = await scratch.db.query<{ tenant_defaults_ref: unknown }>(
      'SELECT tenant_defaults_ref FROM operations WHERE id=$1',
      [accepted.operation.id],
    );
    const sealed = row.rows[0]!.tenant_defaults_ref;
    expect(sealed).not.toBeNull();
    const opened = await crypto.readStored(sealed, {
      tenantId,
      slot: 'operations.tenant_defaults_ref',
      refId: accepted.operation.id,
    }, true) as TenantDefaultsSnapshot;

    // The fingerprinted snapshot, never the divergent one a third read would see.
    expect(opened.aiRevision).toBe(1);
    expect(opened.promptRevision).toBe(1);
    // Exactly two reads: preview + submit-time resolution. No out-of-band third.
    expect(defaultsCalls).toBe(2);
  });

  test('Finding 5: a coalesced retry returns the in-flight execution even when the input expired', async () => {
    const preview = await submission.previewProfileV2(request());
    const accepted = await submission.submitProfileV2({
      ...request(),
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-f5-${randomUUID()}`,
    });
    await scratch.db.query("UPDATE operations SET state='FAILED', error_code='PROVIDER_ERROR' WHERE id=$1", [
      accepted.operation.id,
    ]);

    const first = await scratch.db.tx((client) => retryOperation(client, accepted.operation.id, tenantId, crypto));
    expect(first.replayed).toBe(false);

    // The ORIGINAL execution input becomes unavailable (its root task pointer is
    // gone) while the retry is still in flight. A fresh preparation would now
    // throw RETRY_INPUT_UNAVAILABLE; the coalesced answer must be produced first.
    await scratch.db.query('UPDATE operations SET root_task_id=NULL WHERE id=$1', [accepted.operation.id]);

    const second = await scratch.db.tx((client) => retryOperation(client, accepted.operation.id, tenantId, crypto));
    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);
  });

  test('an ordinary endpoint function keeps workflow null', async () => {
    // Restore the member to an endpoint function for this case only.
    const pin = cohort.children[0]!;
    await scratch.db.query(
      `UPDATE profile_group_members
          SET function_kind='endpoint', function_id=$2, endpoint_slug=$3, workflow_revision=NULL
        WHERE group_id=$1 AND profile_id=$4`,
      [groupId(), pin.functionId, pin.endpointSlug, childProfileId],
    );
    const endpointRequest = {
      tenantId,
      apiKeyId: apiKeyId(),
      groupId: groupId(),
      selector: {
        businessId: PC09_BUSINESS,
        businessVersion: PC09_VERSION_V2,
        action: ACTION,
        functionId: pin.functionId,
        endpointSlug: pin.endpointSlug,
      },
      submission: pc09Submission({ note: 'endpoint' }),
    };
    const preview = await submission.previewProfileV2(endpointRequest);
    const accepted = await submission.submitProfileV2({
      ...endpointRequest,
      resolutionFingerprint: preview.resolutionFingerprint,
      idempotencyKey: `r02-endpoint-${randomUUID()}`,
    });
    const row = await workflowRow(accepted.operation.id);
    expect(row.workflow_schema_slug).toBeNull();
    expect(row.workflow_schema_revision).toBeNull();
    expect(row.workflow_schema_digest).toBeNull();
  });
});
