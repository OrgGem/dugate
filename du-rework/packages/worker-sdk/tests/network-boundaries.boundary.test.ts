import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString } from '@du/observability';
import {
  ArtifactStreamError,
  createTempWorkspace,
  downloadArtifact,
} from '../src/artifact-streams';
import type { TempWorkspace } from '../src/artifact-streams';
import type { SdkFetcher } from '../src/fan-out';
import {
  BoundaryListener,
  sleep,
  waitFor,
} from '../../../tests/harness/network-boundaries/mock-listener';
import { scanForSentinels } from '../../../tests/harness/network-boundaries/sink-scan';
import { mkSentinel, sentinelShapeViolations } from '../../../tests/harness/network-boundaries/sentinels';
import { installRejectionGuard } from '../../../tests/harness/network-boundaries/unhandled-guard';
import type { RejectionGuard } from '../../../tests/harness/network-boundaries/unhandled-guard';

/**
 * R1-C — "Network & Secret boundaries" offline harness, worker-sdk lane (BR-Q3-01 grant).
 * Plan: coordination/reports/qwen3.md ## W49-Q3-2 (trục B/C; ma trận case sec.6.3).
 * Canonical rows: FIX-CR-08 (whole-request abort), FR24-10 (bounded streamed body through
 * the real SDK download helper), ADM-BASE-03 (no raw upstream error-body echo in messages).
 *
 * Run (from du-rework/):
 *   pnpm --dir packages/worker-sdk exec jest tests/network-boundaries.boundary.test.ts --runInBand
 * [LOCK:*] cases are red ON PURPOSE until the fix lands; this file is not on the default
 * "pnpm test" path (plan sec.6.1.6 "RED phải được đặt tên").
 *
 * Boundary rules honoured here (kit README + plan sec.6.1):
 *  - offline only: 127.0.0.1 listeners on port 0; no PostgreSQL :5433, no Redis :6380, no
 *    real DNS (every URL is a literal loopback origin);
 *  - globalThis.fetch is NEVER monkeypatched — real fetch reaches production only through
 *    the declared seam DownloadArtifactOptions.fetcher (artifact-streams.ts:317);
 *  - listeners are the oracle: requests (deny-before-connect), bytesWritten (cap stops the
 *    wire), closedWithoutFinish (socket torn down = worker slot released);
 *  - sentinels are redactor-invisible by construction and self-checked against the real
 *    redactString (case 5), so a green there can never be a redactor artifact.
 *
 * Import path note: production symbols come from '../src/artifact-streams', not the '../src'
 * barrel the sibling suite uses, because the barrel currently fails ts-jest typecheck on a
 * pre-existing unrelated error — src/task-context.ts:399 TS2353 "'taskId' does not exist in
 * type '{ sha256: string; sizeBytes: number; }'" — which also makes
 * tests/artifact-streams.test.ts fail to run at all. Recording it here is the evidence; the
 * fix is src work (out of this grant).
 */

/** Real fetch, handed to production only through the injectable fetcher seam. */
const realFetch: SdkFetcher = (...args: Parameters<SdkFetcher>) => globalThis.fetch(...args);

let testRoot: string;
let guard: RejectionGuard;
const listeners: BoundaryListener[] = [];
const workspaces: TempWorkspace[] = [];
// Avoid port 0 here: Windows can let an ephemeral loopback port bind successfully but then
// intermittently filter the outbound client connection. This matches the stable band used by
// the sibling Worker SDK live-listener suites.
const QUIET_PORT_BASE = 46_400 + (process.pid % 8) * 16;
let portOffset = 0;

/** B-race accounting: every deliberately racing promise and whether it was claimed. */
interface RacingHandle {
  readonly label: string;
  settled: 'pending' | 'resolved' | 'rejected';
}
const racingHandles: RacingHandle[] = [];

/**
 * Attach BOTH settlement handlers up front so a racing download can never surface as an
 * unhandledRejection, and record the outcome for later assertions.
 */
