// tests/pipelines/profile-endpoint-limits.test.ts
// P3 independent verification — ProfileEndpoint per-endpoint limits.
//
// Part A pins the configuration invariants in lib/config.ts:
//   * default per-(apiKey, endpoint) concurrent cap 2 < worker concurrency 5
//     so one profile can never starve the whole pipeline pool;
//   * admin sanity bounds 10000 req/min and 20 concurrent slots;
//   * the global defaults that NULL/0 normalize to (100 req/min, cap 2).
//
// Part B drives the REAL lib/endpoints/runner.ts insert point with only the
// Redis limiter mocked, asserting the normalization semantics end to end:
//   * NULL / 0 / negative rateLimitPerMin -> global default 100/min;
//   * positive value -> passed through unchanged;
//   * browser session (no apiKeyId) -> IP-keyed 30/min, profile value ignored;
//   * denial -> 429 + Retry-After + X-RateLimit-Remaining, and it happens
//     BEFORE the submission path (no Operation, no enqueue);
//   * an allowed check proceeds (fail-open path never blocks).
//
// No real Redis/DB/AI/network is used in this suite.

const mockLoadProfileEndpoint = jest.fn();
const mockMergeParameters = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockSubmitPipelineJob = jest.fn();

jest.mock('../../lib/endpoints/profile-resolver', () => ({
  loadProfileEndpoint: (...args: unknown[]) => mockLoadProfileEndpoint(...args),
  mergeParameters: (...args: unknown[]) => mockMergeParameters(...args),
  parseConnectionSteps: jest.fn(() => []),
  getFileUrlAuthConfig: jest.fn(() => undefined),
}));

jest.mock('../../lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock('../../lib/pipelines/submit', () => ({
  submitPipelineJob: (...args: unknown[]) => mockSubmitPipelineJob(...args),
}));

jest.mock('../../lib/pipelines/format', () => ({
  formatOperationResponse: jest.fn(),
}));

jest.mock('../../lib/rbac', () => ({
  canMutate: jest.fn(() => true),
  isAdmin: jest.fn(() => false),
  requireAdmin: jest.fn(),
}));

jest.mock('../../lib/file-url-downloader', () => ({
  MAX_FILE_URL_ENTRIES: 10,
}));

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { runEndpoint } from '../../lib/endpoints/runner';
import {
  DEFAULT_ENDPOINT_RATE_LIMIT_PER_MIN,
  MAX_CONCURRENT_PER_PROFILE_ENDPOINT,
  MAX_ENDPOINT_CONCURRENT,
  MAX_ENDPOINT_RATE_LIMIT_PER_MIN,
  RATE_LIMIT_API_KEY_PER_MIN,
  RATE_LIMIT_IP_PER_MIN,
  SUBSTEP_WORKER_CONCURRENCY,
  WORKER_CONCURRENCY,
} from '../../lib/config';

// ─── Part A — configuration invariants ────────────────────────────────────────

describe('ProfileEndpoint limit configuration (lib/config.ts)', () => {
  it('keeps the default per-endpoint cap strictly below the worker concurrency', () => {
    // The anti-starvation invariant from the plan: a single (apiKey, endpoint)
    // can never occupy every pipeline slot, so another key always progresses.
    expect(MAX_CONCURRENT_PER_PROFILE_ENDPOINT).toBe(2);
    expect(WORKER_CONCURRENCY).toBe(5);
    expect(MAX_CONCURRENT_PER_PROFILE_ENDPOINT).toBeGreaterThanOrEqual(1);
    expect(MAX_CONCURRENT_PER_PROFILE_ENDPOINT).toBeLessThan(WORKER_CONCURRENCY);
  });

  it('keeps the substep pool at least as large as the pipeline pool (substeps skip the semaphore)', () => {
    // Workflow sub-steps deliberately bypass the slot semaphore (parent holds a
    // slot while waiting for children — capping them would deadlock), so their
    // pool must not be smaller than the top-level pool.
    expect(SUBSTEP_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(WORKER_CONCURRENCY);
  });

  it('pins the admin upper bounds (10000 req/min, 20 concurrent slots)', () => {
    expect(MAX_ENDPOINT_RATE_LIMIT_PER_MIN).toBe(10000);
    expect(MAX_ENDPOINT_CONCURRENT).toBe(20);
    expect(Number.isInteger(MAX_ENDPOINT_RATE_LIMIT_PER_MIN)).toBe(true);
    expect(Number.isInteger(MAX_ENDPOINT_CONCURRENT)).toBe(true);
  });

  it('keeps the upper bounds above the defaults they are meant to guard', () => {
    expect(MAX_ENDPOINT_RATE_LIMIT_PER_MIN).toBeGreaterThan(DEFAULT_ENDPOINT_RATE_LIMIT_PER_MIN);
    expect(MAX_ENDPOINT_CONCURRENT).toBeGreaterThan(MAX_CONCURRENT_PER_PROFILE_ENDPOINT);
  });

  it('exposes the global defaults that NULL/0 normalize to', () => {
    expect(RATE_LIMIT_API_KEY_PER_MIN).toBe(100);
    expect(RATE_LIMIT_IP_PER_MIN).toBe(30);
    expect(DEFAULT_ENDPOINT_RATE_LIMIT_PER_MIN).toBe(RATE_LIMIT_API_KEY_PER_MIN);
    expect(MAX_CONCURRENT_PER_PROFILE_ENDPOINT).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_CONCURRENT_PER_PROFILE_ENDPOINT)).toBe(true);
  });
});

