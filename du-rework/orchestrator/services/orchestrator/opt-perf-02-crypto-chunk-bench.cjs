#!/usr/bin/env node
'use strict';

// Offline benchmark for the production CryptoStorageFacade with an in-memory
// chunk-size substitution. The source tree is read-only: TypeScript is
// transpiled and loaded from memory, with only the exported chunk constant
// replaced for each child process.

const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ts = require('typescript');

const MIB = 1024 * 1024;
const DEFAULT_GEOMETRIES_MIB = [1, 2, 4, 8];
const SOURCE_PATH = path.join(
  __dirname,
  'src',
  'modules',
  'encryption',
  'crypto-storage-facade.ts',
);

function parsePositiveInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseWorkerArgs(argv) {
  const values = Object.create(null);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Invalid option: ${argument}`);
    values[match[1]] = match[2];
  }
  return values;
}

function loadFacadeAtChunkSize(chunkSizeBytes) {
  const original = readFileSync(SOURCE_PATH, 'utf8');
  const declaration = 'export const CRYPTO_STORAGE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;';
  if (!original.includes(declaration)) {
    throw new Error('Production chunk-size declaration changed; refusing an unpinned benchmark');
  }
  const variant = original.replace(
    declaration,
    `export const CRYPTO_STORAGE_CHUNK_SIZE_BYTES = ${chunkSizeBytes};`,
  );
  const transpiled = ts.transpileModule(variant, {
    fileName: SOURCE_PATH,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const loaded = new Module(SOURCE_PATH, module);
  loaded.filename = SOURCE_PATH;
  loaded.paths = Module._nodeModulePaths(path.dirname(SOURCE_PATH));
  loaded._compile(transpiled.outputText, SOURCE_PATH);
  return loaded.exports;
}

function benchmarkContext() {
  return {
    tenantId: 'opt-perf-bench-tenant',
    artifactId: 'opt-perf-bench-artifact',
    objectVersion: 'bench-v1',
    purpose: 'crypto-chunk-benchmark',
    keyRef: 'mock-local-key-provider',
    keyVersion: 1,
  };
}

function createMockKeyProvider(retainDek = false) {
  const wrapped = new Map();
  return {
    wrapped,
    provider: {
      async wrapDek(input) {
        const token = retainDek ? randomUUID() : 'offline-mock-wrapped-dek';
        if (retainDek) wrapped.set(token, Buffer.from(input.dek));
        return {
          keyRef: input.keyRef,
          keyVersion: input.keyVersion ?? 1,
          ciphertext: token,
        };
      },
      async unwrapDek(value) {
        const key = wrapped.get(value.ciphertext);
        if (!key) throw new Error('mock wrapped DEK not found');
        return Buffer.from(key);
      },
    },
  };
}

async function* repeatedPatternSource(totalBytes, blockBytes = 256 * 1024) {
  const block = Buffer.alloc(blockBytes);
  for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + 97) & 0xff;
  let remaining = totalBytes;
  while (remaining > 0) {
    const count = Math.min(remaining, block.length);
    yield block.subarray(0, count);
    remaining -= count;
  }
  block.fill(0);
}

async function* bufferSource(buffer, blockBytes = 256 * 1024) {
  for (let offset = 0; offset < buffer.length; offset += blockBytes) {
    yield buffer.subarray(offset, Math.min(buffer.length, offset + blockBytes));
  }
}

function assertManifest(manifest, chunkSizeBytes, totalSizeBytes) {
  const expectedChunks = Math.ceil(totalSizeBytes / chunkSizeBytes);
  if (
    manifest.version !== 1
    || manifest.algorithm !== 'aes-256-gcm'
    || manifest.chunkSizeBytes !== chunkSizeBytes
    || manifest.totalSizeBytes !== totalSizeBytes
    || manifest.totalChunks !== expectedChunks
    || !/^[a-f0-9]{64}$/.test(manifest.fileSha256)
    || typeof manifest.contextAad !== 'string'
    || typeof manifest.manifestMac !== 'string'
    || !Array.isArray(manifest.chunks)
    || manifest.chunks.length !== expectedChunks
    || !manifest.dek
  ) {
    throw new Error('Manifest does not match the production envelope fields');
  }
  let seenBytes = 0;
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const chunk = manifest.chunks[index];
    if (
      chunk.index !== index
      || !/^[a-f0-9]{64}$/.test(chunk.sha256)
      || typeof chunk.nonce !== 'string'
      || typeof chunk.tag !== 'string'
      || !Number.isSafeInteger(chunk.sizeBytes)
      || chunk.sizeBytes < 1
      || chunk.sizeBytes > chunkSizeBytes
    ) {
      throw new Error('Manifest chunk metadata is malformed');
    }
    seenBytes += chunk.sizeBytes;
  }
  if (seenBytes !== totalSizeBytes) throw new Error('Manifest chunk sizes do not sum to input size');
}

async function verifyRoundTrip(CryptoStorageFacade, chunkSizeBytes) {
  const totalSizeBytes = Math.max(8 * MIB + 73, chunkSizeBytes * 2 + 73);
  const original = Buffer.alloc(totalSizeBytes, 0xa7);
  const originalHash = createHash('sha256').update(original).digest('hex');
  const keys = createMockKeyProvider(true);
  const facade = new CryptoStorageFacade(keys.provider);
  const encrypted = facade.encryptStream(bufferSource(original), benchmarkContext());
  const ciphertextParts = [];
  for await (const part of encrypted.ciphertext) ciphertextParts.push(Buffer.from(part));
  const manifest = await encrypted.manifest;
  assertManifest(manifest, chunkSizeBytes, totalSizeBytes);

  const decrypted = facade.decryptStream(
    Readable.from(ciphertextParts, { objectMode: false }),
    manifest,
    benchmarkContext(),
  );
  const hash = createHash('sha256');
  let byteCount = 0;
  for await (const part of decrypted) {
    hash.update(part);
    byteCount += part.length;
    part.fill(0);
  }
  const decryptedHash = hash.digest('hex');
  for (const part of ciphertextParts) part.fill(0);
  original.fill(0);
  for (const key of keys.wrapped.values()) key.fill(0);
  keys.wrapped.clear();
  if (byteCount !== totalSizeBytes || decryptedHash !== originalHash) {
    throw new Error('AES-GCM facade round-trip integrity check failed');
  }
  return { totalSizeBytes, totalChunks: manifest.totalChunks };
}

function currentRssBytes() {
  return process.memoryUsage().rss;
}

async function encryptToMockStorage(facade, totalSizeBytes, chunkSizeBytes, hwmBytes, sampler) {
  let storedBytes = 0;
  const storage = new Writable({
    highWaterMark: hwmBytes,
    write(chunk, _encoding, callback) {
      storedBytes += chunk.byteLength;
      sampler.sample();
      // An asynchronous acknowledgement emulates a bounded object-storage
      // sink and allows stream backpressure and RSS sampling to run.
      setImmediate(callback);
    },
  });
  const encrypted = facade.encryptStream(repeatedPatternSource(totalSizeBytes), benchmarkContext());
  await pipeline(encrypted.ciphertext, storage);
  const manifest = await encrypted.manifest;
  assertManifest(manifest, chunkSizeBytes, totalSizeBytes);
  if (storedBytes !== totalSizeBytes) throw new Error('Mock storage received an unexpected ciphertext byte count');
  return { manifest, storedBytes };
}

async function runWorker(options) {
  const chunkSizeBytes = parsePositiveInteger(options.chunkBytes, 'chunkBytes', 4 * MIB);
  const totalSizeBytes = parsePositiveInteger(options.sizeBytes, 'sizeBytes', 128 * MIB + 123);
  const run = parsePositiveInteger(options.run, 'run', 1);
  const hwmBytes = chunkSizeBytes * 2;
  const production = loadFacadeAtChunkSize(chunkSizeBytes);
  const roundTrip = await verifyRoundTrip(production.CryptoStorageFacade, chunkSizeBytes);
  const mock = createMockKeyProvider(false);
  const facade = new production.CryptoStorageFacade(mock.provider);

  await encryptToMockStorage(facade, 24 * MIB + 17, chunkSizeBytes, hwmBytes, { sample() {} });
  if (typeof global.gc === 'function') global.gc();

  const baselineRssBytes = currentRssBytes();
  const sampler = {
    peakRssBytes: baselineRssBytes,
    sample() {
      const rss = currentRssBytes();
      if (rss > this.peakRssBytes) this.peakRssBytes = rss;
    },
  };
  const timer = setInterval(() => sampler.sample(), 2);
  const startedAt = performance.now();
  try {
    const result = await encryptToMockStorage(facade, totalSizeBytes, chunkSizeBytes, hwmBytes, sampler);
    sampler.sample();
    const elapsedMs = performance.now() - startedAt;
    const mibPerSecond = totalSizeBytes / MIB / (elapsedMs / 1000);
    process.stdout.write(JSON.stringify({
      chunkBytes: chunkSizeBytes,
      hwmBytes,
      run,
      inputBytes: totalSizeBytes,
      ciphertextBytes: result.storedBytes,
      chunks: result.manifest.totalChunks,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      mibPerSecond: Number(mibPerSecond.toFixed(2)),
      baselineRssBytes,
      peakRssBytes: sampler.peakRssBytes,
      peakRssDeltaBytes: Math.max(0, sampler.peakRssBytes - baselineRssBytes),
      roundTrip: 'pass',
      roundTripBytes: roundTrip.totalSizeBytes,
      roundTripChunks: roundTrip.totalChunks,
    }) + '\n');
  } finally {
    clearInterval(timer);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseParentOptions(argv) {
  const values = Object.create(null);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Invalid option: ${argument}`);
    values[match[1]] = match[2];
  }
  return values;
}