function raceTrack<T>(label: string, p: Promise<T>): { handle: RacingHandle; settled: Promise<void> } {
  const handle: RacingHandle = { label, settled: 'pending' };
  racingHandles.push(handle);
  const settled = p.then(
    () => {
      handle.settled = 'resolved';
    },
    () => {
      handle.settled = 'rejected';
    }
  );
  return { handle, settled };
}

async function startListener(): Promise<BoundaryListener> {
  const listener = await BoundaryListener.start(QUIET_PORT_BASE + portOffset++);
  listeners.push(listener);
  return listener;
}

/** Temp workspaces live under os.tmpdir() in a unique 'du-r1c-' root; never inside the repo. */
async function makeWorkspace(): Promise<TempWorkspace> {
  const ws = await createTempWorkspace(randomUUID(), { rootDir: testRoot });
  workspaces.push(ws);
  return ws;
}

beforeAll(async () => {
  guard = installRejectionGuard();
  testRoot = await mkdtemp(join(tmpdir(), 'du-r1c-'));
});

afterAll(async () => {
  // Destroy every listener socket so no client promise can keep jest alive: this suite must
  // exit cleanly without --forceExit.
  const stillOpen: string[] = [];
  for (const listener of listeners) {
    await listener.stop().catch(() => undefined);
    if (listener.openSockets !== 0) stillOpen.push(listener.port + ': ' + listener.openSockets + ' open');
  }
  guard.assertClean('R1-C worker-sdk network-boundaries suite');
  guard.restore();
  for (const ws of workspaces) await ws.dispose().catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
  expect(stillOpen).toEqual([]);
});

/* -------------------------------------------------------------------- */
/* B3-lock-a — mid-stream byte cap really stops the wire                 */
/* -------------------------------------------------------------------- */

