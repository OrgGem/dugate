import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STALE_WORKSPACE_MS,
  TEMP_WORKSPACE_PREFIX,
  createTempWorkspace,
  sweepStaleWorkspaces,
} from '../src';

/**
 * W46-Q2-3 (P4-05 ART-02 clause, Qwen-2 / term_4d79e7d3) — offline guard tests:
 * the stale-workspace sweep must reap ONLY true orphans. A workspace still
 * referenced by active metadata/checkpoints is kept regardless of TTL.
 * Real temp dirs only; zero DB/Redis.
 */

const BACKDATED = new Date(Date.now() - (DEFAULT_STALE_WORKSPACE_MS + 60_000));

async function plantStaleDir(root: string, name: string): Promise<string> {
  const dir = join(root, `${TEMP_WORKSPACE_PREFIX}${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'payload.bin'), 'staged bytes', 'utf8');
  await utimes(dir, BACKDATED, BACKDATED);
  return dir;
}

describe('ART-02 sweep live-reference guard (offline, W46-Q2-3)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'du-guard-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('orphan past TTL with no active reference IS removed', async () => {
    const orphan = await plantStaleDir(root, 'orphan-1');

    const result = await sweepStaleWorkspaces({ rootDir: root });

    expect(result.removed).toContain(orphan);
    expect(result.kept).not.toContain(orphan);
    expect(existsSync(orphan)).toBe(false);
  });

  it('workspace still referenced by ACTIVE metadata/checkpoint stays UNTOUCHED past TTL', async () => {
    const referenced = await plantStaleDir(root, 'referenced-1');
    const other = await plantStaleDir(root, 'orphan-2');

    const result = await sweepStaleWorkspaces({
      rootDir: root,
      hasActiveReference: async (dir) => dir === referenced,
    });

    // Referenced dir survives with bytes intact; genuine orphan is still reaped.
    expect(result.kept).toContain(referenced);
    expect(result.removed).not.toContain(referenced);
    expect(existsSync(referenced)).toBe(true);
    await expect(readdir(referenced).then((f) => f)).resolves.toContain('payload.bin');
    expect(existsSync(other)).toBe(false);
  });

  it('in-process live workspace (created, not disposed) is never swept even when backdated', async () => {
    const workspace = await createTempWorkspace('11111111-2222-4333-8444-555555555555', { rootDir: root });
    await writeFile(workspace.filePath('inflight.bin'), 'active task bytes', 'utf8');
    await utimes(workspace.dir, BACKDATED, BACKDATED); // mtime lies; ownership does not

    const result = await sweepStaleWorkspaces({ rootDir: root });

    expect(result.kept).toContain(workspace.dir);
    expect(result.removed).not.toContain(workspace.dir);
    expect(existsSync(workspace.dir)).toBe(true);

    // After dispose the dir is gone and nothing lingers in the registry path.
    await workspace.dispose();
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it('non-SDK temp entries are never touched even past TTL (prefix safety preserved)', async () => {
    const foreign = join(root, 'not-ours-1');
    await mkdir(foreign, { recursive: true });
    await utimes(foreign, BACKDATED, BACKDATED);

    const result = await sweepStaleWorkspaces({ rootDir: root });

    expect(existsSync(foreign)).toBe(true);
    expect(result.removed).toHaveLength(0);
    const st = await stat(foreign);
    expect(st.isDirectory()).toBe(true);
  });
});
