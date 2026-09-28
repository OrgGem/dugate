import { SafeArchiveExtractor } from '../src/archives/zip-extractor';
import { DocumentParserFactory } from '../src/parsers/factory';
import { TestFixtures } from './fixtures/test-fixtures';
import { runIsolatedWorker } from '../src/parsers/worker-isolation';

interface LocalRecordOptions {
  name?: string;
  flags?: number;
  compressionMethod?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  extraField?: Buffer;
  data?: Buffer;
}

function createLocalRecord(options: LocalRecordOptions = {}): Buffer {
  const name = Buffer.from(options.name ?? 'entry.bin', 'utf8');
  const data = options.data ?? Buffer.alloc(0);
  const extraField = options.extraField ?? Buffer.alloc(0);
  const header = Buffer.alloc(30 + name.length + extraField.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(options.flags ?? 0, 6);
  header.writeUInt16LE(options.compressionMethod ?? 0, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(options.compressedSize ?? data.length, 18);
  header.writeUInt32LE(options.uncompressedSize ?? data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extraField.length, 28);
  name.copy(header, 30);
  extraField.copy(header, 30 + name.length);
  return Buffer.concat([header, data]);
}

describe('R1-E ZIP64 and data descriptor boundaries', () => {
  it.each([
    {
      scenario: 'ZIP64 sentinel sizes in a local header',
      archive: () =>
        createLocalRecord({ compressedSize: 0xffffffff, uncompressedSize: 0xffffffff }),
      code: 'ARCHIVE_ZIP64_UNSUPPORTED',
    },
    {
      scenario: 'ZIP64 extra field without sentinel sizes',
      archive: () => {
        const extra = Buffer.alloc(12);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        return createLocalRecord({ extraField: extra });
      },
      code: 'ARCHIVE_ZIP64_UNSUPPORTED',
    },
    {
      scenario: 'ZIP64 sizes in the central directory',
      archive: () => {
        const archive = TestFixtures.createZipArchive([
          { name: 'entry.bin', content: Buffer.from('x') },
        ]);
        const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        archive.writeUInt32LE(0xffffffff, centralOffset + 24);
        return archive;
      },
      code: 'ARCHIVE_ZIP64_UNSUPPORTED',
    },
    {
      scenario: 'ZIP64 end locator after the central directory',
      archive: () => {
        const archive = TestFixtures.createZipArchive([
          { name: 'entry.bin', content: Buffer.from('x') },
        ]);
        const endOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        const locator = Buffer.alloc(4);
        locator.writeUInt32LE(0x07064b50, 0);
        return Buffer.concat([archive.subarray(0, endOffset), locator, archive.subarray(endOffset)]);
      },
      code: 'ARCHIVE_ZIP64_UNSUPPORTED',
    },
  ])('fails closed on $scenario', async ({ archive, code }) => {
    await expect(SafeArchiveExtractor.preflightBuffer(archive())).rejects.toMatchObject({ code });
  });

  it.each([
    {
      scenario: 'the data descriptor flag',
      archive: () => createLocalRecord({ flags: 0x0008 }),
    },
    {
      scenario: 'an unexpected signed data descriptor record',
      archive: () => {
        const signature = Buffer.alloc(4);
        signature.writeUInt32LE(0x08074b50, 0);
        return Buffer.concat([createLocalRecord(), signature]);
      },
    },
  ])('rejects unsupported data descriptors with a stable code ($scenario)', async ({ archive }) => {
    await expect(SafeArchiveExtractor.preflightBuffer(archive())).rejects.toMatchObject({
      code: 'ARCHIVE_DATA_DESCRIPTOR_UNSUPPORTED',
    });
  });

  it('rejects declared compressed ranges beyond the input as malformed', async () => {
    await expect(
      SafeArchiveExtractor.preflightBuffer(
        createLocalRecord({ compressionMethod: 8, compressedSize: 100, uncompressedSize: 1 })
      )
    ).rejects.toThrow(/compressed data .* is truncated/);
  });
});

describe('R1-E worker-thread CPU timeout guard', () => {
  it('runs Office preflight and parsing inside the built-in parser worker', async () => {
    const factory = new DocumentParserFactory();
    const result = await factory.parseBuffer(
      TestFixtures.createSyntheticDocx('worker isolated Office parse'),
      'worker.docx',
      undefined,
      { timeoutMs: 5000 }
    );

    expect(result.text).toContain('worker isolated Office parse');
    expect(result.metadata.detectedFormat).toBe('docx');
  });

  it('preserves fail-closed ZIP descriptor codes across the worker boundary', async () => {
    const factory = new DocumentParserFactory();
    const descriptorDocx = createLocalRecord({
      name: 'word/document.xml',
      flags: 0x0008,
    });

    await expect(factory.parseBuffer(descriptorDocx, 'descriptor.docx')).rejects.toMatchObject({
      code: 'ARCHIVE_DATA_DESCRIPTOR_UNSUPPORTED',
    });
  });

  it('terminates synchronous worker CPU and keeps the caller event loop responsive', async () => {
    const spinWorker = `
      const { parentPort } = require('node:worker_threads');
      void parentPort;
      while (true) {}
    `;
    let heartbeatRan = false;
    const heartbeat = setTimeout(() => {
      heartbeatRan = true;
    }, 5);

    await expect(runIsolatedWorker(spinWorker, {}, 40, 'Synthetic parser')).rejects.toThrow(
      /Synthetic parser timed out after 40ms budget/
    );
    clearTimeout(heartbeat);
    expect(heartbeatRan).toBe(true);
  });
});
