const { execSync } = require('child_process');
const cwd = 'D:/Git/dugate/du-rework';
const out = execSync('git diff --numstat -- packages/contracts/src/runtime.ts', { cwd }).toString().trim();
console.log('numstat now: ' + out);
const t = require('fs').readFileSync('D:/Git/dugate/du-rework/packages/contracts/src/runtime.ts', 'utf8');
console.log('tail: ' + JSON.stringify(t.slice(-60)));
const i = t.indexOf('export const ArtifactAccessGrantSchema');
console.log('--- grant schema ---');
console.log(t.slice(i, t.indexOf('export type ArtifactAccessGrant')))