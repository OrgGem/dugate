'use strict';

// Offline micro-benchmark for the bounded-ingress concat call. This isolates
// only Buffer.concat's optional totalLength argument; it does not simulate an
// HTTP listener, JSON parsing, or production request latency.

const BODY_BYTES = 64 * 1024;
const SAMPLE_COUNT = 9;
const ITERATIONS_PER_SAMPLE = 1500;
let sink = 0;

function makeChunks(sizes) {
  return sizes.map((size, index) => Buffer.alloc(size, (index * 37 + 11) & 0xff));
}

function chunkBytes(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function concat(chunks, withTotalLength, total) {
  return withTotalLength ? Buffer.concat(chunks, total) : Buffer.concat(chunks);
}

function runSample(chunks, withTotalLength, total, iterations) {
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const output = concat(chunks, withTotalLength, total);
    sink ^= output.length ^ output[0] ^ output[output.length - 1];
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function collectBetweenSamples() {
  if (typeof global.gc === 'function') global.gc();
}

function assertEquivalent(chunks, total) {
  const computedLength = chunkBytes(chunks);
  const withoutTotal = Buffer.concat(chunks);
  const withTotal = Buffer.concat(chunks, total);
  if (computedLength !== total || withoutTotal.length !== withTotal.length
      || !withoutTotal.equals(withTotal)) {
    throw new Error(`concat results differ: expected ${total}, computed ${computedLength}`);
  }
}

// Correctness edges for the exact API used by ingress.ts.
assertEquivalent([], 0);
assertEquivalent(makeChunks([BODY_BYTES]), BODY_BYTES);
assertEquivalent(makeChunks([BODY_BYTES / 2, BODY_BYTES / 2]), BODY_BYTES);
assertEquivalent(makeChunks([1024 * 1024]), 1024 * 1024); // exact 1 MiB JSON cap

const shapes = [
  { name: 'single-64KiB', sizes: [BODY_BYTES] },
  { name: '64x1KiB', sizes: Array(64).fill(1024) },
  { name: 'mixed-64KiB', sizes: [32768, 16384, 8192, ...Array(8).fill(1024)] },
  { name: '256x256B', sizes: Array(256).fill(256) },
];

console.log(`Node ${process.version}; ${process.platform}/${process.arch}`);
console.log(`samples=${SAMPLE_COUNT}; iterations/sample=${ITERATIONS_PER_SAMPLE}; body=${BODY_BYTES} bytes; explicit_gc=${typeof global.gc === 'function'}`);
console.log('shape,chunks,bytes,median_no_total_ms,median_with_total_ms,gain_percent');

for (const shape of shapes) {
  const chunks = makeChunks(shape.sizes);
  const total = chunkBytes(chunks);
  if (total !== BODY_BYTES) throw new Error(`${shape.name} is ${total} bytes, expected ${BODY_BYTES}`);
  assertEquivalent(chunks, total);

  // Warm both call shapes before timing.
  runSample(chunks, false, total, 100);
  runSample(chunks, true, total, 100);
  collectBetweenSamples();

  const noTotalTimes = [];
  const withTotalTimes = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    // Alternate order to reduce systematic warm-up/order bias.
    if (sample % 2 === 0) {
      noTotalTimes.push(runSample(chunks, false, total, ITERATIONS_PER_SAMPLE));
      collectBetweenSamples();
      withTotalTimes.push(runSample(chunks, true, total, ITERATIONS_PER_SAMPLE));
    } else {
      withTotalTimes.push(runSample(chunks, true, total, ITERATIONS_PER_SAMPLE));
      collectBetweenSamples();
      noTotalTimes.push(runSample(chunks, false, total, ITERATIONS_PER_SAMPLE));
    }
    collectBetweenSamples();
  }

  const noTotal = median(noTotalTimes);
  const withTotal = median(withTotalTimes);
  const gainPercent = noTotal === 0 ? 0 : ((noTotal - withTotal) / noTotal) * 100;
  console.log([
    shape.name,
    chunks.length,
    total,
    noTotal.toFixed(3),
    withTotal.toFixed(3),
    gainPercent.toFixed(2),
  ].join(','));
}

console.log(`sink=${sink}`);
