import { validateManifest } from '@du/contracts';
import { defineBusiness } from '@du/worker-sdk';
import { exampleReviewManifest, exampleReviewManifestV2 } from '../src/manifest';
import {
  exampleReviewBusiness,
  exampleReviewHandlers,
} from '../src/worker';
import { aggregateReviews } from '../src/review';
import type { ItemReviewResult, ApprovalDecision } from '../src/types';

describe('P7-06 Business Extension Version Coexistence Contracts (VER-01)', () => {

  it('validates both v1 and v2 manifests and derives distinct BullMQ queues', () => {
    const res1 = validateManifest(exampleReviewManifest);
    const res2 = validateManifest(exampleReviewManifestV2);

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    if (res1.ok && res2.ok) {
      expect(res1.manifest.version).toBe('1.0.0');
      expect(res2.manifest.version).toBe('2.0.0');

      expect(res1.queue).toBe('du-business-example-review-1.0.0');
      expect(res2.queue).toBe('du-business-example-review-2.0.0');
      expect(res1.queue).not.toBe(res2.queue);

      expect(res1.manifest.imageDigest).not.toBe(res2.manifest.imageDigest);
      expect(res1.manifest.displayName).not.toBe(res2.manifest.displayName);
    }
  });

  it('binds identical business handlers across both v1 and v2 definitions', () => {
    const def1 = exampleReviewBusiness;
    const def2 = defineBusiness(exampleReviewManifestV2, exampleReviewHandlers);

    expect(def1.manifest.version).toBe('1.0.0');
    expect(def2.manifest.version).toBe('2.0.0');
    expect(def1.handlers).toBe(def2.handlers);
    expect(Object.keys(def1.handlers).sort()).toEqual(['review', 'review-item', 'root'].sort());
  });

  it('produces observable version markers in review aggregate results for v1 and v2', () => {
    const mockItems: ItemReviewResult[] = [
      {
        reviewId: 'rev-coex-1',
        itemIndex: 0,
        artifactId: 'art-1',
        fileName: 'doc-1.pdf',
        passed: true,
        failedChecks: [],
        reviewedAt: new Date().toISOString(),
      },
    ];

    const approval: ApprovalDecision = {
      approved: true,
      note: 'Audited and approved',
      approver: 'lead-auditor',
    };

    // Output from v1 execution
    const outV1 = aggregateReviews('rev-coex-1', mockItems, 'artifact://reviews-1', approval, '1.0.0');
    expect(outV1.version).toBe('1.0.0');
    expect(outV1.summary).toContain('[1.0.0]');
    expect(outV1.summary).toContain('Review rev-coex-1 approved');

    // Output from v2 execution
    const outV2 = aggregateReviews('rev-coex-2', mockItems, 'artifact://reviews-2', approval, '2.0.0');
    expect(outV2.version).toBe('2.0.0');
    expect(outV2.summary).toContain('[2.0.0]');
    expect(outV2.summary).toContain('Review rev-coex-2 approved');

    // Both output structures carry valid required fields
    for (const out of [outV1, outV2]) {
      expect(typeof out.reviewId).toBe('string');
      expect(typeof out.approved).toBe('boolean');
      expect(typeof out.itemCount).toBe('number');
      expect(typeof out.reviewsRef).toBe('string');
      expect(Array.isArray(out.failedChecks)).toBe(true);
      expect(Array.isArray(out.items)).toBe(true);
      expect(typeof out.summary).toBe('string');
      expect(typeof out.version).toBe('string');
    }
  });
});