// ─── Part B — normalization through the real runner insert point ──────────────

const ALLOWED = { allowed: true, remaining: 1, retryAfter: 0 };
const DENIED = { allowed: false, remaining: 0, retryAfter: 12 };

interface RequestOptions {
  apiKeyId?: string | null;
  headers?: Record<string, string>;
  fields?: Record<string, string>;
}

/**
 * Minimal request fixture: the runner only uses `url`, `method`,
 * `headers.get()` and `formData()`. A real FormData is used so `get`,
 * `getAll` and `keys()` behave exactly like production. `type=invoice`
 * resolves the extract sub-case so the endpoint slug is `extract:invoice`.
 */
function makeRequest(options: RequestOptions = {}): NextRequest {
  const headers = new Headers(options.headers ?? {});
  if (options.apiKeyId !== null) headers.set('x-api-key-id', options.apiKeyId ?? 'key-123');
  const fields = options.fields ?? { type: 'invoice' };
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return {
    url: 'http://localhost:3000/api/v1/extract',
    method: 'POST',
    headers,
    formData: async () => form,
  } as unknown as NextRequest;
}

function profileEndpointWith(rateLimitPerMin: number | null) {
  return {
    enabled: true,
    rateLimitPerMin,
    parameters: null,
    connectionsOverride: null,
  };
}

describe('ProfileEndpoint rate-limit normalization (runner insert point)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadProfileEndpoint.mockReset();
    mockMergeParameters.mockReset();
    mockCheckRateLimit.mockReset();
    mockSubmitPipelineJob.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes NULL rateLimitPerMin to the global 100/min default (429 happens before submit)', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(null));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    const response = await runEndpoint('extract', makeRequest());

    expect(mockLoadProfileEndpoint).toHaveBeenCalledWith('key-123', 'extract:invoice', 'extract');
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:profile:key-123:extract:invoice', 100, 60);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await response.json();
    expect(body).toMatchObject({ title: 'Too Many Requests', status: 429 });
    expect(body.detail).toContain('100');

    // The limiter is the last thing to run: no Operation is created or enqueued.
    expect(mockSubmitPipelineJob).not.toHaveBeenCalled();
  });

  it('treats 0 as "use the default" — never as a hard block (limit 0 would deny everything)', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(0));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    await runEndpoint('extract', makeRequest());

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:profile:key-123:extract:invoice', 100, 60);
  });

  it('treats a negative stored value defensively as the default (admin validation rejects negatives)', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(-7));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    await runEndpoint('extract', makeRequest());

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:profile:key-123:extract:invoice', 100, 60);
  });

  it('passes an explicit positive limit through unchanged', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(250));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    await runEndpoint('extract', makeRequest());

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:profile:key-123:extract:invoice', 250, 60);
  });

  it('keys browser sessions (no apiKeyId) by endpoint+client IP with the 30/min IP default, ignoring the profile value', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(250));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    await runEndpoint('extract', makeRequest({
      apiKeyId: null,
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:endpoint:extract:invoice:203.0.113.9', 30, 60);
  });

  it('falls back to x-user-id when no forwarded address is present', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(null));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    await runEndpoint('extract', makeRequest({
      apiKeyId: null,
      headers: { 'x-user-id': 'user-77' },
    }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:endpoint:extract:invoice:user-77', 30, 60);
  });

  it('falls back to "anonymous" when neither IP nor user id is present', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(null));
    mockCheckRateLimit.mockResolvedValue(DENIED);

    await runEndpoint('extract', makeRequest({ apiKeyId: null }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ratelimit:endpoint:extract:invoice:anonymous', 30, 60);
  });

  it('an allowed check proceeds past the limiter (fail-open never blocks the request here)', async () => {
    mockLoadProfileEndpoint.mockResolvedValue(profileEndpointWith(null));
    mockCheckRateLimit.mockResolvedValue(ALLOWED);
    // Sentinel stops the request right after the limiter so the rest of the
    // pipeline does not need to be modeled.
    mockMergeParameters.mockReturnValueOnce({
      ok: false,
      errorResponse: NextResponse.json({ stoppedAt: 'after-rate-limit' }, { status: 599 }),
    });

    const response = await runEndpoint('extract', makeRequest());

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockMergeParameters).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(599);
    expect(mockSubmitPipelineJob).not.toHaveBeenCalled();
  });
});
