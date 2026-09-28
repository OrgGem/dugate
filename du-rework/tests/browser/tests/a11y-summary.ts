/**
 * Aggregator for the W47-O browser harness.
 *
 * Tests call `recordScreenshot` / `recordAxeResult` to append entries;
 * the sections spec calls `writeSummary` once on `afterAll` to flush
 * the in-memory list to `tests/browser/artifacts/artifacts-summary.json`.
 *
 * The summary is the single evidence file the orchestrator-side report
 * links to. Each entry is small + JSON-serialisable; no `any`, no
 * function references, no DOM handles.
 *
 * Per-test isolation: Playwright runs each `test()` callback in a fresh
 * VM context (each test sees a fresh `globalThis`, fresh `require`
 * cache). A plain in-process accumulator is therefore per-test, not
 * per-file — verified empirically (each test starts with
 * `RECORDS.length=0` even with `workers: 1, fullyParallel: false`).
 * The aggregator therefore appends each entry to a JSONL file on disk
 * that survives VM resets, and `writeSummary` reads that JSONL back
 * to produce the final `artifacts-summary.json`.
 */

import { writeFile, mkdir, appendFile, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ScreenshotRecord {
  kind: 'screenshot';
  section: string;
  viewport: 'desktop' | 'mobile';
  path: string;
  bytes: number;
  url: string;
}

export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  description: string;
  nodes: number;
}

export interface AxeRecord {
  kind: 'axe';
  section: string;
  viewport: 'desktop' | 'mobile';
  url: string;
  violations: AxeViolation[];
}

export type ArtifactRecord = ScreenshotRecord | AxeRecord;

const JSONL_PATH = 'artifacts/_records.jsonl';
const SUMMARY_PATH = 'artifacts/artifacts-summary.json';

export async function recordScreenshot(rec: Omit<ScreenshotRecord, 'kind'>): Promise<void> {
  const entry: ScreenshotRecord = { kind: 'screenshot', ...rec };
  await appendFile(JSONL_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

export async function recordAxeResult(rec: Omit<AxeRecord, 'kind'>): Promise<void> {
  const entry: AxeRecord = { kind: 'axe', ...rec };
  await appendFile(JSONL_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

export async function listArtifacts(): Promise<ArtifactRecord[]> {
  try {
    const text = await readFile(JSONL_PATH, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.map((l) => JSON.parse(l) as ArtifactRecord);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
}

/**
 * Reset the on-disk JSONL accumulator. Tests do NOT call this — it is
 * only useful for the harness itself when running interactively.
 */
export async function __resetRecordsForTest(): Promise<void> {
  try {
    await unlink(JSONL_PATH);
  } catch {
    // best-effort
  }
}

export async function writeSummary(): Promise<string | null> {
  const records = await listArtifacts();
  // Hard gate: do NOT write the evidence file when there is nothing to
  // record. The orchestrator / lane-cross-check uses this file as ground
  // truth for "the harness actually ran"; an empty file with a fake
  // timestamp is a corrupted-vat-of-truth. (W47-O7 item (2).)
  if (records.length === 0) {
    return null;
  }
  // eslint-disable-next-line no-console
  console.log(`[W47-O writeSummary] ${records.length} records read from ${JSONL_PATH}`);
  await mkdir(dirname(SUMMARY_PATH), { recursive: true });
  const screenshots = records.filter((r): r is ScreenshotRecord => r.kind === 'screenshot');
  const axe = records.filter((r): r is AxeRecord => r.kind === 'axe');
  const counts = {
    screenshots: screenshots.length,
    axeScans: axe.length,
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };
  for (const a of axe) {
    for (const v of a.violations) {
      if (v.impact === 'critical') counts.critical += 1;
      else if (v.impact === 'serious') counts.serious += 1;
      else if (v.impact === 'moderate') counts.moderate += 1;
      else if (v.impact === 'minor') counts.minor += 1;
    }
  }
  // Real wall-clock timestamp (Asia/Ho_Chi_Minh = +07). The previous
  // version hard-coded 2026-09-24T01:15:00Z, which produced a "vat trong"
  // file whose timestamp drifted from the actual run moment.
  const offsetMinutes = 7 * 60; // +07:00
  const localNow = new Date(Date.now() + offsetMinutes * 60_000);
  const generatedAt =
    `${localNow.getUTCFullYear()}-` +
    `${String(localNow.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(localNow.getUTCDate()).padStart(2, '0')}T` +
    `${String(localNow.getUTCHours()).padStart(2, '0')}:` +
    `${String(localNow.getUTCMinutes()).padStart(2, '0')}:` +
    `${String(localNow.getUTCSeconds()).padStart(2, '0')}.` +
    `${String(localNow.getUTCMilliseconds()).padStart(3, '0')}+07:00`;
  const summary = {
    generatedAt,
    status: 'ok',
    summary: {
      sectionsCovered: Array.from(new Set(screenshots.map((s) => s.section))).sort(),
      viewports: Array.from(new Set(screenshots.map((s) => s.viewport))).sort(),
      ...counts,
    },
    records,
  };
  await writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  return SUMMARY_PATH;
}