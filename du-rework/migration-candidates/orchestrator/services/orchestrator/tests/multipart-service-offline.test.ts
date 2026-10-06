import {
  MULTIPART_FIXED_PART_BYTES,
  MULTIPART_MAX_PARTS,
  MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_MIN_TOTAL_BYTES,
  MultipartAbortAckSchema,
  MultipartCompleteAckSchema,
  MultipartInitAckSchema,
  MultipartPartGrantSchema,
} from '@du/contracts';
import type { MultipartPartReceipt } from '@du/contracts';
import { createMultipartService, publicUploadToken } from '../src/modules/artifacts/multipart-service';
import { DEFAULT_MAX_JSON_BYTES } from '../src/http/ingress';
import {
  clock,
  LEASE_EPOCH,
  SIZE_70MIB,
  TASK_ID,
  TENANT_ID,
  UPLOAD_TOKEN,
  createMultipartHarness,
  initBody,
  partHash,
  publicInitBody,
  uploadEveryPart,
  uploadEveryPartPublic,
  wholeHash,
  type MultipartHarness,
} from './fixtures/multipart-offline-harness';

/**
 * DATA-02 multipart lifecycle (Qwen-5) — offline service tests, zero DB/Redis.
 * Every guard is asserted at the boundary that owns it: wire schema, lease
 * fence, server-fixed geometry, the grant ledger, and storage's own part list.
 */

const DECLARED_SHA = wholeHash('whole-object');

/** Signed §6 policy ceiling for one part (§6 user decision gate, Cycle A1). */
const SIGNED_MAX_PART_BYTES = 64 * 1024 * 1024;

async function opened(harness: MultipartHarness) {
  const ack = await harness.service.init(TASK_ID, initBody());
  const geometry = { partSizeBytes: ack.partSizeBytes, partCount: ack.partCount, sizeBytes: SIZE_70MIB };
  return { ack, geometry, artifactId: ack.artifactId };
}

async function completed(harness: MultipartHarness) {
  const openedUpload = await opened(harness);
  const receipts = await uploadEveryPart(harness, openedUpload.artifactId, openedUpload.geometry);
  const ack = await harness.service.complete(openedUpload.artifactId, {
    leaseEpoch: LEASE_EPOCH,
    parts: receipts,
    sha256: DECLARED_SHA,
  });
  return { ...openedUpload, receipts, ack };
}

beforeEach(() => {
  clock.ms = Date.parse('2026-09-25T00:00:00.000Z');
});

describe('multipart init', () => {
  test('opens one STAGING multipart row and exactly one provider upload', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);

    expect(MultipartInitAckSchema.parse(ack)).toMatchObject({ partSizeBytes: MULTIPART_FIXED_PART_BYTES, partCount: 9, replayed: false });
    expect(harness.storage.createCalls).toHaveLength(1);
    const row = harness.db.artifacts.get(ack.artifactId)!;
    expect(row.state).toBe('STAGING');
    expect(row.sizeBytes).toBe(SIZE_70MIB);
    expect(row.partCount).toBe(9);
    expect(row.taskId).toBe(TASK_ID);
    // The provider upload id never leaves the server.
    expect(ack.uploadHandle).not.toContain(row.uploadId!);
    expect(ack.uploadHandle.startsWith('mh_')).toBe(true);
  });

  test('keeps the geometry server-fixed: eight full parts plus a remainder', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    expect(ack.partCount).toBe(Math.ceil(SIZE_70MIB / MULTIPART_FIXED_PART_BYTES));
    expect(SIZE_70MIB - (ack.partCount - 1) * ack.partSizeBytes).toBe(6 * 1024 * 1024);
  });

  test('replays the same token and parameters without a second provider upload', async () => {
    const harness = createMultipartHarness();
    const first = await harness.service.init(TASK_ID, initBody());
    const second = await harness.service.init(TASK_ID, initBody());
    expect(second).toEqual({ ...first, replayed: true });
    expect(harness.storage.createCalls).toHaveLength(1);
    expect(harness.db.artifacts.size).toBe(1);
  });

  test('refuses a token already bound to different upload parameters', async () => {
    const harness = createMultipartHarness();
    await harness.service.init(TASK_ID, initBody());
    await expect(harness.service.init(TASK_ID, initBody({ mimeType: 'text/plain' })))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(harness.storage.createCalls).toHaveLength(1);
  });

  test('rejects the input purpose, which belongs to the public upload branch', async () => {
    const harness = createMultipartHarness();
    await expect(harness.service.init(TASK_ID, initBody({ purpose: 'input' })))
      .rejects.toMatchObject({ status: 403 });
    expect(harness.storage.createCalls).toHaveLength(0);
    expect(harness.db.artifacts.size).toBe(0);
  });

  test('fences on the producer lease before creating anything', async () => {
    const harness = createMultipartHarness();
    await expect(harness.service.init(TASK_ID, initBody({ leaseEpoch: LEASE_EPOCH - 1 })))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
    await expect(harness.service.init('00000000-0000-4000-8000-000000000000', initBody()))
      .rejects.toMatchObject({ status: 404 });
    expect(harness.db.artifacts.size).toBe(0);
  });

  test('applies the deployment cap before asking storage for an upload', async () => {
    const harness = createMultipartHarness({ maxTotalBytes: MULTIPART_MIN_TOTAL_BYTES });
    await expect(harness.service.init(TASK_ID, initBody())).rejects.toMatchObject({
      status: 413, code: 'PAYLOAD_TOO_LARGE',
    });
    expect(harness.storage.createCalls).toHaveLength(0);
    expect(harness.db.artifacts.size).toBe(0);
  });

  test('narrows an operator part size above the signed 64 MiB ceiling', async () => {
    const harness = createMultipartHarness({ partSizeBytes: 2 * SIGNED_MAX_PART_BYTES });
    const ack = await harness.service.init(TASK_ID, initBody());
    expect(ack.partSizeBytes).toBe(SIGNED_MAX_PART_BYTES);
    expect(MultipartInitAckSchema.parse(ack).partCount).toBe(2);
  });

  test('fails closed when the deployment has no multipart backend', async () => {
    const harness = createMultipartHarness();
    const withoutBackend = createMultipartService(harness.db as never, { now: () => clock.ms });
    await expect(withoutBackend.init(TASK_ID, initBody())).rejects.toMatchObject({
      status: 409, code: 'MULTIPART_NOT_AVAILABLE',
    });
    expect(harness.db.artifacts.size).toBe(0);
  });

  test('rejects a size at or below the single-PUT ceiling on the wire', async () => {
    const harness = createMultipartHarness();
    await expect(harness.service.init(TASK_ID, initBody({ sizeBytes: MULTIPART_MIN_TOTAL_BYTES - 1 })))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(harness.storage.createCalls).toHaveLength(0);
  });
});

