'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CANONICAL_IGNORED_DIRECTORY_NAMES = new Set([
  'coverage',
  'dist',
  'node_modules',
  'tests',
  '__tests__',
]);
const IGNORED_OUTPUT_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  'build',
  'builds',
  'build-state',
  'buildstate',
  'temp',
  'test',
  'tmp',
]);
const IGNORED_FILE_SUFFIXES = ['.bak', '.orig', '.swp', '.swo', '.temp', '.tmp', '~'];

function normalizeFilename(filename) {
  if (filename === null || filename === undefined) return null;
  return (Buffer.isBuffer(filename) ? filename.toString() : String(filename))
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

function isInsideSource(relativePath) {
  return relativePath.split('/').some((part) => part.toLowerCase() === 'src');
}

function hasCanonicalIgnoredPathPart(relativePath) {
  return relativePath.split('/').some((part) => CANONICAL_IGNORED_DIRECTORY_NAMES.has(part.toLowerCase()));
}

function hasIgnoredOutputPathPart(relativePath) {
  return relativePath.split('/').some((part) => IGNORED_OUTPUT_DIRECTORY_NAMES.has(part.toLowerCase()));
}

function hasIgnoredPathPart(relativePath) {
  return hasCanonicalIgnoredPathPart(relativePath)
    || (!isInsideSource(relativePath) && hasIgnoredOutputPathPart(relativePath));
}

function isBuildInputPath(relativePath) {
  const normalized = normalizeFilename(relativePath);
  if (!normalized || hasCanonicalIgnoredPathPart(normalized)) return false;

  const parts = normalized.split('/');
  const basename = parts.at(-1);
  const lowerBasename = basename.toLowerCase();
  const insideSource = isInsideSource(normalized);
  if (!insideSource && hasIgnoredOutputPathPart(normalized)) return false;
  if (!insideSource && IGNORED_FILE_SUFFIXES.some((suffix) => lowerBasename.endsWith(suffix))) return false;
  if (!insideSource && (lowerBasename.includes('build-state') || lowerBasename.includes('buildstate') || lowerBasename.endsWith('.tsbuildinfo'))) return false;
  return insideSource
    || lowerBasename === 'package.json'
    || /^tsconfig(?:\.[^/]+)?\.json$/i.test(basename);
}

function isRelevantWatchEvent(filename) {
  const normalized = normalizeFilename(filename);
  return normalized === null || !hasIgnoredPathPart(normalized);
}

function isRootConfigWatchEvent(filename) {
  const normalized = normalizeFilename(filename);
  if (normalized === null) return true;
  if (normalized.includes('/')) return false;
  return normalized === 'package.json' || /^tsconfig(?:\.[^/]+)?\.json$/i.test(normalized);
}

function collectBuildInputFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const files = [];

  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of rootEntries) {
    const relativePath = entry.name;
    if (entry.isFile() && isBuildInputPath(relativePath)) files.push(relativePath);
  }

  function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!hasIgnoredPathPart(relativePath)) {
          walk(path.join(directory, entry.name), relativePath);
        }
      } else if (entry.isFile() && isBuildInputPath(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  for (const directoryName of ['packages', 'services']) {
    const directory = path.join(root, directoryName);
    if (fs.existsSync(directory)) walk(directory, directoryName);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function buildInputFingerprint(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const hash = createHash('sha256');
  for (const relativePath of collectBuildInputFiles(root)) {
    let contents;
    try {
      contents = fs.readFileSync(path.join(root, relativePath));
    } catch (error) {
      // A file can disappear between enumeration and reading. The next watcher
      // event will compare the stable tree after the filesystem operation ends.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    hash.update(relativePath.replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createBuildInputTracker(workspaceRoot) {
  let previousFingerprint = buildInputFingerprint(workspaceRoot);
  return {
    hasChanged() {
      const nextFingerprint = buildInputFingerprint(workspaceRoot);
      if (nextFingerprint === previousFingerprint) return false;
      previousFingerprint = nextFingerprint;
      return true;
    },
  };
}

module.exports = {
  buildInputFingerprint,
  collectBuildInputFiles,
  createBuildInputTracker,
  isBuildInputPath,
  isRelevantWatchEvent,
  isRootConfigWatchEvent,
};
