import { readMultipartBody, DEFAULT_MAX_MULTIPART_BYTES } from '../src/compat/legacy-multipart';

/**
 * The legacy facade is only as trustworthy as its multipart reader, and this
 * parser runs on raw socket bytes: a boundary that straddles a chunk edge, a
 * file body containing what looks like a delimiter, or a cap that must bite
 * mid-stream. Those are the cases pinned here.
 */

function* chunksOf(text: string, size: number): Generator<Buffer> {
  const buf = Buffer.from(text, 'latin1');
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, Math.min(i + size, buf.length));
  }
}

const B = 'X9Y';

function body(parts: string[], closing = true): string {
  const head = parts.map((p) => `--${B}\r\n${p}\r\n`).join('');
  return `${head}${closing ? `--${B}--\r\n` : ''}`;
}

describe('legacy multipart reader', () => {
  it('reads a scalar field', async () => {
    const raw = body([`Content-Disposition: form-data; name="type"\r\n\r\ninvoice`]);
    const parsed = await readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; boundary=${B}`);
    expect(parsed.fields.get('type')).toEqual(['invoice']);
    expect(parsed.files).toHaveLength(0);
  });

  it('reads a file part with name, filename and content type', async () => {
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="a.docx"\r\nContent-Type: application/vnd.ms-word\r\n\r\nBINARYBYTES`,
    ]);
    const parsed = await readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; boundary=${B}`);
    expect(parsed.files).toEqual([{
      fieldName: 'file',
      fileName: 'a.docx',
      contentType: 'application/vnd.ms-word',
      content: Buffer.from('BINARYBYTES', 'latin1'),
    }]);
  });

  it('keeps every value of a repeated field in order (files[] contract)', async () => {
    const raw = body([
      `Content-Disposition: form-data; name="files[]"; filename="one.pdf"\r\n\r\nAAA`,
      `Content-Disposition: form-data; name="files[]"; filename="two.pdf"\r\n\r\nBBB`,
    ]);
    const parsed = await readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; boundary=${B}`);
    expect(parsed.files.map((f) => f.fileName)).toEqual(['one.pdf', 'two.pdf']);
    expect(parsed.files.map((f) => f.content.toString('latin1'))).toEqual(['AAA', 'BBB']);
  });

  it('produces identical bytes for every chunk size (delimiter straddling)', async () => {
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n${'Z'.repeat(300)}`,
      `Content-Disposition: form-data; name="type"\r\n\r\ncontract`,
    ]);
    const expected = await readMultipartBody(chunksOf(raw, 65536), `multipart/form-data; boundary=${B}`);
    for (const size of [1, 2, 3, 7, 13, 64, 127, 128, 129, 255, 1024]) {
      const got = await readMultipartBody(chunksOf(raw, size), `multipart/form-data; boundary=${B}`);
      expect(got.files[0]?.content.toString('latin1')).toBe(expected.files[0]?.content.toString('latin1'));
      expect(got.fields.get('type')).toEqual(expected.fields.get('type'));
    }
  });

  it('does not treat a lookalike boundary inside file content as a delimiter', async () => {
    // Only the full `--boundary` followed by CRLF ends the part; a bare
    // prefix inside the bytes must survive verbatim.
    const payload = `text before --${B}not-really and ${B} alone`;
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="t.txt"\r\n\r\n${payload}`,
    ]);
    const parsed = await readMultipartBody(chunksOf(raw, 8), `multipart/form-data; boundary=${B}`);
    expect(parsed.files[0]?.content.toString('latin1')).toBe(payload);
  });

  it('preserves CRLF that belongs to the file content, not just the framing', async () => {
    const payload = 'line1\r\nline2\r\n';
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="t.txt"\r\n\r\n${payload}`,
    ]);
    const parsed = await readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; boundary=${B}`);
    expect(parsed.files[0]?.content.toString('latin1')).toBe(payload);
  });

  it('does not decode file bytes as utf-8 (binary safe)', async () => {
    const rawHead = `--${B}\r\nContent-Disposition: form-data; name="file"; filename="b.bin"\r\n\r\n`;
    const rawTail = `\r\n--${B}--\r\n`;
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a]);
    const parsed = await readMultipartBody(
      [Buffer.concat([Buffer.from(rawHead, 'latin1'), bytes, Buffer.from(rawTail, 'latin1')])],
      `multipart/form-data; boundary=${B}`,
    );
    expect([...(parsed.files[0]?.content ?? [])]).toEqual([...bytes]);
  });

  it('accepts a quoted boundary and extra content-type parameters', async () => {
    const raw = body([`Content-Disposition: form-data; name="k"\r\n\r\nv`]);
    const parsed = await readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; charset=utf-8; boundary="${B}"`);
    expect(parsed.fields.get('k')).toEqual(['v']);
  });

  it('rejects a missing boundary with 400', async () => {
    await expect(
      readMultipartBody(chunksOf('--nope--\r\n', 64), 'multipart/form-data'),
    ).rejects.toMatchObject({ status: 400, code: 'MALFORMED_BODY' });
  });

  it('rejects a non-multipart content type with 415', async () => {
    await expect(readMultipartBody(chunksOf('{}', 64), 'application/json')).rejects.toMatchObject({
      status: 415, code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects a missing content type with 415', async () => {
    await expect(readMultipartBody(chunksOf('x', 64), undefined)).rejects.toMatchObject({ status: 415 });
  });

  it('rejects a part with no name with 400', async () => {
    const raw = body([`Content-Type: text/plain\r\n\r\norphan`]);
    await expect(readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; boundary=${B}`)).rejects.toMatchObject({
      status: 400, code: 'MALFORMED_BODY',
    });
  });

  it('rejects a body with no opening boundary with 400', async () => {
    await expect(
      readMultipartBody(chunksOf('just some bytes\r\n', 64), `multipart/form-data; boundary=${B}`),
    ).rejects.toMatchObject({ status: 400, code: 'MALFORMED_BODY' });
  });

  it('enforces the total byte cap while consuming, not after concatenating', async () => {
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n${'Q'.repeat(5000)}`,
    ]);
    await expect(
      readMultipartBody(chunksOf(raw, 512), `multipart/form-data; boundary=${B}`, { maxBytes: 1024 }),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('enforces the per-file cap independently of the total cap', async () => {
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n${'Q'.repeat(300)}`,
      `Content-Disposition: form-data; name="file"; filename="b.bin"\r\n\r\n${'R'.repeat(300)}`,
    ]);
    await expect(
      readMultipartBody(chunksOf(raw, 128), `multipart/form-data; boundary=${B}`, {
        maxBytes: DEFAULT_MAX_MULTIPART_BYTES,
        maxFileBytes: 100,
      }),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('accepts a zero-length file part rather than dropping it', async () => {
    const raw = body([
      `Content-Disposition: form-data; name="file"; filename="empty.txt"\r\n\r\n`,
    ]);
    const parsed = await readMultipartBody(chunksOf(raw, 4096), `multipart/form-data; boundary=${B}`);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.content).toHaveLength(0);
  });

  it('tolerates a body whose final boundary has no trailing CRLF', async () => {
    const raw = `--${B}\r\nContent-Disposition: form-data; name="k"\r\n\r\nv\r\n--${B}--`;
    const parsed = await readMultipartBody(chunksOf(raw, 3), `multipart/form-data; boundary=${B}`);
    expect(parsed.fields.get('k')).toEqual(['v']);
  });

  it('surfaces a stream failure as 400 without echoing chunk bytes', async () => {
    async function* boom(): AsyncGenerator<Buffer> {
      yield Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="k"\r\n\r\nsecret-payload`, 'latin1');
      throw new Error('socket exploded with SECRET-LEAK');
    }
    const err = await readMultipartBody(boom(), `multipart/form-data; boundary=${B}`).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'MALFORMED_BODY' });
    expect(String(err)).not.toContain('SECRET-LEAK');
  });
});
