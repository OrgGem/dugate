import {
  BusinessManifest,
  validateManifest,
} from '@du/contracts';
import {
  defineBusiness,
  TaskHandler,
} from '@du/worker-sdk';
import { exampleReviewManifest } from '../src/manifest';
import {
  exampleReviewBusiness,
  exampleReviewHandlers,
} from '../src/worker';
import { mainReviewHandler, itemReviewHandler } from '../src/review';

describe('Example Review Manifest & Registration Contract (P7-01)', () => {
  it('validates the manifest and derives the expected BullMQ queue', () => {
    const result = validateManifest(exampleReviewManifest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.queue).toBe('du-business-example-review-1.0.0');
      expect(result.manifest.businessId).toBe('example-review');
      expect(result.manifest.version).toBe('1.0.0');
      expect(result.manifest.contractVersion).toBe('1');
      expect(result.manifest.runtime.wireVersion).toBe('1');
    }
  });

  it('declares review action with strict 1..10 artifact input schema and output schema', () => {
    const action = exampleReviewManifest.actions.find((a) => a.name === 'review');
    expect(action).toBeDefined();

    // Artifact policy enforces 1..10 files
    expect(action!.artifactPolicy.minFiles).toBe(1);
    expect(action!.artifactPolicy.maxFiles).toBe(10);
    expect(action!.artifactPolicy.acceptedMimeTypes).toContain('application/json');

    // Capabilities include both cancel and resume
    expect(action!.capabilities.cancel).toBe(true);
    expect(action!.capabilities.resume).toBe(true);

    // Declares optional reasoning connector slot
    expect(action!.connectorSlots).toHaveLength(1);
    const slot = action!.connectorSlots[0]!;
    expect(slot.name).toBe('reasoning');
    expect(slot.required).toBe(false);
    expect(slot.acceptedCapabilities).toContain('chat-completion');
    expect(slot.acceptedCapabilities).toContain('structured-output');
  });

  it('binds exactly declared handler kinds and rejects mismatched handlers', () => {
    expect(exampleReviewBusiness.handlers).toEqual(exampleReviewHandlers);
    expect(Object.keys(exampleReviewHandlers).sort()).toEqual(['review', 'review-item', 'root'].sort());

    // Rejects empty handlers
    expect(() => defineBusiness(exampleReviewManifest, {})).toThrow(/missing handlers/);

    // Rejects undeclared handler kinds
    const extraHandlers: Record<string, TaskHandler> = {
      review: mainReviewHandler,
      'review-item': itemReviewHandler,
      root: mainReviewHandler,
      'unknown-kind': mainReviewHandler,
    };
    expect(() => defineBusiness(exampleReviewManifest, extraHandlers)).toThrow(/undeclared/);
  });

  it('rejects a manifest missing action handler in runtime.handlerKinds', () => {
    const invalid: BusinessManifest = {
      ...exampleReviewManifest,
      runtime: { wireVersion: '1', handlerKinds: ['other-kind'] },
    };

    const result = validateManifest(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('not declared in runtime.handlerKinds') }),
        ])
      );
    }
  });
});