it('[LOCK] B3-lock-a mid-stream cap stops the wire (real listener)', async () => {
  // (1) The plan's literal script: chunked body with NO content-length, so the pre-check at
  // artifact-streams.ts:385-395 cannot fire — only the counting Transform (:403-417) can.
  // Measured witness: bytesWritten is the FULL 16384 here even though the client cancels,
  // because 16 KiB is absorbed by the loopback socket buffers before the cancel lands (an
  // unpaced server finishes writing in ~0 ms). That is a confound of the measurement, not a
  // missing cancellation, so no byte claim is made from it; refusal + bounded file lifetime
  // are asserted instead.
  const unpaced = await startListener();
  unpaced.setDefault({ kind: 'chunkedNoLength', chunkBytes: 1024, totalBytes: 16384, then: 'end' });
  const wsA = await makeWorkspace();
  const targetA = wsA.filePath('cap-unpaced.bin');
  await expect(
    downloadArtifact(wsA, 'cap-unpaced.bin', unpaced.url(), { maxBytes: 2048, fetcher: realFetch })
  ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
  expect(existsSync(targetA)).toBe(false);
  expect(await readdir(wsA.dir)).toEqual([]);
  expect(unpaced.requests).toBe(1);

  // (2) Same cap, paced (25 ms/chunk => 400 ms of wire time) so the listener byte counter
  // becomes a discriminating witness: if the cancel stopped only at the ReadableStream and
  // never reached the socket, the server would still finish all 16384 bytes. Measured ~3 KiB.
  const paced = await startListener();
  paced.setDefault({
    kind: 'chunkedNoLength',
    chunkBytes: 1024,
    totalBytes: 16384,
    chunkDelayMs: 25,
    then: 'end',
  });
  const wsB = await makeWorkspace();
  const targetB = wsB.filePath('cap-paced.bin');
  await expect(
    downloadArtifact(wsB, 'cap-paced.bin', paced.url(), { maxBytes: 2048, fetcher: realFetch })
  ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
  expect(existsSync(targetB)).toBe(false);
  expect(await readdir(wsB.dir)).toEqual([]);
  // Cancellation reaches the wire: the server stopped long before the body's end.
  expect(paced.bytesWritten).toBeLessThan(16384);
  expect(paced.bytesWritten).toBeLessThanOrEqual(8192); // cap + generous event-loop slack
  expect(paced.closedWithoutFinish).toBeGreaterThanOrEqual(1); // socket torn down, not idled
});

/* -------------------------------------------------------------------- */
/* B3-lock-b — redirect refused (SSRF), second origin never contacted    */
/* -------------------------------------------------------------------- */

it('[LOCK] B3-lock-b redirect refused', async () => {
  const origin = await startListener();
  const hop = await startListener();
  origin.enqueue({ kind: 'redirect', status: 302, location: hop.url() });

  const ws = await makeWorkspace();
  const filePath = ws.filePath('redirected.bin');
  let caught: unknown;
  try {
    await downloadArtifact(ws, 'redirected.bin', origin.url(), { maxBytes: 1 << 12, fetcher: realFetch });
  } catch (err) {
    caught = err;
  }
  // redirect: 'error' is the default (artifact-streams.ts:371), so undici refuses the 3xx and
  // the SDK wraps the refusal as TRANSPORT_FAILURE before any byte or file exists.
  expect(caught).toBeInstanceOf(ArtifactStreamError);
  expect((caught as ArtifactStreamError).code).toBe('TRANSPORT_FAILURE');
  expect((caught as ArtifactStreamError).status).toBe(0);
  // Negative oracle: the redirect target was never connected to.
  expect(hop.requests).toBe(0);
  expect(origin.requests).toBe(1);
  expect(existsSync(filePath)).toBe(false);
  expect(await readdir(ws.dir)).toEqual([]);
});

/* -------------------------------------------------------------------- */
/* B3-lock-c — sha mismatch deletes the file                             */
/* -------------------------------------------------------------------- */

it('[LOCK] B3-lock-c sha mismatch deletes file', async () => {
  const body = JSON.stringify({ ok: true, note: 'small artifact' });
  const listener = await startListener();
  listener.setDefault({
    kind: 'respond',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
  });

  const ws = await makeWorkspace();
  const filePath = ws.filePath('hash.bin');
  await expect(
    downloadArtifact(ws, 'hash.bin', listener.url(), {
      maxBytes: 1 << 12,
      // expectedSha256 of DIFFERENT bytes; expectedSizeBytes deliberately correct so the
      // integrity code under test is HASH_MISMATCH (:430-438), not SIZE_MISMATCH.
      expectedSha256: createHash('sha256').update('not the downloaded bytes').digest('hex'),
      expectedSizeBytes: Buffer.byteLength(body),
      fetcher: realFetch,
    })
  ).rejects.toMatchObject({ code: 'HASH_MISMATCH', status: 422 });
  expect(existsSync(filePath)).toBe(false);
  expect(await readdir(ws.dir)).toEqual([]);
});

/* -------------------------------------------------------------------- */
/* FIX-CR-08 — caller signal must abort the body, not just the headers   */
/* -------------------------------------------------------------------- */

it('[LOCK:FIX-CR-08 caller-signal-aborts-body]', async () => {
  // The seam EXISTS: DownloadArtifactOptions.signal?: AbortSignal (artifact-streams.ts:311),
  // and fetchWithTimeout (:535-555) chains it into the request. But that finally clause drops
  // the outer 'abort' listener the moment headers resolve, and Readable.fromWeb(res.body)
  // (:419) carries no { signal }, so an abort during the body is a no-op today: the download
  // finishes and leaves the file behind. Red on purpose until the fix lands.
  const listener = await startListener();
  listener.setDefault({
    kind: 'chunkedNoLength',
    chunkBytes: 1024,
    totalBytes: 8192,
    chunkDelayMs: 40,
    then: 'end',
  });
  const ws = await makeWorkspace();
  const filePath = ws.filePath('aborted.bin');
  const controller = new AbortController();

  const { handle, settled } = raceTrack(
    'FIX-CR-08 racing download',
    downloadArtifact(ws, 'aborted.bin', listener.url(), {
      maxBytes: 1 << 20, // no cap interference: only the caller signal can stop this
      fetcher: realFetch,
      signal: controller.signal,
    })
  );

  try {
    // The full SDK suite includes a high-RSS streaming test; allow its cleanup and the local
    // connection scheduler enough time before declaring that the request never reached us.
    await waitFor(() => listener.requests > 0, 2_000);
    await sleep(150); // past headers, ~3 of 8 chunks into the body
    const abortedAt = Date.now();
    controller.abort();
    await Promise.race([settled, sleep(400)]);
    const elapsed = Date.now() - abortedAt;

    expect(handle.settled).toBe('rejected'); // today: 'resolved' — the body was drained anyway
    expect(elapsed).toBeLessThanOrEqual(400);
    expect(existsSync(filePath)).toBe(false); // no partial file after a cancelled lease
    expect(listener.closedWithoutFinish).toBeGreaterThanOrEqual(1); // slot released on the wire
  } finally {
    // Abort and close the server before awaiting the racing client promise. If the download
    // regresses and never settles, waiting first would keep this listener bound until Jest's
    // timeout and can strand the port for every following suite run.
    controller.abort();
    await listener.stop();
    await Promise.race([settled, sleep(1_000)]);
  }
});

/* -------------------------------------------------------------------- */
/* ADM-BASE-03 — upstream error body must not be echoed raw into SDK err */
/* -------------------------------------------------------------------- */

it('[LOCK:ADM-BASE-03 download-error-body-no-raw-echo]', async () => {
  const sentinel = mkSentinel('dlerr');
  // Self-check: this sentinel is invisible to the pattern redactor, so a green below can
  // only mean "the body never reached the message", never "redaction hid the leak".
  expect(sentinelShapeViolations(sentinel, redactString)).toEqual([]);

  const listener = await startListener();
  listener.setDefault({
    kind: 'respond',
    status: 422,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code: 'GRANT_INVALID', message: 'credential rejected ' + sentinel } }),
  });

  const ws = await makeWorkspace();
  let caught: unknown;
  try {
    await downloadArtifact(ws, 'rejected.bin', listener.url(), { maxBytes: 1 << 12, fetcher: realFetch });
  } catch (err) {
    caught = err;
  }
  const err = caught as ArtifactStreamError;
  expect(err).toBeInstanceOf(ArtifactStreamError);
  expect(err.code).toBe('DOWNLOAD_REJECTED');
  expect(err.status).toBe(422);
  expect(existsSync(ws.filePath('rejected.bin'))).toBe(false);
  // readErrorDetail (:557-572) falls back to text.slice(0, 512) of the RAW upstream body
  // whenever the JSON carries no top-level detail/title — an orchestrator/grant body is
  // echoed verbatim into err.message, which the worker forwards into failTask. Red until the
  // detail is sanitised to a stable code + correlationId.
  expect(scanForSentinels([err.message, err.stack ?? ''], [sentinel])).toEqual([]);
});

