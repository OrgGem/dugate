#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function usage() {
  return [
    'Usage:',
    '  node prepare-live-fixtures.mjs --run-id <safe-id> --out-dir <new-directory>',
    '',
    'This command writes synthetic fixtures locally and makes no network calls.',
  ].join('\n');
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (key !== '--run-id' && key !== '--out-dir') {
      throw new Error(`Unknown option: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  return {
    help: false,
    runId: values.get('--run-id'),
    outDir: values.get('--out-dir'),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapePdfLiteral(value) {
  return value.replace(/[()\\]/g, '\\$&');
}

function makePdf(text) {
  const content = Buffer.from(`BT /F1 11 Tf 54 738 Td (${escapePdfLiteral(text)}) Tj ET`, 'ascii');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('ascii')}\nendstream`,
  ];

  const chunks = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [0];
  let byteLength = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'ascii');
    chunks.push(chunk);
    byteLength += chunk.length;
  }

  const xrefOffset = byteLength;
  const xrefRows = offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefRows.join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'ascii',
  ));
  return Buffer.concat(chunks);
}

function writeNewFile(directory, name, data) {
  writeFileSync(path.join(directory, name), data, { flag: 'wx' });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.runId || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(args.runId)) {
    throw new Error('--run-id must be 3-64 lowercase letters, digits, _ or - and start with a letter or digit');
  }
  if (!args.outDir) throw new Error('--out-dir is required');

  const outputDir = path.resolve(args.outDir);
  mkdirSync(path.dirname(outputDir), { recursive: true });
  mkdirSync(outputDir, { recursive: false });

  const sentinel = `DU_LIVE_PREP_${args.runId}_${randomBytes(16).toString('hex')}`;
  const tenantId = randomUUID();
  const fixtureText = `DUGate fixture marker=provider-roundtrip; sentinel=${sentinel}.`;
  const expectedText = `${fixtureText}\n`;
  const pdf = makePdf(fixtureText);
  const expected = Buffer.from(expectedText, 'utf8');
  const manifest = {
    schemaVersion: 1,
    fixtureVersion: 'plan04-live-prep-v1',
    generatedAt: new Date().toISOString(),
    runId: args.runId,
    tenantId,
    networkAccess: 'none',
    input: {
      file: 'input.pdf',
      contentType: 'application/pdf',
      bytes: pdf.length,
      sha256: sha256(pdf),
    },
    expectedDownload: {
      file: 'expected-output.txt',
      contentType: 'text/plain; charset=utf-8',
      bytes: expected.length,
      sha256: sha256(expected),
    },
    sentinel: {
      encoding: 'utf8',
      sha256: sha256(sentinel),
      rawValueIncluded: false,
    },
  };
  const receiptStub = [
    `# PLAN04 live run ${args.runId}`,
    '',
    '- Status: PREPARED; live evidence is pending.',
    `- Fixture version: ${manifest.fixtureVersion}`,
    `- Tenant fixture ID: ${tenantId}`,
    `- Input SHA-256: ${manifest.input.sha256}`,
    `- Expected output SHA-256: ${manifest.expectedDownload.sha256}`,
    `- Sentinel SHA-256 only: ${manifest.sentinel.sha256}`,
    '- Build/working-tree digest: pending at live window.',
    '- Infrastructure namespaces and identity map: pending coordinator approval.',
    '- Passed / failed / skipped: 0 / 0 / pending.',
    '- Raw live output path: pending; never store credentials or raw sentinel.',
    '',
  ].join('\n');

  writeNewFile(outputDir, 'input.pdf', pdf);
  writeNewFile(outputDir, 'expected-output.txt', expected);
  writeNewFile(outputDir, 'fixture-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  writeNewFile(outputDir, 'receipt-stub.md', receiptStub);

  process.stdout.write(`Prepared offline fixture set: ${outputDir}\n`);
  process.stdout.write(`runId=${args.runId} tenantId=${tenantId}\n`);
  process.stdout.write(`inputSha256=${manifest.input.sha256} expectedOutputSha256=${manifest.expectedDownload.sha256}\n`);
  process.stdout.write(`sentinelSha256=${manifest.sentinel.sha256} (raw sentinel withheld)\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`${message}\n${usage()}\n`);
  process.exitCode = 1;
}
