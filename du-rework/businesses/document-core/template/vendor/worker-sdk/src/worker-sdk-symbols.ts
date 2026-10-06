// VENDORED (Option B - extracted symbols) from @du/worker-sdk @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source A: packages/worker-sdk/src/task-context.ts:52-57 -> LeaseLostError
// source B: packages/worker-sdk/src/artifact-streams.ts:50-77 -> ArtifactStreamError + ArtifactStreamErrorCode
//           packages/worker-sdk/src/artifact-streams.ts:119-185 -> TEMP_WORKSPACE_PREFIX, liveWorkspaces,
//           TempWorkspaceOptions, TempWorkspace, createTempWorkspace, sanitizeTaskId, assertSafeFileName
// why: LeaseLostError for src/actions/{extract,transform,compare,analyze}/index.ts + src/pipelines/step-checkpoint.ts;
//      ArtifactStreamError for src/pipelines/parser-budget.ts; createTempWorkspace for src/pipelines/parser-budget.ts
// NOTE: Option B extracts ONLY these 3 symbols. The rest of worker-sdk is NOT vendored.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Thrown when the lease is lost mid-delivery; the abort signal fires and no new provider calls are made. */
export class LeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`lease lost for task ${taskId}; aborting delivery`);
    this.name = 'LeaseLostError';
  }
}

export type ArtifactStreamErrorCode =
  | 'INVALID_FILE_NAME'
  | 'INVALID_URL'
  | 'GRANT_REJECTED'
  | 'DOWNLOAD_REJECTED'
  | 'TOO_LARGE'
  | 'HASH_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'EMPTY_BODY'
  | 'TIMEOUT'
  | 'OUTPUT_NOT_COMMITTED'
  | 'TRANSPORT_FAILURE';

/** Typed failure for every artifact-stream path (discriminated by `code`). */
export class ArtifactStreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: ArtifactStreamErrorCode,
    detail?: string
  ) {
    super(detail ?? `artifact stream failed: ${code} (status ${status})`);
    this.name = 'ArtifactStreamError';
  }
}

/** Prefix for every SDK-managed temp dir; the sweeper only touches these. */
export const TEMP_WORKSPACE_PREFIX = 'du-worker-';

/**
 * ART-02 live-reference guard (P4-05 clause): every workspace currently owned
 * and undisposed by this process. The sweeper never removes a registered dir,
 * regardless of mtime - TTL alone must not delete bytes an in-flight task,
 * metadata or checkpoint can still point at.
 */
const liveWorkspaces = new Set<string>();

export interface TempWorkspaceOptions {
  /** Root for the workspace dir; defaults to `os.tmpdir()`. */
  rootDir?: string;
}

export interface TempWorkspace {
  dir: string;
  taskId: string;
  filePath(fileName: string): string;
  dispose(): Promise<void>;
}

export async function createTempWorkspace(
  taskId: string,
  opts: TempWorkspaceOptions = {}
): Promise<TempWorkspace> {
  const safeTaskId = sanitizeTaskId(taskId);
  const root = opts.rootDir ?? tmpdir();
  const dir = await mkdtemp(join(root, `${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`));
  liveWorkspaces.add(dir);
  let disposed = false;
  return {
    dir,
    taskId: safeTaskId,
    filePath(fileName: string): string {
      assertSafeFileName(fileName);
      return join(dir, fileName);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      liveWorkspaces.delete(dir);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function sanitizeTaskId(taskId: string): string {
  // Task IDs are UUIDs; anything else (hostile or legacy) folds to '-'.
  const safe = taskId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
  if (safe.length === 0) throw new ArtifactStreamError(0, 'INVALID_FILE_NAME', 'empty taskId');
  return safe;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function assertSafeFileName(fileName: string): void {
  const invalid = (detail: string): never => {
    throw new ArtifactStreamError(0, 'INVALID_FILE_NAME', detail);
  };
  if (typeof fileName !== 'string' || fileName.length === 0) invalid('file name is empty');
  if (fileName.length > 255) invalid('file name exceeds 255 chars');
  if (fileName === '.' || fileName === '..') invalid('file name is a directory reference');
  if (fileName.includes('/') || fileName.includes('\\')) invalid('file name contains a path separator');
  if (fileName.includes('\0')) invalid('file name contains NUL');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(fileName)) invalid('file name contains control characters');
  if (WINDOWS_RESERVED.test(fileName)) invalid('file name is a reserved device name');
}