/* -------------------------------------------------------------------- */
/* B-race — harness hygiene: no unhandled rejections, no leaked sockets  */
/* -------------------------------------------------------------------- */

it('[LOCK] B-race harness hygiene', async () => {
  // 1. The rejection guard is installed and nothing has leaked so far in this file — which
  //    covers the deliberately racing download of the FIX-CR-08 case above.
  expect(guard.reasons).toEqual([]);
  // 2. Every racing promise carried its own settlement handlers (both branches attached),
  //    so the intended [OPEN] red can never masquerade as an unhandled rejection.
  expect(racingHandles.length).toBeGreaterThanOrEqual(1);
  expect(racingHandles.filter((h) => h.settled === 'pending').map((h) => h.label)).toEqual([]);
  // 3. Socket witness on a listener that served real traffic: after stop(), zero open.
  const listener = await startListener();
  listener.setDefault({ kind: 'respond', status: 200, body: 'hygiene' });
  const ws = await makeWorkspace();
  const out = await downloadArtifact(ws, 'hygiene.bin', listener.url(), {
    maxBytes: 1 << 12,
    fetcher: realFetch,
  });
  expect(out.sizeBytes).toBe(Buffer.byteLength('hygiene'));
  expect(listener.requests).toBe(1);
  await listener.stop();
  expect(listener.openSockets).toBe(0);
  // afterAll repeats the openSockets sweep for every listener and assertClean()s again.
});
