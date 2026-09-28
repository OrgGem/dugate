import { parseWorkerConfig } from '../src/config';
import { mainReviewHandler } from '../src/review';
import { startExampleReviewWorker } from '../src/worker';
import { createMockTaskContext } from './test-helper';

describe('Deterministic Aggregate Output & Worker Configuration (P7-01 / P7-02 / A07-04)', () => {
  it('produces byte-identical output artifacts for identical review evaluations', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));
    try {
      const input = {
        reviewId: 'rev-det-42',
        artifacts: [{ artifactId: 'art-1', fileName: 'sample.pdf' }],
        checks: {
          zeta: false,
          alpha: false,
          middle: true,
        },
      };

      const firstRun = createMockTaskContext({ kind: 'review', input });
      const secondRun = createMockTaskContext({ kind: 'review', input });

      const firstDisposition = await mainReviewHandler(firstRun.ctx);
      const secondDisposition = await mainReviewHandler(secondRun.ctx);

      expect(firstDisposition.kind).toBe('completed');
      expect(secondDisposition.kind).toBe('completed');

      const firstOutputArt = firstRun.writtenArtifacts.find((a) => a.fileName === 'rev-det-42.review.json');
      const secondOutputArt = secondRun.writtenArtifacts.find((a) => a.fileName === 'rev-det-42.review.json');
      expect(firstOutputArt).toBeDefined();
      expect(secondOutputArt).toBeDefined();

      const firstParsed = JSON.parse(firstOutputArt!.content.toString('utf8'));
      const secondParsed = JSON.parse(secondOutputArt!.content.toString('utf8'));

      expect(firstParsed.approved).toBe(false);
      expect(firstParsed.failedChecks).toEqual(['alpha', 'zeta']); // sorted
      expect(firstParsed.itemCount).toBe(1);
      expect(firstParsed.reviewId).toBe('rev-det-42');
      expect(firstParsed.summary).toBe(secondParsed.summary);
      expect(firstParsed.items).toEqual(secondParsed.items);
    } finally {
      jest.useRealTimers();
    }
  });

  it('parses valid worker configuration from environment variables', () => {
    const env = {
      RUNTIME_URL: 'http://orchestrator:3000/api/runtime/v1',
      RUNTIME_TOKEN: 'token-abc',
      REDIS_URL: 'redis://redis:6379',
      CONCURRENCY: '4',
      HEARTBEAT_INTERVAL_MS: '5000',
      WORKER_INSTANCE_ID: 'inst-test-1',
      IMAGE_DIGEST: 'sha256:digest-test',
      SHUTDOWN_GRACE_MS: '10000',
    };

    const config = parseWorkerConfig(env);
    expect(config.runtimeUrl).toBe('http://orchestrator:3000/api/runtime/v1');
    expect(config.runtimeToken).toBe('token-abc');
    expect(config.redisUrl).toBe('redis://redis:6379');
    expect(config.concurrency).toBe(4);
    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.workerInstanceId).toBe('inst-test-1');
    expect(config.imageDigest).toBe('sha256:digest-test');
    expect(config.shutdownGraceMs).toBe(10000);
  });

  it('rejects missing required environment variables in parseWorkerConfig', () => {
    expect(() => parseWorkerConfig({})).toThrow(/RUNTIME_URL is required/);
    expect(() => parseWorkerConfig({ RUNTIME_URL: 'http://localhost' })).toThrow(/RUNTIME_TOKEN is required/);
    expect(() =>
      parseWorkerConfig({ RUNTIME_URL: 'http://localhost', RUNTIME_TOKEN: 't' })
    ).toThrow(/REDIS_URL is required/);
    expect(() =>
      parseWorkerConfig({ RUNTIME_URL: 'not-a-url', RUNTIME_TOKEN: 't', REDIS_URL: 'r' })
    ).toThrow(/RUNTIME_URL must be a valid URL/);
  });

  it('instantiates worker lifecycle handle with startExampleReviewWorker and mock consumer', async () => {
    let stopped = false;
    const mockConsumer = {
      start: async () => {},
      stop: async () => {
        stopped = true;
      },
    };

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          health: 'HEALTHY',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          capacity: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    const handle = await startExampleReviewWorker({
      runtimeUrl: 'http://mock-runtime:3000/api/runtime/v1',
      runtimeToken: 'mock-token',
      consumer: mockConsumer,
      fetchImpl: mockFetch as unknown as typeof fetch,
      heartbeatIntervalMs: 60_000,
      imageDigest: 'sha256:mock-image',
    });

    expect(handle).toBeDefined();
    expect(handle.queueName).toBe('du-business-example-review-1.0.0');
    expect(handle.stopped).toBe(false);

    await handle.stop(500);
    expect(stopped).toBe(true);
    expect(handle.stopped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REVIEWER FINDING 1 (cycle 138+): developer-mode startup logging must never
// print tokens/credentials. Two live code paths today (config parse errors,
// main()'s crash banner) + a static pin on src/main.ts + a counterexample so
// the guards are demonstrably non-vacuous. The future 'config loaded' banner
// for DU_DEVELOP=true must pass the SAME checks before it is allowed in.
// ---------------------------------------------------------------------------

import { captureConsole } from './fixtures/console-capture';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKER_TOKEN_SENTINEL = 'wtok-SENTINEL-0f1e2d3c4b5a';
const API_KEY_SENTINEL = 'sk-live-SENTINEL-9a8b7c6d5e4f';
// Field names/values a startup log must never serialize (Finding 1 rule).
const FORBIDDEN_LOG_SHAPE = /runtimeToken|workerToken|apiKey|access[_-]?token|api[_-]?key|password|secret|\"\"token\"\"|JSON\.stringify\(config/i;

describe('FINDING 1 — console-capture is non-vacuous', () => {
  it('sees EVERY console level including object payloads; restores afterwards', () => {
    const cap = captureConsole();
    try {
      console.log('plain', { nested: { token: WORKER_TOKEN_SENTINEL } });
      console.info('info-line');
      console.warn('warn-line');
      console.error('err-line', new Error('boom-' + API_KEY_SENTINEL));
      console.debug('debug-line');
    } finally {
      cap.restore();
    }
    const all = cap.joined();
    expect(cap.calls.map((c) => c.level).sort()).toEqual(['debug', 'error', 'info', 'log', 'warn']);
    expect(all).toContain(WORKER_TOKEN_SENTINEL); // nested JSON visible
    expect(all).toContain(API_KEY_SENTINEL); // Error payloads stringified
    // after restore, console writes go OUT of the capture
    const countBefore = cap.calls.length;
    console.log('after-restore');
    expect(cap.calls.length).toBe(countBefore);
  });

  it('counterexample: the forbidden log line FAILS the rule, the safe banner passes', () => {
    const capBad = captureConsole();
    try {
      // The exact snippet the reviewer flagged: config fields serialized.
      console.log('config loaded', { workerToken: WORKER_TOKEN_SENTINEL, develop: true });
    } finally {
      capBad.restore();
    }
    expect(FORBIDDEN_LOG_SHAPE.test(capBad.joined())).toBe(true);

    const capGood = captureConsole();
    try {
      // A compliant banner: names only, booleans, non-secret endpoints.
      console.log('config loaded', { queueName: 'du-business-example-review-1.0.0', develop: true });
    } finally {
      capGood.restore();
    }
    expect(FORBIDDEN_LOG_SHAPE.test(capGood.joined())).toBe(false);
  });
});

describe('FINDING 1 — existing output paths are token-free', () => {
  it('parseWorkerConfig errors name the offending KEY, never echo env values', () => {
    const cap = captureConsole();
    let message = '';
    try {
      const env = {
        RUNTIME_URL: `https://internal-host/${API_KEY_SENTINEL}`,
        RUNTIME_TOKEN: WORKER_TOKEN_SENTINEL,
        REDIS_URL: 'redis://h:6379',
      };
      try {
        // force the URL re-throw path with a deliberately unparsable value
        parseWorkerConfig({ ...env, RUNTIME_URL: 'ht tp://' + API_KEY_SENTINEL });
      } catch (e) {
        message = String((e as Error).message);
      }
      // missing-required path too
      try {
        parseWorkerConfig({ RUNTIME_URL: 'https://ok.example' });
      } catch (e) {
        message += ' | ' + String((e as Error).message);
      }
    } finally {
      cap.restore();
    }
    expect(message).toContain('RUNTIME_URL');
    expect(message).not.toContain(API_KEY_SENTINEL);
    expect(message).not.toContain(WORKER_TOKEN_SENTINEL);
    expect(cap.joined()).toBe(''); // parse never logs at all
  });

  it('src/main.ts contains no console line that could serialize config secrets (static pin)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const codeLines = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*'));
    const consoleLines = codeLines.filter((l) => /console\./.test(l));
    expect(consoleLines.length).toBeGreaterThan(0); // pin is watching REAL code, not an empty set
    for (const line of consoleLines) {
      expect(FORBIDDEN_LOG_SHAPE.test(line)).toBe(false);
    }
  });
});
