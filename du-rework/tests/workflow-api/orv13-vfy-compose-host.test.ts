import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createMemorySessionRepository, createSessionStore, SESSION_COOKIE_NAME } from '../../orchestrator/services/orchestrator/src/modules/auth/session-store';
import { buildDockerInvocation } from '../../orchestrator/services/orchestrator/src/modules/compose-operations/host-executor';
import { chromium, type Browser, type Page } from '../browser/node_modules/@playwright/test';
import { syntheticMetadataKeyProvider, createWorkflowApiIsolation } from './isolation';
import { createDisposableComposeFixture, type DisposableComposeFixture, removeSyntheticProjectResources } from './orv13-vfy-compose-host/fixture';

const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const CLI = path.resolve('orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js');
const RAW_DIR = path.resolve('reports/raw/orv13-vfy-compose-host');
const isolation = createWorkflowApiIsolation();
const baseDb = createDb(isolation.baseDatabaseUrl);
const sessions = createSessionStore({ repo: createMemorySessionRepository() });
const adminToken = `orv13-compose-admin-${randomUUID()}`;
const runtimeToken = `orv13-compose-runtime-${randomUUID()}`;
const usageToken = `orv13-compose-usage-${randomUUID()}`;
const runnerToken = randomBytes(32).toString('base64url');
const shellCookieSecret = `orv13-compose-cookie-${randomUUID()}-secret`;
const tenantId = randomUUID();
let fixture: DisposableComposeFixture | undefined;
let app: App | undefined;
let internalUrl = '';
let publicUrl = '';
let shellUrl = '';
let adminSession: Awaited<ReturnType<typeof sessions.create>>;
let localAdminSession: Awaited<ReturnType<typeof sessions.create>>;
let viewerSession: Awaited<ReturnType<typeof sessions.create>>;
let hasOpenArtifacts = false;

interface RunnerProxy {
  readonly url: string;
  readonly requests: Array<{ method: string; path: string; status: number | null; dropped: boolean }>;
  readonly close: () => Promise<void>;
}

interface SafeRunnerResult {
  readonly label: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runnerEnvironment(baseUrl = internalUrl): NodeJS.ProcessEnv {
  if (!fixture) throw new Error('Compose fixture is not initialized');
  return {
    ...process.env,
    COMPOSE_OPERATIONS_RUNNER_BASE_URL: baseUrl,
    COMPOSE_OPERATIONS_HOST_ID: fixture.hostId,
    COMPOSE_OPERATIONS_RUNNER_TOKEN: runnerToken,
    COMPOSE_OPERATIONS_MANIFEST_PATH: fixture.manifestPath,
    COMPOSE_OPERATIONS_MANIFEST_DIGEST: fixture.manifestDigest,
    COMPOSE_OPERATIONS_JOURNAL_PATH: fixture.runnerJournalPath,
    COMPOSE_OPERATIONS_LOCK_PATH: fixture.runnerLockPath,
    COMPOSE_OPERATIONS_RUNNER_POLL_MS: '1000',
  };
}

async function runCli(args: string[] = ['--once'], baseUrl = internalUrl, label = 'runner'): Promise<SafeRunnerResult> {
  const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], {
      cwd: path.resolve('.'),
      env: runnerEnvironment(baseUrl),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`${label}: runner process could not start: ${error.message}`));
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
  const evidence: SafeRunnerResult = { label, ...result };
  if (JSON.stringify(evidence).includes(runnerToken)) throw new Error('runner output unexpectedly contained the host token');
  return evidence;
}

function docker(args: string[], timeout = 30_000): string {
  const result = spawnSync('/usr/local/bin/docker', ['--context', 'default', ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw new Error(`Docker ${args[0] ?? 'command'} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Docker ${args[0] ?? 'command'} returned ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  return result.stdout.trim();
}

function composeConfig(manifest: DisposableComposeFixture['manifest']): Record<string, unknown> {
  const invocation = buildDockerInvocation(manifest, { kind: 'inventory' });
  const args = [...invocation.args.slice(0, -4), 'config', '--format', 'json'];
  const result = spawnSync(invocation.executable, args, {
    cwd: invocation.cwd,
    env: invocation.env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Compose config failed: ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 1200)}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function cookieHeader(session: Awaited<ReturnType<typeof sessions.create>>): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.sessionId)}`;
}

async function bffRequest(session: Awaited<ReturnType<typeof sessions.create>>, route: string, init: RequestInit = {}, csrf = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', cookieHeader(session));
  if (csrf) headers.set('x-csrf-token', session.csrfToken);
  return fetch(`${shellUrl}/admin/api${route}`, { ...init, headers });
}

async function composePreview(input: {
  action: 'apply_release' | 'rollback_release' | 'restart_service';
  releaseId?: string;
  serviceId?: string;
  reason: string;
}, session = adminSession, csrf = true): Promise<{ response: Response; body: Record<string, unknown> }> {
  if (!fixture) throw new Error('Compose fixture is not initialized');
  const response = await bffRequest(session, '/compose/previews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: fixture.hostId, projectId: fixture.projectId, ...input }),
  }, csrf);
  const textBody = await response.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(textBody) as Record<string, unknown>; } catch { body = { safeBody: textBody.slice(0, 500) }; }
  return { response, body };
}

async function submitPreview(preview: Record<string, unknown>, idempotencyKey: string, session = adminSession, expectedRevision?: number): Promise<{ response: Response; body: Record<string, unknown> }> {
  const request = {
    previewId: preview['previewId'],
    expectedTargetRevision: expectedRevision ?? preview['expectedTargetRevision'],
  };
  const response = await bffRequest(session, '/compose/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(request),
  });
  const textBody = await response.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(textBody) as Record<string, unknown>; } catch { body = { safeBody: textBody.slice(0, 500) }; }
  return { response, body };
}

function problemCode(body: Record<string, unknown>): string | undefined {
  return typeof body['code'] === 'string' ? body['code'] : undefined;
}

async function runnerGetJob(jobId: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${internalUrl}/api/internal/compose/runner/jobs/${encodeURIComponent(jobId)}`, {
    headers: { authorization: `Bearer ${runnerToken}`, accept: 'application/json' },
  });
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

interface SyntheticContainer {
  readonly id: string;
  readonly serviceId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly configuredImage: string;
  readonly imageId: string;
}

function inspectProject(projectId: string): SyntheticContainer[] {
  const idsText = docker(['container', 'ls', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${projectId}`]);
  const ids = idsText.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return [];
  const raw = JSON.parse(docker(['container', 'inspect', ...ids])) as Array<Record<string, unknown>>;
  return raw.map((container) => {
    const config = container['Config'] as Record<string, unknown>;
    const labels = config['Labels'] as Record<string, string>;
    const state = container['State'] as Record<string, unknown>;
    return {
      id: String(container['Id']),
      serviceId: String(labels['com.docker.compose.service'] ?? ''),
      status: String(state['Status'] ?? ''),
      startedAt: String(state['StartedAt'] ?? ''),
      configuredImage: String(config['Image'] ?? ''),
      imageId: String(container['Image'] ?? ''),
    };
  }).sort((left, right) => left.serviceId.localeCompare(right.serviceId) || left.id.localeCompare(right.id));
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
}

