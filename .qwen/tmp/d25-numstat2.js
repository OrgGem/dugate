const { execSync } = require('child_process');
const cwd = 'D:/Git/dugate/du-rework';
try {
  const out = execSync('git diff --numstat -- packages/contracts/src/encryption.ts packages/contracts/src/runtime.ts', { cwd }).toString();
  console.log('numstat:\n' + out.trim());
} catch (e) { console.log('ERR: ' + String(e.stdout || e.message).slice(0, 300)); }
try {
  const st = execSync('git status --short -- packages/contracts/src', { cwd }).toString();
  console.log('status:\n' + st.trim());
} catch (e) { console.log('ERR2: ' + String(e.stdout || e.message).slice(0, 200)); }