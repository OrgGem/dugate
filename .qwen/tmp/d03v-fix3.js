const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let t = fs.readFileSync(F, 'utf8');
let ap = [];

// 1) heading count
const A1 = '#### Full orchestrator suite — 3 đỏ, phân loại từng cái';
const B1 = '#### Full orchestrator suite — 5 đỏ, phân loại từng cái';
if (t.indexOf(A1) !== -1) { t = t.replace(A1, B1); ap.push('heading'); }

// 2) collapse the duplicated mtime block into ONE measurement, latest wins
const A2 = [
'src/app/admin/shell-router.ts    mtime=2026-09-27T22:19:32Z   <-- Admin/SEC lane',
'src/app/admin/shell-server.ts    mtime=2026-09-27T21:15:25Z   <-- Admin/SEC lane',
'src/modules/runtime/runtime.ts   mtime=2026-09-27T22:13:48Z   <-- của tôi (cycle này)',
'src/modules/operations/ingestion-consumer.ts  mtime=2026-09-26T10:03:05Z  (không chạm)',
'src/app/admin/shell-router.ts    mtime=2026-09-27T22:21:23Z   <-- Admin/SEC lane (dịch so với lần đo đầu)',
'tests/admin-crypto-config-oidc.test.ts mtime=2026-09-27T22:29:19Z  <-- ghi SAU runtime.ts của tôi'
].join('\n');
const B2 = [
'src/app/admin/shell-router.ts    mtime=2026-09-27T22:21:23Z   <-- Admin/SEC lane',
'src/app/admin/shell-server.ts    mtime=2026-09-27T21:15:25Z   <-- Admin/SEC lane',
'tests/admin-crypto-config-oidc.test.ts mtime=2026-09-27T22:29:19Z  <-- Admin/SEC lane',
'src/modules/runtime/runtime.ts   mtime=2026-09-27T22:13:48Z   <-- của tôi (cycle này)',
'src/modules/operations/ingestion-consumer.ts  mtime=2026-09-26T10:03:05Z  (không chạm)'
].join('\n');
if (t.indexOf(A2) !== -1) { t = t.replace(A2, B2); ap.push('mtime-dedupe'); }

// 3) ledger row 23: real foreign count
const A3 = 'full suite 3 do ngoai lai (admin-shell, mtime shell-router 22:19Z > runtime 22:13Z, grep khong co claimTask)';
const B3 = 'full suite 5 suite do ngoai lai (admin-shell/crypto-config/admin-error-boundary; oidc test mtime 22:29Z > runtime 22:13Z, grep khong co claimTask, 0 url-ingestion do)';
if (t.indexOf(A3) !== -1) { t = t.replace(A3, B3); ap.push('ledger'); }

t = t.replace(/\n+$/, '\n');
fs.writeFileSync(F, t, 'utf8');
console.log('applied=' + JSON.stringify(ap));
console.log('dup_router_remaining=' + (t.split('src/app/admin/shell-router.ts').length - 1));
console.log('heading_3do_gone=' + (t.indexOf('Full orchestrator suite — 3 đỏ') === -1));
console.log('endsWithSingleLF=' + (t.charCodeAt(t.length-1) === 10 && t.charCodeAt(t.length-2) !== 10));