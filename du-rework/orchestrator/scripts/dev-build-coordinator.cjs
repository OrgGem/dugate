const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BUILD_STATE_VERSION = 1;

function coordinatorPaths(workspaceRoot) {
  const cacheDirectory = path.join(workspaceRoot, 'node_modules', '.cache');
  return {
    cacheDirectory,
    lockDirectory: path.join(cacheDirectory, 'dugate-dev-build.lock'),
    lockOwner: path.join(cacheDirectory, 'dugate-dev-build.lock', 'owner.json'),
    stateFile: path.join(cacheDirectory, 'dugate-dev-build-state.json'),
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBuildLock(workspaceRoot, run, { shouldStop = () => false } = {}) {
  const paths = coordinatorPaths(workspaceRoot);
  fs.mkdirSync(paths.cacheDirectory, { recursive: true });
  const token = randomUUID();
  while (true) {
    if (shouldStop()) throw new Error('Development session is shutting down.');
    let created = false;
    try {
      fs.mkdirSync(paths.lockDirectory);
      created = true;
      fs.writeFileSync(paths.lockOwner, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }));
      break;
    } catch (error) {
      if (created) fs.rmSync(paths.lockDirectory, { recursive: true, force: true });
      if (!error || error.code !== 'EEXIST') throw error;

      let owner;
      try { owner = JSON.parse(fs.readFileSync(paths.lockOwner, 'utf8')); } catch {}
      if (owner && !isProcessAlive(owner.pid)) {
        throw new Error(`Stale development build lock from PID ${owner.pid}; remove ${paths.lockDirectory} and retry.`);
      }
      if (!owner) {
        let ageMs = 0;
        try { ageMs = Date.now() - fs.statSync(paths.lockDirectory).mtimeMs; } catch {}
        if (ageMs > 10_000) {
          throw new Error(`Incomplete development build lock; remove ${paths.lockDirectory} and retry.`);
        }
      }
      await wait(250);
    }
  }

  try {
    return await run();
  } finally {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(paths.lockOwner, 'utf8')); } catch {}
    if (owner?.token === token) {
      const releasedPath = `${paths.lockDirectory}.released-${process.pid}-${token}`;
      try {
        fs.renameSync(paths.lockDirectory, releasedPath);
        fs.rmSync(releasedPath, { recursive: true, force: true });
      } catch {}
    }
  }
}

function publishBuildState(workspaceRoot, status, details = {}) {
  const paths = coordinatorPaths(workspaceRoot);
  fs.mkdirSync(paths.cacheDirectory, { recursive: true });
  const state = {
    version: BUILD_STATE_VERSION,
    buildId: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status,
    source: details.source || 'orchestrator',
    reason: details.reason || 'source-change',
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${paths.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state));
  fs.renameSync(temporaryPath, paths.stateFile);
  return state;
}

function readBuildState(workspaceRoot) {
  const { stateFile } = coordinatorPaths(workspaceRoot);
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state && state.version === BUILD_STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

module.exports = { coordinatorPaths, withBuildLock, publishBuildState, readBuildState };
