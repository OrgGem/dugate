import * as zlib from 'zlib';
import { SafeArchiveExtractor } from '../src/archives/zip-extractor';
import { DocumentParserFactory } from '../src/parsers/factory';
import { ExcelParser } from '../src/parsers/excel-parser';
import { WordParser } from '../src/parsers/word-parser';
import { ArchiveExtractOptions } from '../src/types';
import { TestFixtures } from './fixtures/test-fixtures';

interface RejectionCase {
  name: string;
  buffer: Buffer;
  options?: ArchiveExtractOptions;
  expectedFormat?: 'docx' | 'xlsx';
}

interface LocalEntryOptions {
  name: string;
  compressedData: Buffer;
  compressionMethod: number;
  uncompressedSize: number;
  crc32: number;
}

const mammothModule = require('mammoth') as {
  extractRawText: (...args: unknown[]) => unknown;
};
const xlsxModule = require('xlsx') as {
  read: (...args: unknown[]) => unknown;
};

function createLocalEntry(options: LocalEntryOptions): Buffer {
  const fileName = Buffer.from(options.name, 'utf8');
  const header = Buffer.alloc(30 + fileName.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(options.compressionMethod, 8);
  header.writeUInt32LE(options.crc32, 14);
  header.writeUInt32LE(options.compressedData.length, 18);
  header.writeUInt32LE(options.uncompressedSize, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  fileName.copy(header, 30);
  return Buffer.concat([header, options.compressedData]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createRatioViolationDocx(): Buffer {
  return TestFixtures.createZipArchive([
    { name: 'word/document.xml', content: Buffer.alloc(20_000, 0x41) },
  ]);
}

function createDeceptiveSizeDocx(): Buffer {
  const actualContent = Buffer.alloc(4096, 0x41);
  const compressedData = zlib.deflateRawSync(actualContent);
  return createLocalEntry({
    name: 'word/document.xml',
    compressedData,
    compressionMethod: 8,
    uncompressedSize: 8,
    crc32: crc32(actualContent),
  });
}

function createCorruptDeflateOfficeArchive(name: 'word/document.xml' | 'xl/workbook.xml'): Buffer {
  return createLocalEntry({
    name,
    compressedData: Buffer.from([0xff]),
    compressionMethod: 8,
    uncompressedSize: 2,
    crc32: 0,
  });
}

function createTraversalOfficeArchive(name: 'word/document.xml' | 'xl/workbook.xml'): Buffer {
  return TestFixtures.createZipArchive([
    { name, content: Buffer.from('<office/>') },
    { name: '../escape.txt', content: Buffer.from('x') },
  ]);
}

function createZipBombOfficeArchive(name: 'word/document.xml' | 'xl/workbook.xml'): Buffer {
  return TestFixtures.createZipArchive([{ name, content: Buffer.alloc(50_000, 0) }]);
}

const metadataRejections: RejectionCase[] = [
  {
    name: 'truncated local header',
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    expectedFormat: 'docx',
  },
  {
    name: 'path traversal',
    buffer: TestFixtures.createZipArchive([
      { name: '../word/document.xml', content: Buffer.from('<document/>') },
    ]),
    expectedFormat: 'docx',
  },
  {
    name: 'entry count over limit',
    buffer: TestFixtures.createZipArchive([
      { name: 'word/document.xml', content: Buffer.from('a') },
      { name: 'word/extra.xml', content: Buffer.from('b') },
    ]),
    options: { maxFileCount: 1 },
    expectedFormat: 'docx',
  },
  {
    name: 'expanded size over limit',
    buffer: TestFixtures.createZipArchive([
      { name: 'word/document.xml', content: Buffer.alloc(32, 0x41) },
    ]),
    options: { maxTotalSize: 16 },
    expectedFormat: 'docx',
  },
  {
    name: 'declared compression ratio over limit',
    buffer: createRatioViolationDocx(),
    options: { maxDecompressionRatio: 10 },
    expectedFormat: 'docx',
  },
  {
    name: 'unsupported compression method',
    buffer: createLocalEntry({
      name: 'word/document.xml',
      compressedData: Buffer.from('payload'),
      compressionMethod: 99,
      uncompressedSize: 7,
      crc32: 0,
    }),
    expectedFormat: 'docx',
  },
];

describe('R1-E archive preflight boundary', () => {
  let inflateSpy: jest.SpyInstance;

  beforeEach(() => {
    inflateSpy = jest.spyOn(SafeArchiveExtractor, 'decompressRaw');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(metadataRejections)('rejects $name before decompression', async (testCase) => {
    await expect(
      SafeArchiveExtractor.preflightBuffer(
        testCase.buffer,
        testCase.options,
        testCase.expectedFormat
      )
    ).rejects.toThrow(/Archive security violation/);
    expect(inflateSpy).not.toHaveBeenCalled();
  });

  it('bounds actual inflate output when local headers understate expanded size', async () => {
    await expect(
      SafeArchiveExtractor.preflightBuffer(createDeceptiveSizeDocx(), {}, 'docx')
    ).rejects.toThrow(/exceeded bounded decompression memory limit/);
    expect(inflateSpy).toHaveBeenCalledTimes(1);
  });

  it('checks Office archive markers before decompression and parser dispatch', async () => {
    const mislabeledZip = TestFixtures.createZipArchive([
      { name: 'payload.txt', content: Buffer.from('ordinary ZIP content') },
    ]);
    const factory = new DocumentParserFactory();
    const dispatchSpy = jest.spyOn(factory, 'getParser');

    await expect(factory.parseBufferCore(mislabeledZip, 'invoice.docx')).rejects.toThrow(
      /Office declaration does not match DOCX\/XLSX container markers/
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(inflateSpy).not.toHaveBeenCalled();
  });

  it('rejects truncated ZIP input identified by filename before parser lookup', async () => {
    const factory = new DocumentParserFactory();
    const dispatchSpy = jest.spyOn(factory, 'getParser');

    await expect(factory.parseBufferCore(Buffer.from([0x50, 0x4b]), 'broken.zip')).rejects.toThrow(
      /Malformed ZIP archive/
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(inflateSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      parserName: 'WordParser',
      scenario: 'zip bomb',
      fileName: 'bomb.docx',
      makeArchive: () => createZipBombOfficeArchive('word/document.xml'),
      expectedError: /Suspicious compression ratio/,
      decompressorCalls: 0,
    },
    {
      parserName: 'WordParser',
      scenario: 'path traversal',
      fileName: 'slip.docx',
      makeArchive: () => createTraversalOfficeArchive('word/document.xml'),
      expectedError: /Directory traversal/,
      decompressorCalls: 0,
    },
    {
      parserName: 'WordParser',
      scenario: 'empty archive',
      fileName: 'empty.docx',
      makeArchive: () => TestFixtures.createZipArchive([]),
      expectedError: /required DOCX entry/,
      decompressorCalls: 0,
    },
    {
      parserName: 'WordParser',
      scenario: 'decompression error',
      fileName: 'broken.docx',
      makeArchive: () => createCorruptDeflateOfficeArchive('word/document.xml'),
      expectedError: /Failed to decompress/,
      decompressorCalls: 1,
    },
    {
      parserName: 'ExcelParser',
      scenario: 'zip bomb',
      fileName: 'bomb.xlsx',
      makeArchive: () => createZipBombOfficeArchive('xl/workbook.xml'),
      expectedError: /Suspicious compression ratio/,
      decompressorCalls: 0,
    },
    {
      parserName: 'ExcelParser',
      scenario: 'path traversal',
      fileName: 'slip.xlsx',
      makeArchive: () => createTraversalOfficeArchive('xl/workbook.xml'),
      expectedError: /Directory traversal/,
      decompressorCalls: 0,
    },
    {
      parserName: 'ExcelParser',
      scenario: 'empty archive',
      fileName: 'empty.xlsx',
      makeArchive: () => TestFixtures.createZipArchive([]),
      expectedError: /required XLSX entry/,
      decompressorCalls: 0,
    },
    {
      parserName: 'ExcelParser',
      scenario: 'decompression error',
      fileName: 'broken.xlsx',
      makeArchive: () => createCorruptDeflateOfficeArchive('xl/workbook.xml'),
      expectedError: /Failed to decompress/,
      decompressorCalls: 1,
    },
  ])('$parserName direct parse rejects $scenario', async (testCase) => {
    const isWord = testCase.parserName === 'WordParser';
    const parser = isWord ? new WordParser() : new ExcelParser();
    const downstreamSpy = isWord
      ? jest.spyOn(mammothModule, 'extractRawText')
      : jest.spyOn(xlsxModule, 'read');

    await expect(parser.parseCore(testCase.makeArchive(), testCase.fileName)).rejects.toThrow(
      testCase.expectedError
    );
    expect(downstreamSpy).not.toHaveBeenCalled();
    expect(inflateSpy).toHaveBeenCalledTimes(testCase.decompressorCalls);
  });

  it('rejects corrupt deflate data before parser dispatch or fallback libraries', async () => {
    const factory = new DocumentParserFactory();
    const dispatchSpy = jest.spyOn(factory, 'getParser');
    const wordFallbackSpy = jest.spyOn(mammothModule, 'extractRawText');
    const excelDispatchSpy = jest.spyOn(xlsxModule, 'read');

    await expect(
      factory.parseBufferCore(
        createCorruptDeflateOfficeArchive('word/document.xml'),
        'broken.docx'
      )
    ).rejects.toThrow(/Failed to decompress/);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(wordFallbackSpy).not.toHaveBeenCalled();
    expect(inflateSpy).toHaveBeenCalledTimes(1);

    expect(excelDispatchSpy).not.toHaveBeenCalled();
  });

  it('dispatches a verified DOCX and reuses preflight output without a second inflate', async () => {
    const factory = new DocumentParserFactory();
    const dispatchSpy = jest.spyOn(factory, 'getParser');
    const docx = TestFixtures.createSyntheticDocx('Preflight verified text');

    const result = await factory.parseBufferCore(docx, 'verified.docx');

    expect(result.text).toContain('Preflight verified text');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(inflateSpy).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached preflight output if its source buffer changes', async () => {
    const docx = TestFixtures.createSyntheticDocx('preflight cache source');
    await SafeArchiveExtractor.preflightBuffer(docx, {}, 'docx');
    docx.fill(0);

    await expect(SafeArchiveExtractor.extractBuffer(docx)).rejects.toThrow(/Malformed ZIP archive/);
  });
});
