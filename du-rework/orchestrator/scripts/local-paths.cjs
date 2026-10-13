'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function resolveLocalPath(root, value, label) {
  const rootPath = fs.realpathSync(root);
  const target = path.resolve(rootPath, value);
  if (!isWithin(rootPath, target)) throw new Error(`${label} must point to a file inside the orchestrator directory.`);
  let realTarget;
  try { realTarget = fs.realpathSync(target); } catch {
    throw new Error(`${label} was not found inside the orchestrator directory.`);
  }
  if (!isWithin(rootPath, realTarget)) throw new Error(`${label} resolves outside the orchestrator directory.`);
  return realTarget;
}

module.exports = { isWithin, resolveLocalPath };