describe('multipart part grant', () => {
  test('fixes the part size server-side and records the declaration', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    const grant = await harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1),
    });
    expect(MultipartPartGrantSchema.parse(grant)).toMatchObject({ partNumber: 1, sizeBytes: MULTIPART_FIXED_PART_BYTES });
    expect(grant.requiredHeaders['content-length']).toBe(String(MULTIPART_FIXED_PART_BYTES));
    expect(grant.requiredHeaders['x-amz-checksum-sha256']).toBe(Buffer.from(partHash(1), 'hex').toString('base64'));
    expect(harness.db.ledgerOf(ack.artifactId).get(1)).toEqual({
      declaredSha256: partHash(1), sizeBytes: MULTIPART_FIXED_PART_BYTES,
    });
    expect(harness.storage.presignCalls[0]!.objectKey).toBe('art-' + ack.artifactId);
  });

  test('grants the last part at the remainder size', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    const grant = await harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 9, sha256: partHash(9),
    });
    expect(grant.sizeBytes).toBe(6 * 1024 * 1024);
  });

  test('refuses a part number outside the geometry without presigning', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    await expect(harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 10, sha256: partHash(1),
    })).rejects.toMatchObject({ status: 422, code: 'PART_OUT_OF_RANGE' });
    expect(harness.storage.presignCalls).toHaveLength(0);
    expect(harness.db.ledgerOf(ack.artifactId).size).toBe(0);
  });

  test('refuses grants on an expired or aborted session', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    harness.db.artifacts.get(ack.artifactId)!.expiresAt = new Date(clock.ms - 1);
    await expect(harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1),
    })).rejects.toMatchObject({ status: 409, code: 'MULTIPART_EXPIRED' });

    harness.db.artifacts.get(ack.artifactId)!.expiresAt = new Date(clock.ms + 60_000);
    await harness.service.abort(ack.artifactId, { leaseEpoch: LEASE_EPOCH });
    await expect(harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1),
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
  });

  test('refuses a row that is not on the multipart branch', async () => {
    const harness = createMultipartHarness();
    harness.db.addSinglePutArtifact('66666666-6666-4666-8666-666666666666');
    await expect(harness.service.grantPart('66666666-6666-4666-8666-666666666666', {
      leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1),
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(harness.storage.presignCalls).toHaveLength(0);
  });

  // RFX-07: a part number is ONE immutable declaration. The previous case here
  // asserted "re-granting a part replaces the declared hash" — that WAS the
  // defect. Two grants for the same part raced, the loser rewrote the winner's
  // hash, and a client that uploaded per grant #1 then failed `complete` with
  // CHECKSUM_MISMATCH against grant #2's declaration: a server race reported to
  // the operator as a client error.
  test('re-granting a part with a DIFFERENT hash is refused, not silently applied', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    await harness.service.grantPart(ack.artifactId, { leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1) });

    await expect(harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(2),
    })).rejects.toMatchObject({ status: 409, code: 'PART_CONFLICT' });

    // The FIRST declaration survives, and no URL was minted for the loser.
    expect(harness.db.ledgerOf(ack.artifactId).get(1)!.declaredSha256).toBe(partHash(1));
    expect(harness.storage.presignCalls).toHaveLength(1);
  });

  test('re-granting the SAME hash is a replay and succeeds', async () => {
    const harness = createMultipartHarness();
    const { ack } = await opened(harness);
    const body = { leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1) };
    const first = await harness.service.grantPart(ack.artifactId, body);
    const second = await harness.service.grantPart(ack.artifactId, body);

    expect(second.partNumber).toBe(first.partNumber);
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(harness.db.ledgerOf(ack.artifactId).get(1)!.declaredSha256).toBe(partHash(1));
    expect(harness.storage.presignCalls).toHaveLength(2);
  });

  test('complete verifies the hash of the grant that WON, after the other grant was refused', async () => {
    const harness = createMultipartHarness();
    const { ack, geometry } = await opened(harness);
    await harness.service.grantPart(ack.artifactId, { leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1) });
    await expect(harness.service.grantPart(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(2),
    })).rejects.toMatchObject({ status: 409, code: 'PART_CONFLICT' });

    const receipts = await uploadEveryPart(harness, ack.artifactId, geometry);
    const done = await harness.service.complete(ack.artifactId, {
      leaseEpoch: LEASE_EPOCH,
      parts: receipts,
      sha256: DECLARED_SHA,
    });
    expect(done).toMatchObject({ committed: true, replayed: false, sha256: DECLARED_SHA });
  });
});

