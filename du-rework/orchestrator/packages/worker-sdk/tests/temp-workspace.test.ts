import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ArtifactStreamError,
  DEFAULT_STALE_WORKSPACE_MS,
  TEMP_WORKSPACE_PREFIX,
  createTempWorkspace,
  sweepStaleWorkspaces,
} from '../src/artifact-streams';
import type { TempWorkspace } from '../src/artifact-streams';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdtemp: jest.fn(actual.mkdtemp),
    readdir: jest.fn(actual.readdir),
    rm: jest.fn(actual.rm),
    stat: jest.fn(actual.stat),
  };
});

describe('createTempWorkspace concurrent isolation and sweep', () => {
  let root: string;
  const workspaces: TempWorkspace[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'du-temp-workspace-test-'));
  });

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose().catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
  });

  async function makeWorkspace(taskId: string): Promise<TempWorkspace> {
    const workspace = await createTempWorkspace(taskId, { rootDir: root });
    workspaces.push(workspace);
    return workspace;
  }

  async function markStale(directory: string): Promise<void> {
    const old = new Date(Date.now() - DEFAULT_STALE_WORKSPACE_MS - 60_000);
    await utimes(directory, old, old);
  }

  it('allocates disjoint paths for concurrent workers with the same task ID', async () => {
    const workerCount = 8;
    const concurrent = await Promise.all(
      Array.from({ length: workerCount }, () => makeWorkspace('shared/task-id'))
    );
    const paths = concurrent.map((workspace) => workspace.dir);

    expect(new Set(paths).size).toBe(workerCount);
    expect(concurrent.every((workspace) => workspace.taskId === 'shared-task-id')).toBe(true);
    expect(paths.every((directory) => directory.startsWith(root))).toBe(true);
    expect(paths.every((directory) => basename(directory).startsWith(`${TEMP_WORKSPACE_PREFIX}shared-task-id-`))).toBe(true);

    const expectedContents = concurrent.map((_, index) => `worker-${index}`);
    await Promise.all(
      concurrent.map((workspace, index) => writeFile(workspace.filePath('marker.txt'), expectedContents[index]!, 'utf8'))
    );
    const actualContents = await Promise.all(
      concurrent.map((workspace) => readFile(workspace.filePath('marker.txt'), 'utf8'))
    );
    expect(actualContents).toEqual(expectedContents);

    // Disposing one worker's directory must not remove or change any sibling workspace.
    const disposed = concurrent[0]!;
    const sibling = concurrent[1]!;
    await disposed.dispose();
    expect(existsSync(disposed.dir)).toBe(false);
    expect(existsSync(sibling.dir)).toBe(true);
    expect(await readFile(sibling.filePath('marker.txt'), 'utf8')).toBe(expectedContents[1]);
  });

  it('sweeps only stale SDK-prefixed orphans and preserves active neighboring workspaces', async () => {
    const active = await Promise.all([
      makeWorkspace('active-worker-a'),
      makeWorkspace('active-worker-b'),
    ]);
    for (const [index, workspace] of active.entries()) {
      await writeFile(workspace.filePath('inflight.txt'), `active-${index}`, 'utf8');
      await markStale(workspace.dir);
    }

    const orphan = join(root, `${TEMP_WORKSPACE_PREFIX}crashed-${randomUUID()}`);
    await mkdir(orphan);
    await writeFile(join(orphan, 'leftover.txt'), 'orphan', 'utf8');
    await markStale(orphan);

    // A sibling with a near-match prefix belongs to another workspace manager.
    const neighboring = join(root, `${TEMP_WORKSPACE_PREFIX.slice(0, -1)}x-neighbor-${randomUUID()}`);
    await mkdir(neighboring);
    await writeFile(join(neighboring, 'keep.txt'), 'neighbor', 'utf8');
    await markStale(neighboring);

    expect(basename(active[0]!.dir).startsWith(TEMP_WORKSPACE_PREFIX)).toBe(true);
    expect(basename(orphan).startsWith(TEMP_WORKSPACE_PREFIX)).toBe(true);
    expect(basename(neighboring).startsWith(TEMP_WORKSPACE_PREFIX)).toBe(false);

    const result = await sweepStaleWorkspaces({ rootDir: root, now: () => Date.now() });

    expect(result.removed).toEqual([orphan]);
    expect(result.kept).toEqual(expect.arrayContaining(active.map((workspace) => workspace.dir)));
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(neighboring)).toBe(true);
    expect(await readFile(join(neighboring, 'keep.txt'), 'utf8')).toBe('neighbor');
    for (const [index, workspace] of active.entries()) {
      expect(existsSync(workspace.dir)).toBe(true);
      expect(await readFile(workspace.filePath('inflight.txt'), 'utf8')).toBe(`active-${index}`);
    }
  });

  it('rejects a missing workspace root and treats a missing sweep root as empty', async () => {
    const missingRoot = join(root, 'root-does-not-exist');

    await expect(createTempWorkspace('missing-root', { rootDir: missingRoot })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(sweepStaleWorkspaces({ rootDir: missingRoot })).resolves.toEqual({ removed: [], kept: [] });
    expect(existsSync(missingRoot)).toBe(false);
  });

  it('rejects traversal and path-separator names before returning a filesystem path', async () => {
    const workspace = await makeWorkspace('path-boundary');
    const invalidNames = [
      '../outside.txt',
      '..\\outside.txt',
      'nested/file.txt',
      'C:\\outside.txt',
      'NUL.txt',
      '\\\\server\\share.txt',
      '..',
      '.',
      '\0',
      'line\nfeed.txt',
      'x'.repeat(256),
    ];

    for (const name of invalidNames) {
      expect(() => workspace.filePath(name)).toThrow(ArtifactStreamError);
    }
    expect(workspace.filePath('inside.txt')).toBe(join(workspace.dir, 'inside.txt'));
    expect(existsSync(join(root, 'outside.txt'))).toBe(false);
  });

  it('keeps a stale workspace when cleanup fails with a permission error', async () => {
    const orphan = join(root, `${TEMP_WORKSPACE_PREFIX}permission-denied-${randomUUID()}`);
    await mkdir(orphan);
    await markStale(orphan);
    const permissionError = Object.assign(new Error('cleanup permission denied'), { code: 'EACCES' });
    jest.mocked(rm).mockRejectedValueOnce(permissionError);
    const result = await sweepStaleWorkspaces({ rootDir: root });

    expect(result!.removed).not.toContain(orphan);
    expect(result!.kept).toContain(orphan);
    expect(existsSync(orphan)).toBe(true);
  });

  it('keeps a stale prefixed directory when its metadata is unreadable', async () => {
    const orphan = join(root, `${TEMP_WORKSPACE_PREFIX}unreadable-${randomUUID()}`);
    await mkdir(orphan);
    await markStale(orphan);
    const permissionError = Object.assign(new Error('workspace metadata is unreadable'), { code: 'EACCES' });
    jest.mocked(stat).mockRejectedValueOnce(permissionError);

    const result = await sweepStaleWorkspaces({ rootDir: root });

    expect(result.kept).toContain(orphan);
    expect(result.removed).not.toContain(orphan);
    expect(existsSync(orphan)).toBe(true);
  });

  it('treats an unreadable temporary root as an empty sweep without throwing', async () => {
    const permissionError = Object.assign(new Error('temporary root is unreadable'), { code: 'EACCES' });
    jest.mocked(readdir).mockRejectedValueOnce(permissionError);

    await expect(sweepStaleWorkspaces({ rootDir: root })).resolves.toEqual({ removed: [], kept: [] });
  });

  it('does not provision a partial workspace when the root denies creation', async () => {
    const permissionError = Object.assign(new Error('workspace root is not writable'), { code: 'EACCES' });
    jest.mocked(mkdtemp).mockRejectedValueOnce(permissionError);

    await expect(createTempWorkspace('denied-root', { rootDir: root })).rejects.toBe(permissionError);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('does not follow a workspace symlink into an external target during dispose', async () => {
    const workspace = await makeWorkspace('symlink-cleanup-boundary');
    const outsideRoot = await mkdtemp(join(tmpdir(), 'du-temp-workspace-outside-'));
    const outsideMarker = join(outsideRoot, 'must-survive.txt');
    const linkPath = workspace.filePath('outside-target');
    try {
      await writeFile(outsideMarker, 'external data', 'utf8');
      await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      await workspace.dispose();

      expect(existsSync(workspace.dir)).toBe(false);
      expect(existsSync(outsideMarker)).toBe(true);
      expect(await readFile(outsideMarker, 'utf8')).toBe('external data');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('propagates unexpected dispose errors instead of swallowing them', async () => {
    const workspace = await makeWorkspace('unexpected-cleanup-error');
    const unexpected = new Error('unexpected cleanup invariant failure');
    jest.mocked(rm).mockRejectedValueOnce(unexpected);

    await expect(workspace.dispose()).rejects.toBe(unexpected);
  });

  it('rejects an empty task ID and sanitizes special characters and overlong IDs', async () => {
    await expect(createTempWorkspace('', { rootDir: root })).rejects.toMatchObject({
      code: 'INVALID_FILE_NAME',
    });

    const hostileTaskId = '../tenant:worker\\task?#';
    const workspace = await makeWorkspace(hostileTaskId);
    const expectedTaskId = hostileTaskId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);

    expect(workspace.taskId).toBe(expectedTaskId);
    expect(workspace.taskId).toMatch(/^[A-Za-z0-9-]+$/);
    expect(workspace.dir).toBe(join(root, basename(workspace.dir)));

    const overlong = await makeWorkspace('t'.repeat(80));
    expect(overlong.taskId).toHaveLength(64);
    expect(overlong.dir).toBe(join(root, basename(overlong.dir)));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not expire an active workspace with olderThanMs=%s',
    async (olderThanMs) => {
      const workspace = await makeWorkspace(`ttl-${String(olderThanMs)}`);

      const result = await sweepStaleWorkspaces({
        rootDir: root,
        olderThanMs,
        now: () => Date.now() + DEFAULT_STALE_WORKSPACE_MS * 10,
      });

      expect(result.removed).not.toContain(workspace.dir);
      expect(result.kept).toContain(workspace.dir);
      expect(existsSync(workspace.dir)).toBe(true);
    }
  );

  it('disposes successfully when the workspace directory was already removed', async () => {
    const workspace = await makeWorkspace('externally-removed');
    await rm(workspace.dir, { recursive: true, force: true });

    await expect(workspace.dispose()).resolves.toBeUndefined();
    await expect(workspace.dispose()).resolves.toBeUndefined();
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it('makes concurrent dispose calls idempotent while cleanup is in flight', async () => {
    const workspace = await makeWorkspace('dispose-race');
    const actualRm = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises').rm;
    const rmMock = jest.mocked(rm);
    const callsBefore = rmMock.mock.calls.length;
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => { markRemovalStarted = resolve; });
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });

    rmMock.mockImplementationOnce(async (path, options) => {
      markRemovalStarted();
      await removalGate;
      return actualRm(path, options);
    });

    const firstDispose = workspace.dispose();
    await removalStarted;
    try {
      await expect(workspace.dispose()).resolves.toBeUndefined();
      expect(rmMock.mock.calls.length - callsBefore).toBe(1);
      expect(existsSync(workspace.dir)).toBe(true);
    } finally {
      releaseRemoval();
    }

    await expect(firstDispose).resolves.toBeUndefined();
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it('tolerates concurrent stale sweeps racing to remove the same orphan', async () => {
    const orphan = join(root, `${TEMP_WORKSPACE_PREFIX}parallel-sweep-${randomUUID()}`);
    await mkdir(orphan);
    await markStale(orphan);
    const actualRm = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises').rm;
    const rmMock = jest.mocked(rm);
    const originalImplementation = rmMock.getMockImplementation() ?? actualRm;
    let removalsStarted = 0;
    let releaseRemovals!: () => void;
    const bothRemovalsStarted = new Promise<void>((resolve) => { releaseRemovals = resolve; });
    rmMock.mockImplementation(async (path, options) => {
      removalsStarted += 1;
      if (removalsStarted === 2) releaseRemovals();
      await bothRemovalsStarted;
      return actualRm(path, options);
    });

    try {
      const [first, second] = await Promise.all([
        sweepStaleWorkspaces({ rootDir: root }),
        sweepStaleWorkspaces({ rootDir: root }),
      ]);

      expect(removalsStarted).toBe(2);
      expect(first.removed).toContain(orphan);
      expect(second.removed).toContain(orphan);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmMock.mockImplementation(originalImplementation);
    }
  });

  it('allocates distinct directories under bounded concurrent load without racing', async () => {
    const concurrencyLimit = 48;
    const concurrent = await Promise.all(
      Array.from({ length: concurrencyLimit }, () => makeWorkspace('allocation/race-task'))
    );
    const paths = concurrent.map((workspace) => workspace.dir);

    expect(concurrent).toHaveLength(concurrencyLimit);
    expect(new Set(paths).size).toBe(concurrencyLimit);
    expect(concurrent.every((workspace) => existsSync(workspace.dir))).toBe(true);
    expect(concurrent.every((workspace) => workspace.taskId === 'allocation-race-task')).toBe(true);
    expect(paths.every((directory) => directory === join(root, basename(directory)))).toBe(true);
  });
});
