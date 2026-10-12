import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInfrastructureHealthy,
  cleanupHostInfrastructureFixture,
  createHostInfrastructureFixture,
  createPgServiceFiles,
  verifyPostgresPlaneIdentities,
  writeRootOwnedFiles,
} from './infrastructure.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = path.join(REPO, 'coordination/reports/raw/orv14-host-verification');
const startedAt = new Date().toISOString();
const fixture = await createHostInfrastructureFixture();
let outcome = 'FAILED';
let errorMessage = null;
let cleanup = null;
let health = null;
let planes = null;
let trustedFiles = [];

try {
  const pg = createPgServiceFiles(fixture);
  trustedFiles = await writeRootOwnedFiles(fixture, [
    { relativePath: 'trusted/config/manifest.json', bytes: JSON.stringify({ schemaVersion: 1, task: 'VFY-ORV14-HOST-CONTINUITY', data: 'synthetic-only' }), mode: 0o444 },
    { relativePath: 'trusted/config/pg_service.conf', bytes: pg.serviceFile, mode: 0o444 },
    { relativePath: 'trusted/config/pgpass', bytes: pg.passfile, mode: 0o444 },
  ]);
  health = await assertInfrastructureHealthy(fixture);
  planes = verifyPostgresPlaneIdentities(fixture);
  outcome = 'PASSED';
} catch (error) {
  errorMessage = error instanceof Error ? error.message.slice(0, 800) : 'unknown fixture error';
} finally {
  try {
    cleanup = await cleanupHostInfrastructureFixture(fixture);
  } catch (error) {
    outcome = 'FAILED';
    errorMessage = `${errorMessage ? `${errorMessage}; ` : ''}cleanup: ${error instanceof Error ? error.message.slice(0, 800) : 'unknown cleanup error'}`;
  }
}

const result = {
  task: 'VFY-ORV14-HOST-CONTINUITY',
  stage: 'source-independent infrastructure preparation',
  outcome,
  startedAt,
  completedAt: new Date().toISOString(),
  cwd: REPO,
  nodeVersion: process.version,
  composeProject: fixture.projectId,
  composeFile: path.relative(REPO, fixture.composeFile),
  composeSha256: fixture.composeSha256,
  imageIds: fixture.imageIds,
  checks: {
    passed: outcome === 'PASSED' ? 5 + (planes?.length ?? 0) + trustedFiles.length : 0,
    failed: outcome === 'PASSED' ? 0 : 1,
    skipped: 0,
    infrastructure: health,
    postgresPlaneIdentities: planes,
    rootOwnedReadableFixtureFiles: trustedFiles,
  },
  cleanup,
  verdict: 'Preparation evidence only. No source APIs, application workflows, backup, restore, migration, or cutover were executed.',
  error: errorMessage,
};

await mkdir(RAW, { recursive: true });
const rawPath = path.join(RAW, 'infrastructure-preparation.json');
await writeFile(rawPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ outcome, composeProject: fixture.projectId, checks: result.checks, cleanup: Boolean(cleanup), rawPath })}\n`);
if (outcome !== 'PASSED') process.exitCode = 1;