describe('multipart complete', () => {
  test('commits the verified generation and leaves the row STAGING for finalize', async () => {
    const harness = createMultipartHarness();
    const { artifactId, ack } = await completed(harness);
    expect(MultipartCompleteAckSchema.parse(ack)).toEqual({
      artifactId, sizeBytes: SIZE_70MIB, sha256: DECLARED_SHA, committed: true, replayed: false,
    });
    const row = harness.db.artifacts.get(artifactId)!;
    expect(row.state).toBe('STAGING');
    expect(row.committedVersionId).toBe('v1');
    expect(row.sha256).toBe(DECLARED_SHA);
    expect(harness.storage.verifyCalls[0]).toMatchObject({
      objectKey: 'art-' + artifactId, expectedSizeBytes: SIZE_70MIB, expectedSha256: DECLARED_SHA,
    });
  });

  test('replays a lost complete response from the recorded commit', async () => {
    const harness = createMultipartHarness();
    const first = await completed(harness);
    const replay = await harness.service.complete(first.artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: first.receipts, sha256: DECLARED_SHA,
    });
    expect(replay).toEqual({ ...first.ack, replayed: true });
    expect(harness.storage.completeCalls).toHaveLength(1);
    expect(harness.storage.listCalls).toHaveLength(1);
  });

  test('refuses a receipt set that does not tile the geometry', async () => {
    const shapes: Array<(receipts: MultipartPartReceipt[]) => MultipartPartReceipt[]> = [
      (receipts) => receipts.slice(0, 8),
      (receipts) => [...receipts.slice(0, 8), receipts[0]!],
    ];
    for (const mutate of shapes) {
      const harness = createMultipartHarness();
      const { artifactId, receipts } = await openedAndUpload(harness);
      await expect(harness.service.complete(artifactId, {
        leaseEpoch: LEASE_EPOCH, parts: mutate(receipts), sha256: DECLARED_SHA,
      })).rejects.toMatchObject({ status: 409, code: 'PART_SET_MISMATCH' });
      expect(harness.storage.listCalls).toHaveLength(0);
    }
  });

  test('refuses a part size that contradicts the server-fixed geometry', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    const tampered = receipts.map((receipt, index) => (index === 0 ? { ...receipt, sizeBytes: receipt.sizeBytes + 1 } : receipt));
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: tampered, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'PART_SET_MISMATCH' });
  });

  test('refuses completion when storage holds bytes the server never granted', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    const uploadId = harness.db.artifacts.get(artifactId)!.uploadId!;
    harness.storage.putPart(uploadId, 12, { sizeBytes: 1024, sha256: partHash(12) });
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'PART_SET_MISMATCH' });
    expect(harness.storage.completeCalls).toHaveLength(0);
  });

  test('refuses completion when the stored bytes differ from the granted hash', async () => {
    const harness = createMultipartHarness();
    const { artifactId, geometry } = await opened(harness);
    const receipts = await uploadEveryPart(harness, artifactId, geometry);
    const uploadId = harness.db.artifacts.get(artifactId)!.uploadId!;
    // The client PUT different bytes under the same part number than it declared.
    harness.storage.putPart(uploadId, 3, { sizeBytes: geometry.partSizeBytes, sha256: partHash(99) });
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'CHECKSUM_MISMATCH' });
    expect(harness.storage.completeCalls).toHaveLength(0);
  });

  test('refuses a receipt etag that storage does not agree to', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    const tampered = receipts.map((receipt, index) => (index === 4 ? { ...receipt, etag: '"forged"' } : receipt));
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: tampered, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'PART_SET_MISMATCH' });
  });

  test('refuses completion when a granted part never reached storage', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    const uploadId = harness.db.artifacts.get(artifactId)!.uploadId!;
    harness.storage.dropPart(uploadId, 5); // the client claims all nine, storage holds eight
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'PART_SET_MISMATCH' });
    expect(harness.storage.completeCalls).toHaveLength(0);
  });

  test('deletes the published generation when the whole-object hash does not verify', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    harness.storage.verifySha256 = wholeHash('someone-elses-bytes');
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'CHECKSUM_MISMATCH' });
    expect(harness.storage.deletedVersions).toEqual(['v1']);
    expect(harness.db.artifacts.get(artifactId)!.committedVersionId).toBeNull();
  });

  test('deletes the published generation when the producer lease is taken over mid-upload', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    const list = harness.storage.listMultipartParts;
    harness.storage.listMultipartParts = async (input) => {
      harness.db.tasks.get(TASK_ID)!.leaseEpoch = LEASE_EPOCH + 1; // takeover while parts are listed
      return list(input);
    };
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
    expect(harness.storage.deletedVersions).toEqual(['v1']);
    expect(harness.db.artifacts.get(artifactId)!.committedVersionId).toBeNull();
  });

  test('refuses completion on an aborted session', async () => {
    const harness = createMultipartHarness();
    const { artifactId, receipts } = await openedAndUpload(harness);
    await harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH });
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(harness.storage.completeCalls).toHaveLength(0);
  });
});