async function attachSession(page: Page, session: Awaited<ReturnType<typeof sessions.create>>): Promise<void> {
  await page.context().addCookies([{
    name: SESSION_COOKIE_NAME,
    value: session.sessionId,
    url: shellUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

async function servedBundleEvidence(): Promise<Record<string, string>> {
  const dist = path.resolve('orchestrator/apps/admin-web/dist');
  const html = await readFile(path.join(dist, 'index.html'));
  const htmlText = html.toString('utf8');
  const jsRelative = htmlText.match(/src="([^"]+\.js)"/)?.[1];
  const cssRelative = htmlText.match(/href="([^"]+\.css)"/)?.[1];
  if (!jsRelative || !cssRelative) throw new Error('built Admin web index does not reference one JS and one CSS asset');
  const assetPath = (relative: string) => path.resolve(dist, relative.replace(/^\/admin\//, '').replace(/^\//, ''));
  const [jsBytes, cssBytes] = await Promise.all([readFile(assetPath(jsRelative)), readFile(assetPath(cssRelative))]);
  const result = {
    htmlPath: path.join(dist, 'index.html'),
    htmlSha256: createHash('sha256').update(html).digest('hex'),
    jsAsset: jsRelative.replace(/^\//, ''),
    jsSha256: createHash('sha256').update(jsBytes).digest('hex'),
    cssAsset: cssRelative.replace(/^\//, ''),
    cssSha256: createHash('sha256').update(cssBytes).digest('hex'),
  };
  expect(result.htmlSha256).toBe('c8deadba1b4b81476d7e295053ca4c300a31196fc99fa638418b14587a1d9184');
  expect(result.jsSha256).toBe('8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a');
  expect(result.cssSha256).toBe('25ea028bbccf360d53be25daa6a8fc471e85fcda123620d9d9437ada77339d4f');
  return result;
}

async function runActionApiProtocol(_browser: Browser, stateAfterApplyA: SyntheticContainer[]): Promise<Record<string, unknown>> {
  if (!fixture || !app) throw new Error('fixture is not initialized');
  const beforeRestartPreviewResult = await composePreview({ action: 'apply_release', releaseId: 'release-b', reason: 'stale revision after approved restart' });
  expect(beforeRestartPreviewResult.response.status).toBe(201);
  const staleBPreview = beforeRestartPreviewResult.body;

  const restartPreviewResult = await composePreview({ action: 'restart_service', serviceId: 'web', reason: 'approved synthetic web service restart' });
  expect(restartPreviewResult.response.status).toBe(201);
  const restartPreview = restartPreviewResult.body;
  const restartKey = `orv13-restart-idempotency-${randomUUID()}`;
  const restartSubmitted = await submitPreview(restartPreview, restartKey);
  expect(restartSubmitted.response.status).toBe(201);
  const restartReplay = await submitPreview(restartPreview, restartKey);
  expect(restartReplay.response.status).toBe(201);
  const restartJob = restartSubmitted.body['job'] as Record<string, unknown>;
  const replayJob = restartReplay.body['job'] as Record<string, unknown>;
  expect(replayJob['jobId']).toBe(restartJob['jobId']);
  expect(restartReplay.body['replayed']).toBe(true);
  const divergentReplay = await submitPreview(restartPreview, restartKey, adminSession, Number(restartPreview['expectedTargetRevision']) + 1);
  expect(divergentReplay.response.status).toBe(409);
  expect(problemCode(divergentReplay.body)).toBe('IDEMPOTENCY_CONFLICT');

  const busyPreview = await composePreview({ action: 'restart_service', serviceId: 'worker', reason: 'busy target serialization probe' });
  expect(busyPreview.response.status).toBe(409);
  expect(problemCode(busyPreview.body)).toBe('TARGET_BUSY');

  const submitAuditCount = await app.db.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM admin_audit_events WHERE action='compose.job.submit' AND resource=$1",
    [`compose-job:${restartJob['jobId']}`],
  );
  expect(Number(submitAuditCount.rows[0]?.count ?? 0)).toBe(1);

  const restartStartBefore = inspectProject(fixture.projectId);
  const restartRun = await runCli(['--once'], internalUrl, 'approved web service restart');
  expect(restartRun.exitCode).toBe(0);
  const restartDurable = await runnerGetJob(String(restartJob['jobId']));
  expect(restartDurable.response.status).toBe(200);
  expect(restartDurable.body['state']).toBe('SUCCEEDED');
  const restartStartAfter = inspectProject(fixture.projectId);
  expect(restartStartAfter.map((item) => item.id)).toEqual(restartStartBefore.map((item) => item.id));
  expect(restartStartAfter.filter((item) => item.serviceId === 'web').every((item) => item.startedAt !== restartStartBefore.find((before) => before.id === item.id)?.startedAt)).toBe(true);
  expect(restartStartAfter.filter((item) => item.serviceId === 'worker').map((item) => item.startedAt)).toEqual(restartStartBefore.filter((item) => item.serviceId === 'worker').map((item) => item.startedAt));

  const staleBSubmit = await submitPreview(staleBPreview, `orv13-stale-b-${randomUUID()}`);
  expect(staleBSubmit.response.status).toBe(409);
  expect(problemCode(staleBSubmit.body)).toBe('TARGET_REVISION_CONFLICT');

  const releaseBPreviewResult = await composePreview({ action: 'apply_release', releaseId: 'release-b', reason: 'apply approved release B shared web image changed worker image' });
  expect(releaseBPreviewResult.response.status).toBe(201);
  const releaseBSubmit = await submitPreview(releaseBPreviewResult.body, `orv13-apply-b-${randomUUID()}`);
  expect(releaseBSubmit.response.status).toBe(201);
  const releaseBJob = releaseBSubmit.body['job'] as Record<string, unknown>;
  const beforeB = inspectProject(fixture.projectId);
  expect(beforeB.filter((item) => item.serviceId === 'web').map((item) => item.id)).toEqual(stateAfterApplyA.filter((item) => item.serviceId === 'web').map((item) => item.id));
  expect(beforeB.filter((item) => item.serviceId === 'web').map((item) => item.configuredImage)).toEqual(stateAfterApplyA.filter((item) => item.serviceId === 'web').map((item) => item.configuredImage));
  const applyBRun = await runCli(['--once'], internalUrl, 'approved release B apply');
  expect(applyBRun.exitCode).toBe(0);
  const releaseBDurable = await runnerGetJob(String(releaseBJob['jobId']));
  expect(releaseBDurable.body['state']).toBe('SUCCEEDED');
  const afterB = inspectProject(fixture.projectId);
  expect(afterB.filter((item) => item.serviceId === 'web').map((item) => item.id)).toEqual(beforeB.filter((item) => item.serviceId === 'web').map((item) => item.id));
  expect(afterB.filter((item) => item.serviceId === 'worker').every((item) => item.configuredImage === fixture.redisDigest)).toBe(true);
  const catalogAfterBResponse = await bffRequest(adminSession, '/compose/catalog');
  const catalogAfterB = await catalogAfterBResponse.json() as Record<string, unknown>;
  const projectAfterB = (catalogAfterB['projects'] as Array<Record<string, unknown>>).find((item) => item['projectId'] === fixture.projectId)!;
  expect(projectAfterB['desiredReleaseId']).toBe('release-b');
  expect((projectAfterB['observedServices'] as Array<Record<string, unknown>>).every((item) => item['observedReleaseId'] === 'release-b')).toBe(true);

  const rollbackPreviewResult = await composePreview({ action: 'rollback_release', releaseId: 'release-a', reason: 'approved rollback from release B to release A' });
  expect(rollbackPreviewResult.response.status).toBe(201);
  const rollbackSubmit = await submitPreview(rollbackPreviewResult.body, `orv13-rollback-a-${randomUUID()}`);
  expect(rollbackSubmit.response.status).toBe(201);
  const rollbackJob = rollbackSubmit.body['job'] as Record<string, unknown>;
  const rollbackRun = await runCli(['--once'], internalUrl, 'approved rollback to release A');
  expect(rollbackRun.exitCode).toBe(0);
  const rollbackDurable = await runnerGetJob(String(rollbackJob['jobId']));
  expect(rollbackDurable.body['state']).toBe('SUCCEEDED');
  const afterRollback = inspectProject(fixture.projectId);
  expect(afterRollback.filter((item) => item.serviceId === 'web').map((item) => item.id)).toEqual(afterB.filter((item) => item.serviceId === 'web').map((item) => item.id));
  expect(afterRollback.filter((item) => item.serviceId === 'worker').every((item) => item.configuredImage === fixture.postgresDigest)).toBe(true);

  const partialPreviewResult = await composePreview({ action: 'apply_release', releaseId: 'release-partial', reason: 'verify partial host application against missing synthetic worker image' });
  expect(partialPreviewResult.response.status).toBe(201);
  const beforePartialCount = await app.db.query<{ count: string | number }>('SELECT count(*) AS count FROM compose_jobs WHERE host_id=$1 AND project_id=$2', [fixture.hostId, fixture.projectId]);
  await app.db.query(`CREATE FUNCTION orv13_compose_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'compose.job.submit' THEN RAISE EXCEPTION 'isolated audit rollback probe'; END IF;
      RETURN NEW;
    END
  $$`);
  await app.db.query(`CREATE TRIGGER orv13_compose_audit_fail BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION orv13_compose_audit_fail()`);
  const partialKey = `orv13-partial-audit-rollback-${randomUUID()}`;
  const failedAuditSubmit = await submitPreview(partialPreviewResult.body, partialKey);
  await app.db.query('DROP TRIGGER orv13_compose_audit_fail ON admin_audit_events');
  await app.db.query('DROP FUNCTION orv13_compose_audit_fail()');
  expect(failedAuditSubmit.response.status).toBe(502);
  expect(problemCode(failedAuditSubmit.body)).toBe('UPSTREAM_ERROR');
  const afterFailedAuditCount = await app.db.query<{ count: string | number }>('SELECT count(*) AS count FROM compose_jobs WHERE host_id=$1 AND project_id=$2', [fixture.hostId, fixture.projectId]);
  expect(Number(afterFailedAuditCount.rows[0]?.count)).toBe(Number(beforePartialCount.rows[0]?.count));
  const retriedAuditSubmit = await submitPreview(partialPreviewResult.body, partialKey);
  expect(retriedAuditSubmit.response.status).toBe(201);
  expect(retriedAuditSubmit.body['replayed']).toBe(false);
  const partialJob = retriedAuditSubmit.body['job'] as Record<string, unknown>;
  const partialRun = await runCli(['--once'], internalUrl, 'missing pinned worker image failed or partial outcome');
  expect(partialRun.exitCode).toBe(0);
  const partialDurable = await runnerGetJob(String(partialJob['jobId']));
  expect(['PARTIAL', 'FAILED']).toContain(partialDurable.body['state']);
  expect(partialDurable.body['state']).toBe('PARTIAL');
  const afterPartial = inspectProject(fixture.projectId);
  expect(afterPartial.filter((item) => item.serviceId === 'web')).toHaveLength(2);
  expect(afterPartial.filter((item) => item.serviceId === 'web').every((item) => item.status === 'running' && item.configuredImage === fixture.redisDigest)).toBe(true);

  const allJobsQuery = await app.db.query<{ job_id: string }>(
    'SELECT job_id FROM compose_jobs WHERE host_id=$1 AND project_id=$2 ORDER BY created_at ASC,job_id ASC',
    [fixture.hostId, fixture.projectId],
  );
  expect(allJobsQuery.rows).toHaveLength(5);
  const microsecondBase = '2026-10-11T18:00:00';
  for (let index = 0; index < allJobsQuery.rows.length; index += 1) {
    const micros = String(index + 1).padStart(6, '0');
    await app.db.query('UPDATE compose_jobs SET created_at=$2::timestamptz WHERE job_id=$1', [allJobsQuery.rows[index]!.job_id, `${microsecondBase}.${micros}Z`]);
  }
  const pagedIds: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const query = new URLSearchParams({ hostId: fixture.hostId, projectId: fixture.projectId, limit: '1' });
    if (cursor) query.set('cursor', cursor);
    const response = await bffRequest(adminSession, `/compose/jobs?${query.toString()}`);
    expect(response.status).toBe(200);
    const page = await response.json() as { items: Array<Record<string, unknown>>; hasMore: boolean; nextCursor?: string };
    pagedIds.push(...page.items.map((job) => String(job['jobId'])));
    if (!page.hasMore) break;
    cursor = page.nextCursor;
    expect(typeof cursor).toBe('string');
  }
  expect(pagedIds).toEqual([...allJobsQuery.rows].reverse().map((row) => row.job_id));
  expect(new Set(pagedIds).size).toBe(5);

  await writeSafeEvidence('actual-host-actions-and-history.json', {
    sequence: [
      { jobId: String((restartJob as Record<string, unknown>)['jobId']), action: 'restart_service', state: restartDurable.body['state'], replaySameKeyReturnedSameJob: replayJob['jobId'] === restartJob['jobId'], replayAuditRows: Number(submitAuditCount.rows[0]?.count), divergentIdempotencyCode: problemCode(divergentReplay.body), competingTargetCode: problemCode(busyPreview.body), webStartedAtChanged: restartStartAfter.filter((item) => item.serviceId === 'web').every((item) => item.startedAt !== restartStartBefore.find((before) => before.id === item.id)?.startedAt) },
      { jobId: String(releaseBJob['jobId']), action: 'apply_release', releaseId: 'release-b', state: releaseBDurable.body['state'], sharedWebContainerIdsPreserved: true, desiredReleaseId: projectAfterB['desiredReleaseId'], observedReleaseId: 'release-b' },
      { jobId: String(rollbackJob['jobId']), action: 'rollback_release', releaseId: 'release-a', state: rollbackDurable.body['state'] },
      { jobId: String(partialJob['jobId']), action: 'apply_release', releaseId: 'release-partial', state: partialDurable.body['state'], expectedMissingWorkerDigest: fixture.missingDigest },
    ],
    auditFailureRollback: { failingAuditInsertSurfacedAsGateway502: failedAuditSubmit.response.status, problemCode: problemCode(failedAuditSubmit.body), jobCountBefore: Number(beforePartialCount.rows[0]?.count), jobCountAfter: Number(afterFailedAuditCount.rows[0]?.count), samePreviewAndIdempotencyRetryCreatedJob: retriedAuditSubmit.response.status === 201 },
    postgresMicrosecondCursor: { inputMicros: allJobsQuery.rows.length, limit: 1, returnedCount: pagedIds.length, returnedEachOnce: new Set(pagedIds).size === 5, jobIdsDescending: pagedIds },
  });

  return {
    restartJobId: String(restartJob['jobId']),
    releaseBJobId: String(releaseBJob['jobId']),
    rollbackJobId: String(rollbackJob['jobId']),
    partialJobId: String(partialJob['jobId']),
    historyJobIds: pagedIds,
    finalContainers: afterPartial,
  };
}

async function createRunnerProxy(target: string, dropFirstPath?: string): Promise<RunnerProxy> {
  const targetUrl = new URL(target);
  const requests: RunnerProxy['requests'] = [];
  let alreadyDropped = false;
  const server: Server = createServer((incoming, outgoing) => {
    const pathname = incoming.url ?? '/';
    const entry = { method: incoming.method ?? 'GET', path: pathname, status: null as number | null, dropped: false };
    requests.push(entry);
    const upstream = httpRequest({
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port),
      path: pathname,
      method: incoming.method,
      headers: { ...incoming.headers, host: targetUrl.host, connection: 'close' },
    }, (response) => {
      entry.status = response.statusCode ?? null;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300 && dropFirstPath === pathname && !alreadyDropped) {
          entry.dropped = true;
          alreadyDropped = true;
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, {
          ...(response.headers['content-type'] ? { 'content-type': response.headers['content-type'] } : {}),
          'content-length': String(body.length),
          connection: 'close',
        });
        outgoing.end(body);
      });
    });
    upstream.on('error', () => {
      entry.status = 502;
      if (!outgoing.destroyed) { outgoing.writeHead(502); outgoing.end(); }
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function writeSafeEvidence(name: string, value: unknown): Promise<void> {
  if (!hasOpenArtifacts) {
    await mkdir(RAW_DIR, { recursive: true });
    hasOpenArtifacts = true;
  }
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.includes(runnerToken)) throw new Error(`evidence ${name} contains host runner token`);
  await writeFile(path.join(RAW_DIR, name), `${serialized}\n`, { mode: 0o600 });
}

beforeAll(async () => {
  fixture = await createDisposableComposeFixture();
  await mkdir(RAW_DIR, { recursive: true });
  hasOpenArtifacts = true;
  await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
  const previousAdminWeb = process.env.DU_ADMIN_WEB;
  const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
  const previousSeedFallback = process.env.DU_SEED_DEV_FALLBACK;
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = path.resolve('orchestrator/apps/admin-web/dist');
  process.env.DU_SEED_DEV_FALLBACK = 'false';
  (globalThis as typeof globalThis & { __orv13PreviousAdminWeb?: string }).__orv13PreviousAdminWeb = previousAdminWeb;
  (globalThis as typeof globalThis & { __orv13PreviousAdminWebDist?: string }).__orv13PreviousAdminWebDist = previousAdminWebDist;
  (globalThis as typeof globalThis & { __orv13PreviousSeedFallback?: string }).__orv13PreviousSeedFallback = previousSeedFallback;
  adminSession = await sessions.create({ issuer: 'orv13-compose-fixture', sub: 'platform-admin', role: 'admin' });
  localAdminSession = await sessions.create({ issuer: 'orv13-compose-fixture', sub: 'local-admin-with-tenant', role: 'admin', tenantId });
  viewerSession = await sessions.create({ issuer: 'orv13-compose-fixture', sub: 'viewer', role: 'viewer', tenantId });
  const metadataEncryption = { keyProvider: syntheticMetadataKeyProvider(), keyRef: 'orv13-compose-synthetic-key' };
  app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: 0,
    databaseUrl: isolation.databaseUrl, redisUrl: isolation.redisUrl,
    autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, runtimeToken, usageToken,
    adminSessionStore: sessions,
    adminShellCookieSecret: shellCookieSecret,
    adminShellHost: '127.0.0.1', adminShellPort: 0,
    metadataEncryption,
    composeRunner: { hostId: fixture.hostId, runnerToken, manifestDigest: fixture.manifestDigest },
  });
  const publicServer = await app.listen();
  const publicAddress = publicServer.address();
  const internalAddress = app.internalServer.address();
  if (!publicAddress || typeof publicAddress === 'string' || !internalAddress || typeof internalAddress === 'string') {
    throw new Error('Compose verifier Orchestrator did not bind actual public and internal HTTP listeners');
  }
  publicUrl = `http://127.0.0.1:${publicAddress.port}`;
  internalUrl = `http://127.0.0.1:${internalAddress.port}`;
  shellUrl = app.adminShell!.url;
}, 120_000);

afterAll(async () => {
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
  if (fixture) await fixture.cleanup().catch((error: unknown) => {
    process.stderr.write(`ORV13 Compose fixture cleanup issue: ${error instanceof Error ? error.message : 'unknown'}\n`);
  });
  await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`).catch(() => undefined);
  await baseDb.close().catch(() => undefined);
  isolation.context.cleanupArtifactDir();
  const globals = globalThis as typeof globalThis & {
    __orv13PreviousAdminWeb?: string;
    __orv13PreviousAdminWebDist?: string;
    __orv13PreviousSeedFallback?: string;
  };
  if (globals.__orv13PreviousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = globals.__orv13PreviousAdminWeb;
  if (globals.__orv13PreviousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = globals.__orv13PreviousAdminWebDist;
  if (globals.__orv13PreviousSeedFallback === undefined) delete process.env.DU_SEED_DEV_FALLBACK; else process.env.DU_SEED_DEV_FALLBACK = globals.__orv13PreviousSeedFallback;
}, 30_000);

describe('VFY-UI13 independent real Compose host verification', () => {
  test('root-trusted manifest and actual Compose CLI publish a fresh inventory with explicit env-file policy', async () => {
    if (!fixture) throw new Error('fixture not initialized');
    const withoutEnv = composeConfig(fixture.manifestWithoutEnvFile);
    const withPinnedEnv = composeConfig(fixture.manifest);
    const servicesWithoutEnv = withoutEnv['services'] as Record<string, Record<string, unknown>>;
    const servicesWithPinnedEnv = withPinnedEnv['services'] as Record<string, Record<string, unknown>>;
    expect(servicesWithoutEnv['web']?.['image']).toBe(fixture.redisDigest);
    expect((servicesWithoutEnv['web']?.['labels'] as Record<string, unknown>)?.['orv13.sentinel']).toBe('default-sentinel');
    expect(servicesWithPinnedEnv['web']?.['image']).toBe(fixture.redisDigest);
    expect((servicesWithPinnedEnv['web']?.['labels'] as Record<string, unknown>)?.['orv13.sentinel']).toBe('explicit-pinned-env');

    let detachedTransactionQueryError: { name: string; message: string } | null = null;
    await app!.db.tx(async (executor) => {
      const query = executor.query as unknown as (text: string) => Promise<unknown>;
      try {
        await query('SELECT 1');
      } catch (error) {
        detachedTransactionQueryError = {
          name: error instanceof Error ? error.name : 'non-Error throw',
          message: error instanceof Error ? error.message.slice(0, 300) : 'non-Error throw',
        };
      }
    });
    expect(detachedTransactionQueryError?.name).toBe('TypeError');
    await writeSafeEvidence('unbound-pool-query-typeerror-diagnostic.json', {
      operation: 'extract PoolClient.query then invoke without receiver',
      result: detachedTransactionQueryError,
      actualPreviewResponseBeforeOwnerFix: {
        bffStatus: 502,
        bffCode: 'UPSTREAM_ERROR',
        internalStatus: 500,
        internalCode: 'TEMPORARY_UNAVAILABLE',
        internalErrorNameFromSanitizedServerLog: 'TypeError',
      },
      currentPreviewReceiverFix: 'preview path succeeds with frozen source calling extracted query bound to executor',
    });

    const proxy = await createRunnerProxy(internalUrl);
    const result = await runCli(['--once'], proxy.url, 'initial genuine inventory');
    await proxy.close();
    let claimSqlDiagnostic: { pgCode: string | null; safeMessage: string } | null = null;
    if (result.exitCode !== 0 && app) {
      const jobColumns = `job_id, preview_id, host_id, project_id, action, release_id, service_id,
        target_release_digest, target_services, reason, actor_label, state, state_version,
        expected_target_revision, target_revision, created_at, started_at, completed_at,
        claim_expires_at, observed_before_digest, start_expected_observed_digest,
        observed_before, observed_after, observed_after_digest, per_service_outcomes, uncertain_reason`;
      try {
        await app.db.query(
          `SELECT ${jobColumns} FROM compose_jobs j
           JOIN compose_target_state t ON t.active_job_id=j.job_id
           WHERE j.host_id=$1 AND j.state='QUEUED'
           ORDER BY j.created_at ASC,j.job_id ASC FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [fixture.hostId],
        );
        claimSqlDiagnostic = { pgCode: null, safeMessage: 'exact service claim query succeeded outside the HTTP path' };
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown };
        const message = typeof candidate.message === 'string' && /column reference ".+" is ambiguous/i.test(candidate.message)
          ? candidate.message.replace(/column reference "([^"]+)" is ambiguous/i, 'column reference "$1" is ambiguous')
          : 'exact claim SQL failed with a PostgreSQL error';
        claimSqlDiagnostic = { pgCode: typeof candidate.code === 'string' ? candidate.code : null, safeMessage: message };
      }
    }
    await writeSafeEvidence('initial-runner-result.json', { ...result, requests: proxy.requests, claimSqlDiagnostic });
    expect(result.exitCode).toBe(0);
    const catalogResponse = await bffRequest(adminSession, '/compose/catalog');
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as Record<string, unknown>;
    expect(catalog).toMatchObject({ configured: true, hostId: fixture.hostId, manifestDigest: fixture.manifestDigest, availability: 'FRESH' });
    const projects = catalog['projects'] as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ projectId: fixture.projectId, availability: 'FRESH', observedServices: [] });

    const deniedNoCookie = await fetch(`${shellUrl}/admin/api/compose/catalog`);
    expect(deniedNoCookie.status).toBe(401);
    const deniedViewer = await bffRequest(viewerSession, '/compose/catalog');
    expect(deniedViewer.status).toBe(403);
    const tenantAdminCatalog = await bffRequest(localAdminSession, '/compose/catalog');
    expect(tenantAdminCatalog.status).toBe(200);
    const noCsrf = await composePreview({ action: 'apply_release', releaseId: 'release-a', reason: 'missing csrf proof' }, adminSession, false);
    expect(noCsrf.response.status).toBe(403);

    const adminOnlyInternal = await fetch(`${internalUrl}/api/internal/compose/catalog`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect(adminOnlyInternal.status).toBe(200);
    const cookieOnlyInternal = await fetch(`${internalUrl}/api/internal/compose/catalog`, { headers: { cookie: cookieHeader(adminSession) } });
    expect(cookieOnlyInternal.status).toBe(401);
    const invalidSessionProof = await fetch(`${internalUrl}/api/internal/compose/catalog`, {
      headers: { authorization: `Bearer ${adminToken}`, cookie: `${SESSION_COOKIE_NAME}=not-a-live-session` },
    });
    expect(invalidSessionProof.status).toBe(401);
    const runnerOnAdminRoute = await fetch(`${internalUrl}/api/internal/compose/catalog`, { headers: { authorization: `Bearer ${runnerToken}` } });
    expect(runnerOnAdminRoute.status).toBe(401);
    const adminOnRunnerRoute = await fetch(`${internalUrl}/api/internal/compose/runner/claim`, {
      method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(adminOnRunnerRoute.status).toBe(401);
    const publicRunnerRoute = await fetch(`${publicUrl}/api/internal/compose/runner/claim`, {
      method: 'POST', headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(publicRunnerRoute.status).toBe(404);
    const project = projects[0] as Record<string, unknown>;
    const foreignSnapshot = await fetch(`${internalUrl}/api/internal/compose/runner/snapshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: `foreign-${randomUUID()}`,
        manifestDigest: fixture.manifestDigest,
        sampledAt: project['sampledAt'],
        projects: [{
          projectId: project['projectId'], displayName: project['displayName'],
          services: project['services'], releases: project['releases'], observedServices: project['observedServices'],
        }],
      }),
    });
    expect(foreignSnapshot.status).toBe(403);

    const stalePreviewResult = await composePreview({
      action: 'apply_release', releaseId: 'release-b', reason: 'stale compare and swap fixture',
    });
    if (stalePreviewResult.response.status !== 201) {
      const direct = await fetch(`${internalUrl}/api/internal/compose/previews`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          cookie: cookieHeader(adminSession),
          'x-csrf-token': adminSession.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ hostId: fixture.hostId, projectId: fixture.projectId, action: 'apply_release', releaseId: 'release-b', reason: 'stale compare and swap fixture' }),
      });
      const directText = await direct.text();
      let unboundPoolQueryDiagnostic: { name: string; message: string } | null = null;
      try {
        await app.db.tx(async (executor) => {
          const query = executor.query as unknown as (text: string) => Promise<unknown>;
          return query('SELECT 1');
        });
      } catch (error) {
        unboundPoolQueryDiagnostic = {
          name: error instanceof Error ? error.name : 'non-Error throw',
          message: error instanceof Error ? error.message.slice(0, 300) : 'non-Error throw',
        };
      }
      await writeSafeEvidence('preview-probe-failure.json', {
        route: 'POST /admin/api/compose/previews',
        status: stalePreviewResult.response.status,
        body: stalePreviewResult.body,
        directInternalStatus: direct.status,
        directInternalBody: (() => { try { return JSON.parse(directText); } catch { return directText.slice(0, 500); } })(),
        unboundTransactionQueryDiagnostic: unboundPoolQueryDiagnostic,
      });
    }
    expect(stalePreviewResult.response.status).toBe(201);
    const stalePreview = stalePreviewResult.body;

    const bundle = await servedBundleEvidence();
    const browser = await launchBrowser();
    let firstJobId = '';
    let firstJob: Record<string, unknown> | undefined;
    let stateAfterApplyA: SyntheticContainer[] = [];
    try {
      const context = await browser.newContext({ viewport: { width: 412, height: 850 } });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await attachSession(page, adminSession);
      const composeRequests: string[] = [];
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith('/admin/api/compose/')) composeRequests.push(`${request.method()} ${pathname}`);
      });
      await page.goto(`${shellUrl}/admin/system-operations/services`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Compose deployments', exact: true }).waitFor();
      await page.locator('#compose-action').selectOption('apply_release');
      await page.locator('#compose-release').selectOption('release-a');
      await page.locator('#compose-reason').fill('VFY-UI13 browser confirmation for synthetic release A');
      await page.getByRole('button', { name: 'Preview action', exact: true }).click();
      await page.getByRole('heading', { name: 'Review Compose action', exact: true }).waitFor();
      const previewDialog = page.getByRole('dialog');
      await previewDialog.getByText('VFY-UI13 browser confirmation for synthetic release A').waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(RAW_DIR, 'compose-preview-mobile-412.png'), fullPage: true });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 850 });
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await previewDialog.getByText('VFY-UI13 browser confirmation for synthetic release A').waitFor({ state: 'visible' });
        const confirmButton = previewDialog.getByRole('button', { name: 'Confirm and queue job', exact: true });
        await confirmButton.waitFor({ state: 'visible' });
        expect(await confirmButton.isEnabled()).toBe(true);
        const confirmBox = await confirmButton.boundingBox();
        expect(confirmBox).not.toBeNull();
        expect(confirmBox!.x).toBeGreaterThanOrEqual(0);
        expect(confirmBox!.x + confirmBox!.width).toBeLessThanOrEqual(width);
        await confirmButton.scrollIntoViewIfNeeded();
        const scrolledConfirmBox = await confirmButton.boundingBox();
        expect(scrolledConfirmBox).not.toBeNull();
        expect(scrolledConfirmBox!.x).toBeGreaterThanOrEqual(0);
        expect(scrolledConfirmBox!.x + scrolledConfirmBox!.width).toBeLessThanOrEqual(width);
        expect(scrolledConfirmBox!.y).toBeGreaterThanOrEqual(0);
        expect(scrolledConfirmBox!.y + scrolledConfirmBox!.height).toBeLessThanOrEqual(850);
        await previewDialog.screenshot({ path: path.join(RAW_DIR, `compose-preview-confirm-mobile-${width}.png`) });
      }
      const confirmationViewportWidth = await page.evaluate(() => window.innerWidth);
      await page.getByRole('button', { name: 'Confirm and queue job', exact: true }).click();
      await page.getByRole('heading', { name: 'Review Compose action', exact: true }).waitFor({ state: 'detached' });
      const queuedResponse = await bffRequest(adminSession, `/compose/jobs?hostId=${encodeURIComponent(fixture.hostId)}&projectId=${encodeURIComponent(fixture.projectId)}&limit=10`);
      expect(queuedResponse.status).toBe(200);
      const queuedPage = await queuedResponse.json() as { items: Array<Record<string, unknown>> };
      firstJob = queuedPage.items.find((job) => job['action'] === 'apply_release' && job['releaseId'] === 'release-a');
      expect(firstJob?.['state']).toBe('QUEUED');
      firstJobId = String(firstJob?.['jobId']);
      expect(firstJobId).toMatch(/^[0-9a-f-]{36}$/i);

      const completionPath = '/api/internal/compose/runner/complete';
      const lostCompleteProxy = await createRunnerProxy(internalUrl, completionPath);
      const firstRun = await runCli(['--once'], lostCompleteProxy.url, 'apply release A with completion acknowledgement loss');
      await lostCompleteProxy.close();
      expect(firstRun.exitCode).toBe(0);
      expect(lostCompleteProxy.requests.some((request) => request.path === completionPath && request.dropped)).toBe(true);
      const firstDurableJob = await runnerGetJob(firstJobId);
      if (firstDurableJob.body['state'] !== 'SUCCEEDED') {
        const inventoryInvocation = buildDockerInvocation(fixture.manifest, { kind: 'inventory' });
        const inventoryProbe = spawnSync(inventoryInvocation.executable, [...inventoryInvocation.args], {
          cwd: inventoryInvocation.cwd,
          env: { ...inventoryInvocation.env },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const psRows = (() => {
          try {
            const parsed = JSON.parse(inventoryProbe.stdout ?? '') as unknown;
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            try { return String(inventoryProbe.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown); } catch { return []; }
          }
        })();
        const containerIds = psRows.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const id = (value as Record<string, unknown>)['ID'];
          return typeof id === 'string' && /^[a-f0-9]{12,64}$/i.test(id) ? [id] : [];
        });
        const inspectTemplate = '{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}';
        const inspectProbe = containerIds.length > 0 ? spawnSync(inventoryInvocation.executable, [
          '--context', fixture.manifest.dockerContext, 'container', 'inspect', '--format', inspectTemplate, ...containerIds,
        ], {
          cwd: fixture.manifest.workingDirectory,
          env: { ...inventoryInvocation.env },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }) : null;
        const inspectText = String(inspectProbe?.stdout ?? '');
        const inspectLinesBeforeTrim = inspectText.split(/\r?\n/).filter(Boolean);
        const inspectTextAfterTrim = inspectText.trim();
        const inspectLinesAfterTrim = inspectTextAfterTrim.split(/\r?\n/).filter(Boolean);
        const inspectRowsBeforeTrim = inspectLinesBeforeTrim.map((line) => line.split('\t'));
        const inspectRowsAfterTrim = inspectLinesAfterTrim.map((line) => line.split('\t'));
        const selectedInspectTemplate = '{{.Id}}\t{{.Image}}\t{{json .State}}';
        const selectedInspectProbe = containerIds.length > 0 ? spawnSync(inventoryInvocation.executable, [
          '--context', fixture.manifest.dockerContext, 'container', 'inspect', '--format', selectedInspectTemplate, ...containerIds,
        ], {
          cwd: fixture.manifest.workingDirectory,
          env: { ...inventoryInvocation.env },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }) : null;
        const selectedInspectLines = String(selectedInspectProbe?.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
        const selectedInspectRows = selectedInspectLines.map((line) => line.split('\t'));
        const selectedStateRows = selectedInspectRows.map((fields) => {
          let state: Record<string, unknown> = {};
          try { state = JSON.parse(fields[2] ?? '') as Record<string, unknown>; } catch { /* captured below as a null status */ }
          return {
            id: fields[0] ?? '',
            imageId: fields[1] ?? '',
            stateKeys: Object.keys(state).sort(),
            status: typeof state['Status'] === 'string' ? state['Status'] : null,
            startedAtPresent: typeof state['StartedAt'] === 'string',
            finishedAtPresent: typeof state['FinishedAt'] === 'string',
            healthPresent: Object.prototype.hasOwnProperty.call(state, 'Health'),
          };
        });
        const candidateInspectTemplate = '{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{with index .State "Health"}}{{.Status}}{{end}}';
        const candidateInspectProbe = containerIds.length > 0 ? spawnSync(inventoryInvocation.executable, [
          '--context', fixture.manifest.dockerContext, 'container', 'inspect', '--format', candidateInspectTemplate, ...containerIds,
        ], {
          cwd: fixture.manifest.workingDirectory,
          env: { ...inventoryInvocation.env },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }) : null;
        const candidateInspectText = String(candidateInspectProbe?.stdout ?? '');
        const candidateInspectLinesBeforeTrim = candidateInspectText.split(/\r?\n/).filter(Boolean);
        const candidateInspectLinesAfterTrim = candidateInspectText.trim().split(/\r?\n/).filter(Boolean);
        const candidateRowsBeforeTrim = candidateInspectLinesBeforeTrim.map((line) => line.split('\t'));
        const candidateRowsAfterTrim = candidateInspectLinesAfterTrim.map((line) => line.split('\t'));
        const candidateSelectedRows = candidateRowsBeforeTrim.map((fields) => ({
          id: fields[0] ?? '',
          imageId: fields[1] ?? '',
          status: fields[2] ?? '',
          startedAtPresent: Boolean(fields[3]),
          finishedAtPresent: Boolean(fields[4]),
          health: fields[5] ?? null,
        }));
        const journalDiagnostic = (await readFile(fixture.runnerJournalPath, 'utf8')).trim().split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry['jobId'] === firstJobId)
          .map((entry) => {
            const outcome = entry['outcome'] && typeof entry['outcome'] === 'object' ? entry['outcome'] as Record<string, unknown> : {};
            const perService = Array.isArray(outcome['perServiceOutcomes']) ? outcome['perServiceOutcomes'] as Array<Record<string, unknown>> : [];
            return {
              kind: entry['kind'],
              outcome: outcome['outcome'],
              errorCode: outcome['errorCode'],
              perServiceOutcomes: perService.map((item) => ({ serviceId: item['serviceId'], status: item['status'], errorCode: item['errorCode'] })),
              completeStatus: entry['status'],
            };
          });
        await writeSafeEvidence('compose-apply-a-lost-ack-diagnostic.json', {
          jobId: firstJobId,
          cli: firstRun,
          runnerApi: lostCompleteProxy.requests,
          durableJob: {
            status: firstDurableJob.response.status,
            state: firstDurableJob.body['state'],
            stateVersion: firstDurableJob.body['stateVersion'],
            uncertainReason: firstDurableJob.body['uncertainReason'],
            perServiceOutcomes: firstDurableJob.body['perServiceOutcomes'],
          },
          exactComposeInventoryProbe: {
            exitCode: inventoryProbe.status,
            error: inventoryProbe.error?.message ?? null,
            stdout: String(inventoryProbe.stdout ?? '').slice(0, 4000),
            stderr: String(inventoryProbe.stderr ?? '').slice(0, 1000),
            parsedRows: psRows,
          },
          exactContainerInspectProbe: {
            exitCode: inspectProbe?.status ?? null,
            error: inspectProbe?.error?.message ?? null,
            containerCount: containerIds.length,
            lineCountBeforeTrim: inspectRowsBeforeTrim.length,
            fieldCountsBeforeTrim: inspectRowsBeforeTrim.map((fields) => fields.length),
            lineCountAfterTrim: inspectRowsAfterTrim.length,
            fieldCountsAfterTrim: inspectRowsAfterTrim.map((fields) => fields.length),
            finalRawLineHadEmptyHealthTab: inspectLinesBeforeTrim.at(-1)?.endsWith('\t') ?? false,
            selectedFinalFieldsBeforeTrim: inspectRowsBeforeTrim.at(-1)?.slice(0, 5) ?? [],
            selectedFinalFieldsAfterTrim: inspectRowsAfterTrim.at(-1)?.slice(0, 5) ?? [],
            stderr: String(inspectProbe?.stderr ?? '').slice(0, 1000),
          },
          selectedContainerInspectProbe: {
            engineVersion: fixture.engineVersion,
            composeVersion: fixture.composeVersion,
            templateUsesActualTabArgumentBytes: Buffer.from(selectedInspectTemplate).includes(0x09),
            exitCode: selectedInspectProbe?.status ?? null,
            error: selectedInspectProbe?.error?.message ?? null,
            containerCount: containerIds.length,
            lineCount: selectedInspectRows.length,
            fieldCounts: selectedInspectRows.map((fields) => fields.length),
            outputSeparatorsAreTabBytes: selectedInspectRows.every((fields) => fields.length === 3),
            selectedStateRows,
            stderr: String(selectedInspectProbe?.stderr ?? '').slice(0, 1000),
          },
          candidateHostFormatProbe: {
            template: 'ID, image ID, state status, startedAt, finishedAt, optional Health.Status via index .State "Health"',
            engineVersion: fixture.engineVersion,
            composeVersion: fixture.composeVersion,
            templateUsesActualTabArgumentBytes: Buffer.from(candidateInspectTemplate).includes(0x09),
            exitCode: candidateInspectProbe?.status ?? null,
            error: candidateInspectProbe?.error?.message ?? null,
            containerCount: containerIds.length,
            lineCount: candidateRowsBeforeTrim.length,
            fieldCountsBeforeTrim: candidateRowsBeforeTrim.map((fields) => fields.length),
            trailingTabBeforeTrim: candidateInspectLinesBeforeTrim.map((line) => line.endsWith('\t')),
            outputSeparatorsAreTabBytes: candidateRowsBeforeTrim.every((fields) => fields.length === 6),
            lineCountAfterTrim: candidateRowsAfterTrim.length,
            fieldCountsAfterTrim: candidateRowsAfterTrim.map((fields) => fields.length),
            selectedRows: candidateSelectedRows,
            stderr: String(candidateInspectProbe?.stderr ?? '').slice(0, 1000),
          },
          hostContainers: inspectProject(fixture.projectId),
          journalDiagnostic,
        });
      }
      expect(firstDurableJob.response.status).toBe(200);
      expect(firstDurableJob.body['state']).toBe('SUCCEEDED');
      stateAfterApplyA = inspectProject(fixture.projectId);
      expect(stateAfterApplyA).toHaveLength(4);
      expect(stateAfterApplyA.every((container) => container.status === 'running')).toBe(true);
      expect(stateAfterApplyA.filter((container) => container.serviceId === 'web')).toHaveLength(2);
      expect(stateAfterApplyA.filter((container) => container.serviceId === 'worker')).toHaveLength(2);
      expect(stateAfterApplyA.filter((container) => container.serviceId === 'web').every((container) => container.configuredImage === fixture.redisDigest)).toBe(true);
      expect(stateAfterApplyA.filter((container) => container.serviceId === 'worker').every((container) => container.configuredImage === fixture.postgresDigest)).toBe(true);
      const journalAfterDroppedAck = (await readFile(fixture.runnerJournalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const jobJournal = journalAfterDroppedAck.filter((entry) => entry['jobId'] === firstJobId);
      const pendingCompletion = jobJournal.find((entry) => entry['kind'] === 'COMPLETE_PENDING')?.['request'] as Record<string, unknown> | undefined;
      expect(pendingCompletion).toBeDefined();
      const alteredCompletion = {
        ...pendingCompletion,
        sampledAt: new Date(Date.parse(String(pendingCompletion?.['sampledAt'])) + 1000).toISOString(),
      };
      const alteredCompletionResponse = await fetch(`${internalUrl}${completionPath}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(alteredCompletion),
      });
      const alteredCompletionBody = await alteredCompletionResponse.json() as Record<string, unknown>;
      expect(alteredCompletionResponse.status).toBe(409);
      expect(problemCode(alteredCompletionBody)).toBe('RUNNER_REPORT_REJECTED');
      expect(jobJournal.filter((entry) => entry['kind'] === 'ACTION_OUTCOME')).toHaveLength(1);
      expect(jobJournal.filter((entry) => entry['kind'] === 'COMPLETE_PENDING')).toHaveLength(1);
      expect(jobJournal.some((entry) => entry['kind'] === 'COMPLETE_ACK')).toBe(false);

      const replayProxy = await createRunnerProxy(internalUrl);
      const replayRun = await runCli(['--once'], replayProxy.url, 'exact completion report replay');
      await replayProxy.close();
      expect(replayRun.exitCode).toBe(0);
      expect(replayProxy.requests.filter((request) => request.path === completionPath && request.status === 200)).toHaveLength(1);
      const journalAfterReplay = (await readFile(fixture.runnerJournalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const replayedJobJournal = journalAfterReplay.filter((entry) => entry['jobId'] === firstJobId);
      expect(replayedJobJournal.filter((entry) => entry['kind'] === 'ACTION_OUTCOME')).toHaveLength(1);
      expect(replayedJobJournal.filter((entry) => entry['kind'] === 'COMPLETE_ACK')).toHaveLength(1);
      expect(inspectProject(fixture.projectId).map((container) => [container.id, container.startedAt])).toEqual(stateAfterApplyA.map((container) => [container.id, container.startedAt]));

      const visibleButtonText = await page.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
        text: button.textContent?.trim() ?? '',
        ariaLabel: button.getAttribute('aria-label'),
        disabled: (button as HTMLButtonElement).disabled,
      })));
      await page.screenshot({ path: path.join(RAW_DIR, 'compose-post-apply-mobile-412.png'), fullPage: true });
      await writeSafeEvidence('compose-apply-a-success-and-ui-state.json', {
        jobId: firstJobId,
        durableState: firstDurableJob.body['state'],
        perServiceOutcomes: firstDurableJob.body['perServiceOutcomes'],
        actualComposeContainers: stateAfterApplyA.map(({ id, serviceId, status, configuredImage, imageId }) => ({ id, serviceId, status, configuredImage, imageId })),
        runnerRequests: lostCompleteProxy.requests,
        alteredCompletionReplay: { status: alteredCompletionResponse.status, code: problemCode(alteredCompletionBody) },
        exactCompletionRetry: { exitCode: replayRun.exitCode, status: replayProxy.requests.find((request) => request.path === completionPath)?.status },
        actionOutcomeJournalRecords: replayedJobJournal.filter((entry) => entry['kind'] === 'ACTION_OUTCOME').length,
        completionAckJournalRecords: replayedJobJournal.filter((entry) => entry['kind'] === 'COMPLETE_ACK').length,
        browserUrl: page.url(),
        buttonText: visibleButtonText,
      });

      await page.getByRole('heading', { name: 'Compose job detail', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await page.getByText('Refresh host state', { exact: true }).click();
      await page.getByText('Succeeded and observed', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: 'Open', exact: true }).first().click();
      await page.getByRole('heading', { name: 'Compose job detail', exact: true }).waitFor();
      await page.getByText('Succeeded and observed', { exact: true }).first().waitFor();
      await page.getByRole('dialog').getByText('VFY-UI13 browser confirmation for synthetic release A', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(RAW_DIR, 'compose-result-mobile-412.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
      const resultDialog = page.getByRole('dialog');
      await resultDialog.getByText('Succeeded and observed', { exact: true }).waitFor({ state: 'visible' });
      await resultDialog.getByText('web', { exact: true }).first().waitFor({ state: 'visible' });
      await resultDialog.getByText('worker', { exact: true }).first().waitFor({ state: 'visible' });
      await resultDialog.getByText('SUCCEEDED', { exact: true }).first().waitFor({ state: 'visible' });
      const serviceOutcomeList = resultDialog.locator('ul').first();
      const webOutcome = serviceOutcomeList.locator('li').filter({ hasText: 'web' }).first();
      const workerOutcome = serviceOutcomeList.locator('li').filter({ hasText: 'worker' }).first();
      await webOutcome.getByText('web', { exact: true }).waitFor({ state: 'visible' });
      await webOutcome.getByText('SUCCEEDED', { exact: true }).waitFor({ state: 'visible' });
      await workerOutcome.getByText('worker', { exact: true }).waitFor({ state: 'visible' });
      await workerOutcome.getByText('SUCCEEDED', { exact: true }).waitFor({ state: 'visible' });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 850 });
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await resultDialog.getByText('Succeeded and observed', { exact: true }).waitFor({ state: 'visible' });
        await resultDialog.getByText('VFY-UI13 browser confirmation for synthetic release A', { exact: true }).waitFor({ state: 'visible' });
        await resultDialog.getByText('web', { exact: true }).first().waitFor({ state: 'visible' });
        await resultDialog.getByText('worker', { exact: true }).first().waitFor({ state: 'visible' });
        await resultDialog.getByText('SUCCEEDED', { exact: true }).first().waitFor({ state: 'visible' });
        await workerOutcome.scrollIntoViewIfNeeded();
        await webOutcome.scrollIntoViewIfNeeded();
        const webOutcomeBox = await webOutcome.boundingBox();
        const workerOutcomeBox = await workerOutcome.boundingBox();
        expect(webOutcomeBox).not.toBeNull();
        expect(workerOutcomeBox).not.toBeNull();
        for (const outcomeBox of [webOutcomeBox!, workerOutcomeBox!]) {
          expect(outcomeBox.x).toBeGreaterThanOrEqual(0);
          expect(outcomeBox.x + outcomeBox.width).toBeLessThanOrEqual(width);
          expect(outcomeBox.y).toBeGreaterThanOrEqual(0);
          expect(outcomeBox.y + outcomeBox.height).toBeLessThanOrEqual(850);
        }
        await resultDialog.screenshot({ path: path.join(RAW_DIR, `compose-result-outcomes-mobile-${width}.png`) });
      }
      await page.setViewportSize({ width: 412, height: 850 });
      await context.close();

      const viewerBrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const viewerPage = await viewerBrowserContext.newPage();
      viewerPage.setDefaultTimeout(20_000);
      await attachSession(viewerPage, viewerSession);
      const viewerComposeRequests: string[] = [];
      viewerPage.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith('/admin/api/compose/')) viewerComposeRequests.push(pathname);
      });
      await viewerPage.goto(`${shellUrl}/admin/system-operations/services`, { waitUntil: 'domcontentloaded' });
      await viewerPage.getByText('Platform administrator access required', { exact: true }).waitFor();
      await viewerPage.waitForTimeout(250);
      expect(viewerComposeRequests).toEqual([]);
      expect(await viewerPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await viewerPage.screenshot({ path: path.join(RAW_DIR, 'compose-viewer-restricted-mobile-390.png'), fullPage: true });
      await viewerBrowserContext.close();

      const staleSubmit = await submitPreview(stalePreview, `orv13-stale-${randomUUID()}`);
      expect(staleSubmit.response.status).toBe(409);
      expect(problemCode(staleSubmit.body)).toBe('TARGET_REVISION_CONFLICT');

      await runActionApiProtocol(browser, stateAfterApplyA);
      await writeSafeEvidence('browser-apply-a-and-auth-evidence.json', {
        finalServedBundle: bundle,
        browserRequests: composeRequests,
        platformBrowserAction: { jobId: firstJobId, state: firstDurableJob.body['state'], action: firstDurableJob.body['action'], releaseId: firstDurableJob.body['releaseId'], confirmationMethod: 'Playwright pointer click', confirmationViewportWidth, perServiceOutcomes: firstDurableJob.body['perServiceOutcomes'] },
        completionLostAck: {
          droppedResponseStatus: lostCompleteProxy.requests.find((request) => request.path === completionPath)?.status,
          alteredReplayStatus: alteredCompletionResponse.status,
          alteredReplayCode: problemCode(alteredCompletionBody),
          exactReplayStatus: replayProxy.requests.find((request) => request.path === completionPath)?.status,
          hostActionOutcomeRecords: 1,
          journalAckRecordsAfterReplay: 1,
        },
        containerVectorAfterApplyA: stateAfterApplyA.map(({ id, serviceId, status, configuredImage, imageId }) => ({ id, serviceId, status, configuredImage, imageId })),
        auth: {
          noSessionBffStatus: deniedNoCookie.status,
          viewerBffStatus: deniedViewer.status,
          localTenantAdminBffStatus: tenantAdminCatalog.status,
          missingCsrfStatus: noCsrf.response.status,
          internalPlatformBearerStatus: adminOnlyInternal.status,
          internalCookieOnlyStatus: cookieOnlyInternal.status,
          invalidSessionProofStatus: invalidSessionProof.status,
          runnerCredentialOnAdminRouteStatus: runnerOnAdminRoute.status,
          adminCredentialOnRunnerRouteStatus: adminOnRunnerRoute.status,
          publicRunnerRouteStatus: publicRunnerRoute.status,
          crossHostSnapshotStatus: foreignSnapshot.status,
          viewerBrowserComposeRequests: viewerComposeRequests,
        },
        stalePreviewAfterTargetAdvance: { status: staleSubmit.response.status, code: problemCode(staleSubmit.body) },
      });
    } finally {
      await browser.close();
    }

    await writeSafeEvidence('initial-host-inventory.json', {
      hostId: fixture.hostId,
      projectId: fixture.projectId,
      manifestDigest: fixture.manifestDigest,
      engineVersion: fixture.engineVersion,
      composeVersion: fixture.composeVersion,
      dockerContextEndpoint: fixture.dockerContextEndpoint,
      rootOwnedFixture: { manifestUid: 0, manifestMode: '0644', projectUid: 0, projectMode: '0755', bindVisibleMarker: true },
      envFileProof: {
        implicitProjectDotEnvIgnored: { image: servicesWithoutEnv['web']?.['image'], sentinel: (servicesWithoutEnv['web']?.['labels'] as Record<string, unknown>)?.['orv13.sentinel'] },
        explicitPinnedEnvFileApplied: { image: servicesWithPinnedEnv['web']?.['image'], sentinel: (servicesWithPinnedEnv['web']?.['labels'] as Record<string, unknown>)?.['orv13.sentinel'] },
      },
      initialRunner: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
      catalog: { availability: catalog['availability'], projectCount: projects.length, observedServiceCount: (projects[0]?.['observedServices'] as unknown[] | undefined)?.length ?? null },
    });
  }, 120_000);

  test('competing PG claims expire RUNNING to UNKNOWN, fence the target, and replay fresh quiescent reconciliation exactly', async () => {
    if (!fixture || !app) throw new Error('fixture is not initialized');
    const previewResult = await composePreview({ action: 'restart_service', serviceId: 'web', reason: 'runner-loss expiry and quiescent reconciliation fixture' });
    if (previewResult.response.status !== 201) {
      await writeSafeEvidence('unknown-preview-probe-failure.json', {
        route: 'POST /admin/api/compose/previews',
        status: previewResult.response.status,
        body: previewResult.body,
      });
    }
    expect(previewResult.response.status).toBe(201);
    const submitted = await submitPreview(previewResult.body, `orv13-unknown-${randomUUID()}`);
    expect(submitted.response.status).toBe(201);
    const job = submitted.body['job'] as Record<string, unknown>;
    const jobId = String(job['jobId']);
    const beforeContainers = inspectProject(fixture.projectId);

    const claimPath = `${internalUrl}/api/internal/compose/runner/claim`;
    const claimResponses = await Promise.all([0, 1].map(() => fetch(claimPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
      body: '{}',
    })));
    expect(claimResponses.map((response) => response.status)).toEqual([200, 200]);
    const claims = await Promise.all(claimResponses.map(async (response) => await response.json() as { claim: Record<string, unknown> | null }));
    const claimed = claims.filter((item) => item.claim !== null);
    expect(claimed).toHaveLength(1);
    const claim = claimed[0]!.claim as Record<string, unknown>;
    const claimedJob = claim['job'] as Record<string, unknown>;
    expect(claimedJob['jobId']).toBe(jobId);
    const executionToken = String(claim['executionToken']);
    expect(executionToken.length).toBeGreaterThanOrEqual(32);
    const startResponse = await fetch(`${internalUrl}/api/internal/compose/runner/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        executionToken,
        expectedStateVersion: claimedJob['stateVersion'],
        manifestDigest: fixture.manifestDigest,
        observedDigest: claimedJob['startExpectedObservedDigest'],
      }),
    });
    expect(startResponse.status).toBe(200);
    const started = await startResponse.json() as Record<string, unknown>;
    expect(started['state']).toBe('RUNNING');

    await app.db.query("UPDATE compose_jobs SET claim_expires_at=now()-interval '1 second' WHERE job_id=$1", [jobId]);
    const expired = await runnerGetJob(jobId);
    expect(expired.response.status).toBe(200);
    expect(expired.body).toMatchObject({ state: 'UNKNOWN', uncertainReason: 'RUNNER_LOST' });
    const blockedPreviewResult = await composePreview({ action: 'restart_service', serviceId: 'worker', reason: 'active UNKNOWN job must remain fenced' });
    expect(blockedPreviewResult.response.status).toBe(409);
    expect(problemCode(blockedPreviewResult.body)).toBe('TARGET_BUSY');

    const freshObservationCycle = await runCli(['--once'], internalUrl, 'fresh genuine host observation while UNKNOWN is fenced');
    expect(freshObservationCycle.exitCode).toBe(0);
    const catalogResponse = await bffRequest(adminSession, '/compose/catalog');
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as Record<string, unknown>;
    const project = (catalog['projects'] as Array<Record<string, unknown>>).find((item) => item['projectId'] === fixture.projectId)!;
    expect(project['availability']).toBe('FRESH');
    const observedServices = project['observedServices'] as Array<Record<string, unknown>>;
    expect(observedServices.length).toBeGreaterThan(0);
    const targetServices = job['targetServices'] as string[];
    const reconcileBody = {
      jobId,
      expectedStateVersion: expired.body['stateVersion'],
      manifestDigest: fixture.manifestDigest,
      sampledAt: project['sampledAt'],
      executorQuiescent: true,
      evidenceCode: 'MANUAL_OPERATOR_CONFIRMED',
      observedServices,
      perServiceOutcomes: targetServices.map((serviceId) => ({ serviceId, status: 'UNKNOWN', errorCode: 'EXECUTION_UNCERTAIN' })),
    };
    const reconcilePath = '/api/internal/compose/runner/reconcile';
    const reconcileProxy = await createRunnerProxy(internalUrl, reconcilePath);
    let lostResponse: string | null = null;
    try {
      const response = await fetch(`${reconcileProxy.url}${reconcilePath}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(reconcileBody),
      });
      lostResponse = `${response.status}`;
    } catch (error) {
      lostResponse = error instanceof Error ? 'socket response intentionally dropped' : 'socket response intentionally dropped';
    }
    await reconcileProxy.close();
    expect(lostResponse).toBe('socket response intentionally dropped');
    expect(reconcileProxy.requests.some((request) => request.path === reconcilePath && request.status === 200 && request.dropped)).toBe(true);
    const committedReconcile = await runnerGetJob(jobId);
    expect(committedReconcile.body['state']).toBe('RECONCILED');

    const exactReplay = await fetch(`${internalUrl}${reconcilePath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(reconcileBody),
    });
    expect(exactReplay.status).toBe(200);
    const exactReplayBody = await exactReplay.json() as { job: Record<string, unknown> };
    expect(exactReplayBody.job).toMatchObject({ jobId, state: 'RECONCILED' });
    const alteredReplayBody = { ...reconcileBody, evidenceCode: 'EXECUTOR_TERMINATED' };
    const alteredReplay = await fetch(`${internalUrl}${reconcilePath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(alteredReplayBody),
    });
    const alteredReplayJson = await alteredReplay.json() as Record<string, unknown>;
    expect(alteredReplay.status).toBe(409);
    expect(problemCode(alteredReplayJson)).toBe('RUNNER_REPORT_REJECTED');
    const targetAfterReconcile = (await bffRequest(adminSession, '/compose/catalog').then((response) => response.json()) as Record<string, unknown>)['projects'] as Array<Record<string, unknown>>;
    const reconciledProject = targetAfterReconcile.find((item) => item['projectId'] === fixture.projectId)!;
    expect(reconciledProject['activeJob']).toBeNull();
    expect(inspectProject(fixture.projectId).map((container) => [container.id, container.startedAt])).toEqual(beforeContainers.map((container) => [container.id, container.startedAt]));

    await writeSafeEvidence('unknown-expiry-and-reconcile.json', {
      jobId,
      competingClaimResults: claims.map((item) => item.claim === null ? 'empty' : 'claimed'),
      runningState: started['state'],
      expiredState: { state: expired.body['state'], stateVersion: expired.body['stateVersion'], uncertainReason: expired.body['uncertainReason'] },
      busyFence: { status: blockedPreviewResult.response.status, code: problemCode(blockedPreviewResult.body) },
      freshHostObservation: { runnerExitCode: freshObservationCycle.exitCode, availability: project['availability'], observedServiceCount: observedServices.length },
      lostReconcileAck: { upstreamStatus: reconcileProxy.requests.find((request) => request.path === reconcilePath)?.status, clientResponse: lostResponse },
      exactReplay: { status: exactReplay.status, state: exactReplayBody.job['state'] },
      alteredReplay: { status: alteredReplay.status, code: problemCode(alteredReplayJson) },
      activeFenceReleasedAfterReconcile: reconciledProject['activeJob'] === null,
      hostContainersUnchanged: true,
    });
  }, 120_000);
});