function runParent(argv) {
  const options = parseParentOptions(argv);
  const sizeMiB = parsePositiveInteger(options['size-mib'], 'size-mib', 128);
  const repetitions = parsePositiveInteger(options.runs, 'runs', 3);
  const geometries = (options['chunk-mib'] ?? DEFAULT_GEOMETRIES_MIB.join(','))
    .split(',')
    .map((value) => parsePositiveInteger(value, 'chunk-mib value', 4));
  const inputBytes = sizeMiB * MIB + 123;
  const results = [];

  for (const chunkMiB of geometries) {
    for (let run = 1; run <= repetitions; run += 1) {
      const child = spawnSync(process.execPath, [
        '--expose-gc',
        __filename,
        '--worker',
        `--chunkBytes=${chunkMiB * MIB}`,
        `--sizeBytes=${inputBytes}`,
        `--run=${run}`,
      ], { encoding: 'utf8', maxBuffer: 4 * MIB });
      if (child.error) throw child.error;
      if (child.status !== 0) {
        process.stderr.write(child.stderr || child.stdout);
        throw new Error(`Worker failed for ${chunkMiB} MiB geometry, run ${run}, exit ${child.status}`);
      }
      results.push(JSON.parse(child.stdout.trim()));
    }
  }

  const baseline = results.filter((entry) => entry.chunkBytes === 4 * MIB);
  if (baseline.length === 0) throw new Error('Include the 4 MiB production baseline geometry');
  const baselineThroughput = median(baseline.map((entry) => entry.mibPerSecond));
  const rows = geometries.map((chunkMiB) => {
    const group = results.filter((entry) => entry.chunkBytes === chunkMiB * MIB);
    const throughput = median(group.map((entry) => entry.mibPerSecond));
    const peakDeltaMiB = median(group.map((entry) => entry.peakRssDeltaBytes / MIB));
    const peakRssMiB = median(group.map((entry) => entry.peakRssBytes / MIB));
    return {
      chunkMiB,
      highWaterMarkMiB: chunkMiB * 2,
      repetitions: group.length,
      medianMiBPerSecond: Number(throughput.toFixed(2)),
      minMiBPerSecond: Number(Math.min(...group.map((entry) => entry.mibPerSecond)).toFixed(2)),
      maxMiBPerSecond: Number(Math.max(...group.map((entry) => entry.mibPerSecond)).toFixed(2)),
      medianPeakRssMiB: Number(peakRssMiB.toFixed(2)),
      medianPeakRssDeltaMiB: Number(peakDeltaMiB.toFixed(2)),
      vsProductionPct: Number(((throughput / baselineThroughput - 1) * 100).toFixed(2)),
      roundTrips: group.every((entry) => entry.roundTrip === 'pass') ? 'pass' : 'fail',
    };
  });

  process.stdout.write(`Crypto chunk geometry benchmark (mock storage, local AES-GCM)\n`);
  process.stdout.write(`Input: ${(inputBytes / MIB).toFixed(2)} MiB per measured run; repetitions: ${repetitions}; source block: 0.25 MiB\n`);
  process.stdout.write('Chunk MiB | HWM MiB | Median MiB/s | Min–max MiB/s | Median peak RSS MiB | Peak delta MiB | vs 4 MiB\n');
  for (const row of rows) {
    process.stdout.write(
      `${row.chunkMiB} | ${row.highWaterMarkMiB} | ${row.medianMiBPerSecond} | `
      + `${row.minMiBPerSecond}–${row.maxMiBPerSecond} | ${row.medianPeakRssMiB} | `
      + `${row.medianPeakRssDeltaMiB} | ${row.vsProductionPct}%\n`,
    );
  }
  process.stdout.write(`Raw runs: ${JSON.stringify(results)}\n`);
  process.stdout.write('Scope: production facade transpiled in memory; only chunk constant substituted; mocked immediate DEK provider and bounded mock storage; no infra.\n');
}

async function main() {
  if (process.argv[2] === '--worker') {
    const options = parseWorkerArgs(process.argv.slice(3));
    await runWorker(options);
    return;
  }
  runParent(process.argv.slice(2));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