describe('multipart abort', () => {
  test('marks the row ABORTED, releases the provider upload and clears its pointer', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await openedAndUpload(harness);
    const ack = await harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH, reason: 'superseded' });
    expect(MultipartAbortAckSchema.parse(ack)).toEqual({ artifactId, state: 'ABORTED', replayed: false });
    const row = harness.db.artifacts.get(artifactId)!;
    expect(row.state).toBe('ABORTED');
    expect(row.abortReason).toBe('superseded');
    expect(row.uploadId).toBeNull();
    expect(harness.storage.abortCalls).toHaveLength(1);
  });

  test('is idempotent across a lost abort response', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await openedAndUpload(harness);
    await harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH });
    const replay = await harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH });
    expect(replay).toMatchObject({ artifactId, state: 'ABORTED', replayed: true });
    // The first abort already released the provider upload and cleared the
    // pointer, so the replay is a pure read: nothing is sent to storage twice.
    expect(harness.storage.abortCalls).toHaveLength(1);
  });

  test('purges a committed generation when the upload is abandoned after complete', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await completed(harness);
    await harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH, reason: 'failed' });
    expect(harness.storage.deletedVersions).toEqual(['v1']);
    expect(harness.db.artifacts.get(artifactId)!.state).toBe('ABORTED');
  });

  test('never purges bytes of a finalized artifact', async () => {
    const harness = createMultipartHarness();
    const finalizedId = '77777777-7777-4777-8777-777777777777';
    harness.db.addArtifact({
      id: finalizedId, state: 'READY', partCount: 9, partSizeBytes: MULTIPART_FIXED_PART_BYTES,
      uploadId: 'provider-upload-9', sizeBytes: SIZE_70MIB,
    });
    await expect(harness.service.abort(finalizedId, { leaseEpoch: LEASE_EPOCH }))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(harness.storage.abortCalls).toHaveLength(0);
    expect(harness.storage.deletedVersions).toHaveLength(0);
  });

  test('allows cleanup after the task left RUNNING but still fences the lease epoch', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await opened(harness);
    harness.db.tasks.get(TASK_ID)!.state = 'FAILED';
    await expect(harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH + 1 }))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
    await expect(harness.service.abort(artifactId, { leaseEpoch: LEASE_EPOCH }))
      .resolves.toMatchObject({ state: 'ABORTED' });
  });

  test('rejects lifecycle calls for an artifact that does not exist', async () => {
    const harness = createMultipartHarness();
    const missing = '99999999-9999-4999-8999-999999999999';
    await expect(harness.service.abort(missing, { leaseEpoch: LEASE_EPOCH }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(harness.service.grantPart(missing, { leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1) }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(harness.service.complete(missing, {
      leaseEpoch: LEASE_EPOCH,
      parts: [{ partNumber: 1, etag: '"one"', sizeBytes: 1024, sha256: partHash(1) }],
      sha256: DECLARED_SHA,
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(harness.storage.listCalls).toHaveLength(0);
  });
});

describe('multipart orphan sweep', () => {
  test('aborts expired sessions and reports the counts', async () => {
    const harness = createMultipartHarness();
    const stale = await opened(harness);
    const fresh = await harness.service.init(TASK_ID, initBody({ uploadToken: '88888888-8888-4888-8888-888888888888' }));
    harness.db.artifacts.get(stale.artifactId)!.expiresAt = new Date(clock.ms - 1);

    const summary = await harness.service.sweepExpiredSessions();
    expect(summary).toMatchObject({ scanned: 1, aborted: 1, purged: 1, failed: 0 });
    expect(harness.db.artifacts.get(stale.artifactId)!.state).toBe('ABORTED');
    expect(harness.db.artifacts.get(stale.artifactId)!.abortReason).toBe('expired');
    expect(harness.db.artifacts.get(fresh.artifactId)!.state).toBe('STAGING');
  });

  test('finishes a purge that the abort path left behind', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await opened(harness);
    harness.db.artifacts.get(artifactId)!.state = 'ABORTED';
    harness.db.artifacts.get(artifactId)!.expiresAt = new Date(clock.ms - 1);

    const summary = await harness.service.sweepExpiredSessions();
    expect(summary).toMatchObject({ scanned: 1, aborted: 0, purged: 1 });
    expect(harness.storage.abortCalls).toHaveLength(1);
    expect(harness.db.artifacts.get(artifactId)!.uploadId).toBeNull();
    await expect(harness.service.sweepExpiredSessions()).resolves.toMatchObject({ scanned: 0 });
  });

  test('counts a storage failure without losing the row for the next sweep', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await opened(harness);
    harness.db.artifacts.get(artifactId)!.expiresAt = new Date(clock.ms - 1);
    harness.storage.abortMultipartUpload = async () => {
      throw new Error('provider unreachable');
    };
    await expect(harness.service.sweepExpiredSessions()).resolves.toMatchObject({ scanned: 1, aborted: 1, purged: 0, failed: 0 });
    expect(harness.db.artifacts.get(artifactId)!.uploadId).not.toBeNull();
    // The row keeps its provider pointer, so the next sweep retries the purge.
    expect(await harness.service.sweepExpiredSessions()).toMatchObject({ scanned: 1, purged: 0 });
  });
});

async function openedAndUpload(harness: MultipartHarness) {
  const openedUpload = await opened(harness);
  const receipts = await uploadEveryPart(harness, openedUpload.artifactId, openedUpload.geometry);
  return { ...openedUpload, receipts };
}

/* ------------------------------------------------------------------ */
/* DATA-02 public branch (POST /api/v1/uploads) - W-DATA02-PUB-1       */
/* ------------------------------------------------------------------ */

const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222299';
const PUBLIC_DECLARED_SHA = wholeHash('public-source-bytes');

async function publicOpened(harness: MultipartHarness) {
  const ack = await harness.service.publicInit(TENANT_ID, publicInitBody());
  const geometry = { partSizeBytes: ack.partSizeBytes, partCount: ack.partCount, sizeBytes: SIZE_70MIB };
  return { ack, geometry, artifactId: ack.artifactId };
}

async function publicCompleted(harness: MultipartHarness) {
  const openedUpload = await publicOpened(harness);
  const receipts = await uploadEveryPartPublic(harness, openedUpload.artifactId, TENANT_ID, openedUpload.geometry);
  const ack = await harness.service.publicComplete(openedUpload.artifactId, TENANT_ID, {
    parts: receipts,
    sha256: PUBLIC_DECLARED_SHA,
  });
  return { ...openedUpload, receipts, ack };
}

describe('public uploads init', () => {
  test('opens a task-less STAGING input row on the public branch', async () => {
    const harness = createMultipartHarness();
    const { ack } = await publicOpened(harness);
    expect(MultipartInitAckSchema.parse(ack)).toMatchObject({ partCount: 9, replayed: false });
    const row = harness.db.artifacts.get(ack.artifactId)!;
    expect(row.taskId).toBeNull();
    expect(row.operationId).toBeNull();
    expect(row.purpose).toBe('input');
    expect(row.state).toBe('STAGING');
    expect(harness.storage.createCalls[0]).toMatchObject({ tenantId: TENANT_ID });
    // Same server-fixed geometry as the runtime branch: zero policy forks.
    expect(ack.partSizeBytes).toBe(MULTIPART_FIXED_PART_BYTES);
  });

  test('replays the same token and refuses one bound to different parameters', async () => {
    const harness = createMultipartHarness();
    const first = await harness.service.publicInit(TENANT_ID, publicInitBody());
    const second = await harness.service.publicInit(TENANT_ID, publicInitBody());
    expect(second).toEqual({ ...first, replayed: true });
    expect(harness.storage.createCalls).toHaveLength(1);
    await expect(harness.service.publicInit(TENANT_ID, publicInitBody({ mimeType: 'text/plain' })))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('the same token under a different tenant is a different replay key', async () => {
    const harness = createMultipartHarness();
    const mine = await harness.service.publicInit(TENANT_ID, publicInitBody());
    const theirs = await harness.service.publicInit(FOREIGN_TENANT, publicInitBody());
    expect(theirs.artifactId).not.toBe(mine.artifactId);
    expect(theirs.replayed).toBe(false);
    expect(harness.storage.createCalls).toHaveLength(2);
  });

  test('applies the deployment cap and the missing-backend rule like the runtime branch', async () => {
    const capped = createMultipartHarness({ maxTotalBytes: MULTIPART_MIN_TOTAL_BYTES });
    await expect(capped.service.publicInit(TENANT_ID, publicInitBody()))
      .rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(capped.storage.createCalls).toHaveLength(0);
    const harness = createMultipartHarness();
    const withoutBackend = createMultipartService(harness.db as never, { now: () => clock.ms });
    await expect(withoutBackend.publicInit(TENANT_ID, publicInitBody()))
      .rejects.toMatchObject({ status: 409, code: 'MULTIPART_NOT_AVAILABLE' });
  });

  test('a public session is invisible to the runtime lifecycle (no owning task)', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await publicOpened(harness);
    await expect(harness.service.grantPart(artifactId, { leaseEpoch: LEASE_EPOCH, partNumber: 1, sha256: partHash(1) }))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(harness.service.complete(artifactId, {
      leaseEpoch: LEASE_EPOCH, parts: [], sha256: PUBLIC_DECLARED_SHA,
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
  });

  test('publicUploadToken is deterministic, uuid-shaped and tenant-namespaced', async () => {
    const token = publicUploadToken(TENANT_ID, 'loss-retry-1');
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publicUploadToken(TENANT_ID, 'loss-retry-1')).toBe(token);
    expect(publicUploadToken(FOREIGN_TENANT, 'loss-retry-1')).not.toBe(token);
    // The route forwards the derived token; the service sees a normal replay key.
    const harness = createMultipartHarness();
    const viaToken = await harness.service.publicInit(TENANT_ID, publicInitBody({ uploadToken: token }));
    const again = await harness.service.publicInit(TENANT_ID, publicInitBody({ uploadToken: token }));
    expect(again).toEqual({ ...viaToken, replayed: true });
  });
});

describe('public uploads grant + complete + abort', () => {
  test('completes a public upload and makes the verified commit the READY edge', async () => {
    const harness = createMultipartHarness();
    const { artifactId, ack } = await publicCompleted(harness);
    expect(MultipartCompleteAckSchema.parse(ack)).toEqual({
      artifactId, sizeBytes: SIZE_70MIB, sha256: PUBLIC_DECLARED_SHA, committed: true, replayed: false,
    });
    const row = harness.db.artifacts.get(artifactId)!;
    expect(row.state).toBe('READY');
    expect(row.committedVersionId).toBe('v1');
    expect(row.sha256).toBe(PUBLIC_DECLARED_SHA);
    // The public branch runs the SAME storage-authoritative gate: ListParts
    // first, whole-object re-hash before the commit is recorded.
    expect(harness.storage.listCalls).toHaveLength(1);
    expect(harness.storage.verifyCalls[0]).toMatchObject({ expectedSizeBytes: SIZE_70MIB });
  });

  test('a foreign tenant sees neither existence nor state', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await publicOpened(harness);
    await expect(harness.service.publicGrantPart(artifactId, FOREIGN_TENANT, { partNumber: 1, sha256: partHash(1) }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(harness.service.publicComplete(artifactId, FOREIGN_TENANT, {
      parts: [{ partNumber: 1, etag: '"1"', sizeBytes: 1024, sha256: partHash(1) }],
      sha256: PUBLIC_DECLARED_SHA,
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(harness.service.publicAbort(artifactId, FOREIGN_TENANT, {}))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(harness.storage.presignCalls).toHaveLength(0);
    expect(harness.storage.abortCalls).toHaveLength(0);
  });

  test('refuses to complete with an untiled receipt set and keeps the row STAGING', async () => {
    const harness = createMultipartHarness();
    const { artifactId, geometry, receipts } = await publicOpenedAndUpload(harness);
    await expect(harness.service.publicComplete(artifactId, TENANT_ID, {
      parts: receipts.slice(0, geometry.partCount - 1), sha256: PUBLIC_DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'PART_SET_MISMATCH' });
    expect(harness.storage.completeCalls).toHaveLength(0);
    expect(harness.db.artifacts.get(artifactId)!.state).toBe('STAGING');
  });

  test('replays a lost complete response after the session TTL, from the durable commit', async () => {
    const harness = createMultipartHarness();
    const first = await publicCompleted(harness);
    harness.db.artifacts.get(first.artifactId)!.expiresAt = new Date(clock.ms - 1);
    const replay = await harness.service.publicComplete(first.artifactId, TENANT_ID, {
      parts: first.receipts, sha256: PUBLIC_DECLARED_SHA,
    });
    expect(replay).toEqual({ ...first.ack, replayed: true });
    expect(harness.storage.completeCalls).toHaveLength(1);
    expect(harness.storage.listCalls).toHaveLength(1);
  });

  test('aborts a STAGING public session (mark-then-purge) and is idempotent', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await publicOpenedAndUpload(harness);
    const ack = await harness.service.publicAbort(artifactId, TENANT_ID, { reason: 'cancelled' });
    expect(MultipartAbortAckSchema.parse(ack)).toEqual({ artifactId, state: 'ABORTED', replayed: false });
    const row = harness.db.artifacts.get(artifactId)!;
    expect(row.state).toBe('ABORTED');
    expect(row.abortReason).toBe('cancelled');
    expect(row.uploadId).toBeNull();
    const replay = await harness.service.publicAbort(artifactId, TENANT_ID, {});
    expect(replay).toMatchObject({ state: 'ABORTED', replayed: true });
    expect(harness.storage.abortCalls).toHaveLength(1);
  });

  test('never purges the bytes of a completed (READY) public artifact', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await publicCompleted(harness);
    await expect(harness.service.publicAbort(artifactId, TENANT_ID, {}))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(harness.storage.deletedVersions).toHaveLength(0);
    expect(harness.storage.abortCalls).toHaveLength(0);
    expect(harness.db.artifacts.get(artifactId)!.state).toBe('READY');
  });

  test('refuses to drive a runtime-owned session through the public branch', async () => {
    const harness = createMultipartHarness();
    const runtime = await harness.service.init(TASK_ID, initBody());
    await expect(harness.service.publicGrantPart(runtime.artifactId, TENANT_ID, { partNumber: 1, sha256: partHash(1) }))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(harness.service.publicComplete(runtime.artifactId, TENANT_ID, {
      parts: [{ partNumber: 1, etag: '"1"', sizeBytes: 1024, sha256: partHash(1) }],
      sha256: PUBLIC_DECLARED_SHA,
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(harness.storage.presignCalls).toHaveLength(0);
  });

  test('refuses grants past the session TTL', async () => {
    const harness = createMultipartHarness();
    const { artifactId } = await publicOpened(harness);
    harness.db.artifacts.get(artifactId)!.expiresAt = new Date(clock.ms - 1);
    await expect(harness.service.publicGrantPart(artifactId, TENANT_ID, { partNumber: 1, sha256: partHash(1) }))
      .rejects.toMatchObject({ status: 409, code: 'MULTIPART_EXPIRED' });
  });
});

describe('public uploads sweep coverage', () => {
  test('the TTL sweep reclaims an expired public session with the same net', async () => {
    const harness = createMultipartHarness();
    const stale = await publicOpened(harness);
    const fresh = await harness.service.publicInit(TENANT_ID, publicInitBody({ uploadToken: UPLOAD_TOKEN.replace('44444', '88888') }));
    harness.db.artifacts.get(stale.artifactId)!.expiresAt = new Date(clock.ms - 1);
    const summary = await harness.service.sweepExpiredSessions();
    expect(summary).toMatchObject({ scanned: 1, aborted: 1, purged: 1, failed: 0 });
    const row = harness.db.artifacts.get(stale.artifactId)!;
    expect(row.state).toBe('ABORTED');
    expect(row.abortReason).toBe('expired');
    expect(harness.db.artifacts.get(fresh.artifactId)!.state).toBe('STAGING');
  });
});

async function publicOpenedAndUpload(harness: MultipartHarness) {
  const openedUpload = await publicOpened(harness);
  const receipts = await uploadEveryPartPublic(harness, openedUpload.artifactId, TENANT_ID, openedUpload.geometry);
  return { ...openedUpload, receipts };
}

/**
 * The complete request is a JSON body and ingress caps JSON at 1 MiB, so the
 * widest geometry the wire allows must still fit. This is arithmetic over the
 * signed §6 bounds, not a service call: it fails the moment a future policy
 * widening makes a legal receipt list unloadable.
 */
describe('complete body against the ingress JSON cap', () => {
  test('the widest legal geometry keeps a receipts body under the cap', () => {
    const maxParts = Math.ceil(MULTIPART_MAX_TOTAL_BYTES / MULTIPART_FIXED_PART_BYTES);
    expect(maxParts).toBeLessThanOrEqual(MULTIPART_MAX_PARTS);
    const receipts: MultipartPartReceipt[] = Array.from({ length: maxParts }, (_, index) => ({
      partNumber: index + 1,
      etag: 'f'.repeat(256),
      sizeBytes: MULTIPART_FIXED_PART_BYTES,
      sha256: 'a'.repeat(64),
    }));
    const bytes = Buffer.byteLength(
      JSON.stringify({ leaseEpoch: LEASE_EPOCH, parts: receipts, sha256: 'b'.repeat(64) }),
    );
    expect(bytes).toBeLessThan(DEFAULT_MAX_JSON_BYTES);
  });
});

/* ------------------------------------------------------------------ */
/* RFX-07 — the public branch enforces the same one-declaration-per-part  */
/* ------------------------------------------------------------------ */

describe('RFX-07 public branch: a part number carries one declaration', () => {
  test('a second public grant with a DIFFERENT hash is a PART_CONFLICT', async () => {
    const harness = createMultipartHarness();
    const { ack } = await publicOpened(harness);
    await harness.service.publicGrantPart(ack.artifactId, TENANT_ID, { partNumber: 1, sha256: partHash(1) });

    await expect(harness.service.publicGrantPart(ack.artifactId, TENANT_ID, {
      partNumber: 1, sha256: partHash(2),
    })).rejects.toMatchObject({ status: 409, code: 'PART_CONFLICT' });

    expect(harness.db.ledgerOf(ack.artifactId).get(1)!.declaredSha256).toBe(partHash(1));
    expect(harness.storage.presignCalls).toHaveLength(1);
  });

  test('a second public grant with the SAME hash replays', async () => {
    const harness = createMultipartHarness();
    const { ack } = await publicOpened(harness);
    const body = { partNumber: 1, sha256: partHash(1) };
    const first = await harness.service.publicGrantPart(ack.artifactId, TENANT_ID, body);
    const second = await harness.service.publicGrantPart(ack.artifactId, TENANT_ID, body);

    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(harness.db.ledgerOf(ack.artifactId).get(1)!.declaredSha256).toBe(partHash(1));
    expect(harness.storage.presignCalls).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* RFX-03 — public multipart is refused when encryption is required        */
/* ------------------------------------------------------------------ */

describe('RFX-03 public multipart is refused while artifact encryption is required', () => {
  const ENV_KEYS = [
    'ARTIFACT_STORAGE_BACKEND',
    'DU_ENCRYPTION_METADATA_ENABLED',
    'DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED',
  ] as const;

  function withEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return body().finally(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  test('publicInit is refused on an S3 deployment, before any row or provider upload exists', async () => {
    await withEnv({ ARTIFACT_STORAGE_BACKEND: 's3' }, async () => {
      const harness = createMultipartHarness();
      await expect(harness.service.publicInit(TENANT_ID, publicInitBody())).rejects.toMatchObject({
        status: 501,
        code: 'PUBLIC_MULTIPART_UNAVAILABLE',
      });
      // Nothing was created: no session row, no provider multipart upload.
      expect(harness.db.artifacts.size).toBe(0);
      expect(harness.storage.createCalls).toHaveLength(0);
    });
  });

  test('publicGrantPart is refused, so no plaintext presigned PUT URL is ever minted', async () => {
    // Opened while encryption was still OFF, so this leg proves the GRANT is
    // refused on an already-existing session rather than just that init is.
    const harness = createMultipartHarness();
    const { ack } = await publicOpened(harness);
    const presignsBefore = harness.storage.presignCalls.length;

    await withEnv({ ARTIFACT_STORAGE_BACKEND: 's3' }, async () => {
      await expect(harness.service.publicGrantPart(ack.artifactId, TENANT_ID, {
        partNumber: 1, sha256: partHash(1),
      })).rejects.toMatchObject({ status: 501, code: 'PUBLIC_MULTIPART_UNAVAILABLE' });
    });

    expect(harness.storage.presignCalls).toHaveLength(presignsBefore);
    expect(harness.db.ledgerOf(ack.artifactId).size).toBe(0);
  });

  test('publicComplete is refused, so a session opened earlier cannot be published in plaintext', async () => {
    const harness = createMultipartHarness();
    const { geometry, artifactId } = await publicOpened(harness);
    const receipts = await uploadEveryPartPublic(harness, artifactId, TENANT_ID, geometry);

    await withEnv({ ARTIFACT_STORAGE_BACKEND: 's3' }, async () => {
      await expect(harness.service.publicComplete(artifactId, TENANT_ID, {
        parts: receipts, sha256: PUBLIC_DECLARED_SHA,
      })).rejects.toMatchObject({ status: 501, code: 'PUBLIC_MULTIPART_UNAVAILABLE' });
    });

    // Still STAGING: nothing was published into the encrypted bucket.
    expect(harness.db.artifacts.get(artifactId)!.state).toBe('STAGING');
  });

  test('a MALFORMED encryption flag is read as required, never as "no encryption"', async () => {
    // `readBoolean` throws on anything but true/false. Treating that as "off"
    // would let a typo in the encryption surface open the plaintext path.
    await withEnv({ ARTIFACT_STORAGE_BACKEND: 'postgres', DU_ENCRYPTION_METADATA_ENABLED: 'yes' }, async () => {
      const harness = createMultipartHarness();
      await expect(harness.service.publicInit(TENANT_ID, publicInitBody())).rejects.toMatchObject({
        status: 501,
        code: 'PUBLIC_MULTIPART_UNAVAILABLE',
      });
    });
  });

  test('the guard stays open on a postgres deployment with every flag off', async () => {
    await withEnv(
      { ARTIFACT_STORAGE_BACKEND: 'postgres', DU_ENCRYPTION_METADATA_ENABLED: 'false' },
      async () => {
        const harness = createMultipartHarness();
        await expect(harness.service.publicInit(TENANT_ID, publicInitBody())).resolves.toMatchObject({
          replayed: false,
        });
      },
    );
  });
});

