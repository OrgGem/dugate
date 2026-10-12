import { projectAdmittedWorkflowSchemaDigest } from '../src/modules/operations/submission';

describe('ORV14 admitted workflow projection', () => {
  it('uses the compiled immutable schema digest for the matching legacy workflow marker', () => {
    const source = [
      { processor: 'ext-classifier', workflow: 'schema-a', schemaRevision: 3, schemaDigest: 'sha256:catalog' },
      { processor: 'other', workflow: 'schema-b', schemaRevision: 3, schemaDigest: 'sha256:other' },
    ];

    expect(projectAdmittedWorkflowSchemaDigest(source, {
      slug: 'schema-a',
      revision: 3,
      digest: 'sha256:compiled',
    })).toEqual([
      { processor: 'ext-classifier', workflow: 'schema-a', schemaRevision: 3, schemaDigest: 'sha256:compiled' },
      { processor: 'other', workflow: 'schema-b', schemaRevision: 3, schemaDigest: 'sha256:other' },
    ]);
  });

  it('preserves unrelated and legacy projections when there is no schema pin', () => {
    const source = [{ processor: 'legacy', workflow: 'old-schema' }];
    const result = projectAdmittedWorkflowSchemaDigest(source, null);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result[0]).not.toBe(source[0]);
  });
});
