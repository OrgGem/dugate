import * as zlib from 'zlib';
import { SafeArchiveExtractor } from '../src/archives/zip-extractor';
import { TestFixtures } from './fixtures/test-fixtures';

describe('SafeArchiveExtractor (ART-03)', () => {
  it('successfully extracts safe zip entries', async () => {
    const zip = TestFixtures.createZipArchive([
      { name: 'file1.txt', content: Buffer.from('Hello world', 'utf8') },
      { name: 'sub/file2.txt', content: Buffer.from('Nested content', 'utf8') },
    ]);

    const result = await SafeArchiveExtractor.extractBuffer(zip);
    expect(result.fileCount).toBe(2);
    expect(result.entries.map((e) => e.path)).toEqual(['file1.txt', 'sub/file2.txt']);
    expect(result.entries[0]?.content?.toString('utf8')).toBe('Hello world');
  });

  it('rejects Zip Slip directory traversal (..)', async () => {
    const maliciousZip = TestFixtures.createZipArchive([
      { name: '../../etc/passwd', content: Buffer.from('root:x:0:0', 'utf8') },
    ]);

    await expect(SafeArchiveExtractor.extractBuffer(maliciousZip)).rejects.toThrow(
      /Archive security violation: Directory traversal/
    );
  });

  it('rejects Zip Slip absolute path escaping (POSIX root /)', async () => {
    const maliciousZip = TestFixtures.createZipArchive([
      { name: '/var/log/secret.txt', content: Buffer.from('leaked', 'utf8') },
    ]);

    await expect(SafeArchiveExtractor.extractBuffer(maliciousZip)).rejects.toThrow(
      /Archive security violation: Absolute path traversal detected/
    );
  });

  it('rejects Zip Slip Windows absolute path escaping (C:\\)', async () => {
    const maliciousZip = TestFixtures.createZipArchive([
      { name: 'C:\\Windows\\System32\\evil.dll', content: Buffer.from('malware', 'utf8') },
    ]);

    await expect(SafeArchiveExtractor.extractBuffer(maliciousZip)).rejects.toThrow(
      /Archive security violation: Absolute path traversal detected/
    );
  });

  it('guards against file count exhaustion (maxFileCount limit)', async () => {
    const multiFileZip = TestFixtures.createZipArchive([
      { name: 'file1.txt', content: Buffer.from('a', 'utf8') },
      { name: 'file2.txt', content: Buffer.from('b', 'utf8') },
      { name: 'file3.txt', content: Buffer.from('c', 'utf8') },
      { name: 'file4.txt', content: Buffer.from('d', 'utf8') },
    ]);

    await expect(
      SafeArchiveExtractor.extractBuffer(multiFileZip, { maxFileCount: 2 })
    ).rejects.toThrow(/Archive security violation: Exceeded maximum allowed entry count/);
  });

  it('guards against excessive uncompressed size (Zip Bomb protection)', async () => {
    const largeContent = Buffer.alloc(2000, 'A');
    const zip = TestFixtures.createZipArchive([
      { name: 'big.txt', content: largeContent },
    ]);

    // Set maxTotalSize threshold below entry size
    await expect(
      SafeArchiveExtractor.extractBuffer(zip, { maxTotalSize: 500, maxDecompressionRatio: 200 })
    ).rejects.toThrow(/Archive security violation: Decompressed size exceeds maximum/);
  });

  it('guards against suspicious compression ratio in header', async () => {
    // 50,000 zeros compresses down to roughly 50 bytes -> ratio > 500:1
    const bombContent = Buffer.alloc(50000, 0);
    const bombZip = TestFixtures.createZipArchive([
      { name: 'bomb.txt', content: bombContent },
    ]);

    await expect(
      SafeArchiveExtractor.extractBuffer(bombZip, { maxDecompressionRatio: 20 })
    ).rejects.toThrow(/Archive security violation: Suspicious compression ratio/);
  });

  it('guards against deceptive header with bounded decompression memory limits (ERR_BUFFER_TOO_LARGE)', async () => {
    // Construct a deceptive ZIP where local header claims uncompressedSize is small (50 bytes)
    // but the deflated payload actually contains 50,000 bytes
    const realPayload = Buffer.alloc(50000, 0x41);
    const deflated = zlib.deflateRawSync(realPayload);

    const fileName = Buffer.from('deceptive.txt', 'utf8');
    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8); // Deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0x12345678, 14); // CRC32
    localHeader.writeUInt32LE(deflated.length, 18); // Compressed size (~60 bytes)
    localHeader.writeUInt32LE(50, 22); // DECEPTIVE: claims only 50 bytes uncompressed!
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileName.copy(localHeader, 30);

    const deceptiveZip = Buffer.concat([localHeader, deflated]);

    // With bounded decompression, the extractor passes maxOutputLength: Math.min(...)
    // When zlib hits that ceiling during inflateRawSync, it throws ERR_BUFFER_TOO_LARGE
    await expect(
      SafeArchiveExtractor.extractBuffer(deceptiveZip, {
        maxDecompressionRatio: 2,
        maxTotalSize: 1000,
      })
    ).rejects.toThrow(/exceeded bounded decompression memory limit/);
  });
});
