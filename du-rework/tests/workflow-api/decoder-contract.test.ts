import {
  decodeLegacyNamedWorkflow,
  decodeLegacySchemaWorkflow,
  LegacyWorkflowDecodeError,
} from '../../orchestrator/services/orchestrator/src/compat/legacy-workflow-decoders';
import type { MultipartBody, MultipartFile } from '../../orchestrator/services/orchestrator/src/compat/legacy-multipart';

function multipart(
  fields: Record<string, string | string[]> = {},
  files: readonly Partial<MultipartFile>[] = [],
): MultipartBody {
  return {
    fields: new Map(Object.entries(fields).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])),
    files: files.map((file, index) => ({
      fieldName: file.fieldName ?? 'files[]',
      fileName: file.fileName ?? `synthetic-${index + 1}.txt`,
      contentType: file.contentType ?? 'text/plain',
      content: file.content ?? Buffer.from(`synthetic-file-${index + 1}`, 'utf8'),
    })),
  };
}

describe('legacy workflow multipart decoder', () => {
  test('accepts the three true process names and includes resolution_data only for disbursement', () => {
    const file = { fieldName: 'file', content: Buffer.from('synthetic') };
    const disbursement = decodeLegacyNamedWorkflow(multipart({
      process: ' disbursement ', resolution_data: 'match this',
    }, [file]));
    const lcChecker = decodeLegacyNamedWorkflow(multipart({ process: 'lc-checker', resolution_data: 'ignored' }, [file]));
    const docCompare = decodeLegacyNamedWorkflow(multipart({ process: 'doc-compare' }, [file]));

    expect(disbursement.process).toBe('disbursement');
    expect(disbursement.variables).toEqual({ resolution_data: 'match this' });
    expect(lcChecker.process).toBe('lc-checker');
    expect(lcChecker.variables).toEqual({});
    expect(docCompare.process).toBe('doc-compare');
    expect(docCompare.variables).toEqual({});
  });

  test('uses legacy file ordering, ignores zero-byte files, and rejects a missing required file', () => {
    const request = decodeLegacyNamedWorkflow(multipart({ process: 'disbursement' }, [
      { fieldName: 'source_file', fileName: 'source.txt' },
      { fieldName: 'files[]', fileName: 'first.txt' },
      { fieldName: 'files[]', fileName: 'empty.txt', content: Buffer.alloc(0) },
      { fieldName: 'target_file', fileName: 'target.txt' },
      { fieldName: 'file', fileName: 'last.txt' },
    ]));
    expect(request.files.map((file) => file.fileName)).toEqual([
      'first.txt', 'source.txt', 'target.txt', 'last.txt',
    ]);
    expect(() => decodeLegacyNamedWorkflow(multipart({ process: 'lc-checker' })))
      .toThrow(expect.objectContaining({ code: 'MISSING_FILES' }));
  });

  test('requires object JSON for schema input while allowing no files', () => {
    expect(decodeLegacySchemaWorkflow(multipart({ schemaSlug: ' review-v1 ', input: '{"value":2}' })))
      .toMatchObject({ kind: 'schema', schemaSlug: 'review-v1', input: { value: 2 }, files: [] });
    for (const input of ['[1]', 'null', 'false', '"text"', '{']) {
      expect(() => decodeLegacySchemaWorkflow(multipart({ schemaSlug: 'review-v1', input })))
        .toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    try {
      decodeLegacySchemaWorkflow(multipart({ schemaSlug: 'review-v1', input: '[1]' }));
      throw new Error('expected invalid schema input');
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyWorkflowDecodeError);
    }
  });

  test('caps uploaded files before admission and rejects unknown process names', () => {
    const files = Array.from({ length: 65 }, (_, index) => ({
      fieldName: 'files[]', fileName: `file-${index}.txt`,
    }));
    expect(() => decodeLegacyNamedWorkflow(multipart({ process: 'disbursement' }, files)))
      .toThrow(expect.objectContaining({ code: 'TOO_MANY_FILES' }));
    expect(() => decodeLegacyNamedWorkflow(multipart({ process: 'simple-extraction' }, [{ fieldName: 'file' }])))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_PROCESS' }));
  });
});
