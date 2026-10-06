import { readMultipartBody } from '../src/compat/legacy-multipart';
import { LegacyFormData, legacyFieldsToRecord } from '../src/compat/legacy-form-bridge';
import { decodeLegacyWire } from '../src/compat/legacy-wire-decoders';

/**
 * The bridge only earns its keep if the REAL decoder consumes what it
 * produces. Asserting on the adapter's own output would pass even if the
 * decoder stopped recognising the shape, so every case here ends in a
 * `decodeLegacyWire` assertion.
 */

const B = 'Zq7';

function build(parts: string[]): string {
  return parts.map((p) => `--${B}\r\n${p}\r\n`).join('') + `--${B}--\r\n`;
}

async function parse(text: string): ReturnType<typeof readMultipartBody> {
  return readMultipartBody([Buffer.from(text, 'latin1')], `multipart/form-data; boundary=${B}`);
}

describe('legacy form bridge', () => {
  it('a single `file` part survives into the decoded submission', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7`,
      `Content-Disposition: form-data; name="type"\r\n\r\ninvoice`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    const decoded = decodeLegacyWire('extract', { form, body: legacyFieldsToRecord(body) });
    expect(decoded.variant).toBe('invoice');
    expect(decoded.files).toHaveLength(1);
    expect((decoded.files[0]?.value as { name: string }).name).toBe('invoice.pdf');
  });

  it('repeated `files[]` parts become multiple files in order', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="files[]"; filename="a.pdf"\r\n\r\nAAA`,
      `Content-Disposition: form-data; name="files[]"; filename="b.pdf"\r\n\r\nBBB`,
      `Content-Disposition: form-data; name="type"\r\n\r\ntable`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    const decoded = decodeLegacyWire('extract', { form, body: legacyFieldsToRecord(body) });
    expect(decoded.files).toHaveLength(2);
    expect(decoded.files.map((f) => (f.value as { name: string }).name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('compare keeps source_file ahead of target_file (index-sensitive contract)', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="target_file"; filename="v2.pdf"\r\n\r\nNEW`,
      `Content-Disposition: form-data; name="source_file"; filename="v1.pdf"\r\n\r\nOLD`,
      `Content-Disposition: form-data; name="mode"\r\n\r\ndiff`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    const decoded = decodeLegacyWire('compare', { form, body: legacyFieldsToRecord(body) });
    // The decoder must expose source before target even though target_file
    // was sent first; otherwise compare would diff the documents backwards.
    expect(decoded.files.map((f) => f.field)).toEqual(['source_file', 'target_file']);
    expect(decoded.variant).toBe('diff');
  });

  it('routes a scalar field into the canonical submission input', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="file"; filename="a.docx"\r\n\r\nDOC`,
      `Content-Disposition: form-data; name="type"\r\n\r\ncontract`,
      `Content-Disposition: form-data; name="language"\r\n\r\nvi`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    const decoded = decodeLegacyWire('extract', { form, body: legacyFieldsToRecord(body) });
    expect(decoded.submission.input).toMatchObject({ variant: 'contract', language: 'vi' });
  });

  it('carries output_format and file_urls into the decoded request', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nDOC`,
      `Content-Disposition: form-data; name="type"\r\n\r\ninvoice`,
      `Content-Disposition: form-data; name="output_format"\r\n\r\nmd`,
      `Content-Disposition: form-data; name="file_urls"\r\n\r\n[{"url":"https://example.com/a.pdf"}]`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    const decoded = decodeLegacyWire('extract', { form, body: legacyFieldsToRecord(body) });
    expect(decoded.submission.output).toMatchObject({ format: 'md' });
    expect(decoded.fileUrls).toHaveLength(1);
    expect(decoded.presence.outputFormat).toBe(true);
    expect(decoded.presence.fileUrls).toBe(true);
  });

  it('rejects an unsupported variant through the real decoder', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="type"\r\n\r\nnot-a-variant`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    expect(() => decodeLegacyWire('extract', { form, body: legacyFieldsToRecord(body) }))
      .toThrow(/variant|extract/i);
  });

  it('LegacyFormData mirrors browser get/getAll/has semantics', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="k"\r\n\r\nfirst`,
      `Content-Disposition: form-data; name="k"\r\n\r\nsecond`,
    ]));
    const form = LegacyFormData.fromMultipart(body);
    expect(form.get('k')).toBe('first');
    expect(form.getAll('k')).toEqual(['first', 'second']);
    expect(form.get('absent')).toBeNull();
    expect(form.getAll('absent')).toEqual([]);
    expect(form.has('k')).toBe(true);
  });

  it('legacyFieldsToRecord keeps every value of a repeated field', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="multi"\r\n\r\none`,
      `Content-Disposition: form-data; name="multi"\r\n\r\ntwo`,
      `Content-Disposition: form-data; name="single"\r\n\r\nonly`,
    ]));
    expect(legacyFieldsToRecord(body)).toEqual({ multi: ['one', 'two'], single: 'only' });
  });

  it('legacyFieldsToRecord includes file parts, collapsing repeats to an array', async () => {
    const body = await parse(build([
      `Content-Disposition: form-data; name="file"; filename="one.pdf"\r\n\r\nAAA`,
      `Content-Disposition: form-data; name="type"\r\n\r\ninvoice`,
    ]));
    const record = legacyFieldsToRecord(body) as Record<string, unknown>;
    expect(record.type).toBe('invoice');
    expect(record.file).toMatchObject({ name: 'one.pdf', size: 3 });

    const many = await parse(build([
      `Content-Disposition: form-data; name="files[]"; filename="a.pdf"\r\n\r\nAAA`,
      `Content-Disposition: form-data; name="files[]"; filename="b.pdf"\r\n\r\nBBB`,
    ]));
    const list = legacyFieldsToRecord(many)['files[]'] as { name: string }[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });
});
