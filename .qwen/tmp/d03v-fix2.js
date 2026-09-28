const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let t = fs.readFileSync(F, 'utf8');
let applied = [];

// A) correct the full-suite summary numbers
const A1 = '`Test Suites: 3 failed, 1 skipped, 86 passed, 90 total` /\n`Tests: 3 failed, 28 skipped, 1988 passed, 2019 total`.';
const B1 = '`Test Suites: 5 failed, 1 skipped, 86 passed, 91 of 92 total` /\n`Tests: 8 failed, 28 skipped, 1992 passed, 2028 total` (run lại 2026-09-28 ~22:35Z).\n\nLưu ý đọc log: jest liệt kê **mỗi** file FAIL 2 lần (khối đầu + bảng tổng kết), nên\n5 dòng FAIL trong log tương ứng **5 suite**, không phải 10. Không url-ingestion nào đỏ.';
if (t.indexOf(A1) !== -1) { t = t.replace(A1, B1); applied.push('summary'); }

// B) add the two newly-observed foreign rows to the table
const A2 = '| `adm-base-03-safe-error-offline` | **ngoại lai** | log text rỗng, cùng vùng admin-shell, không import `claimTask` |';
const B2 = A2 + '\n| `admin-crypto-config-oidc` | **ngoại lai, mới xuất hiện ở run này** | W-ENC-08-CSRF-OIDC, lỗi `CRYPTO_CONFIG_TENANT_REQUIRED`; grep `claimTask\\|PENDING_INGESTION` → **No matches** |\n| `admin-error-boundary-offline` | **ngoại lai — flake đã biết (Δ35, cycle 14)** | `TypeError: fetch failed` / `connect ETIMEDOUT 127.0.0.1:53006` — ephemeral-port loopback, không phải regression |';
if (t.indexOf(A2) !== -1 && t.indexOf('admin-crypto-config-oidc') === -1) { t = t.replace(A2, B2); applied.push('rows'); }

// C) extend the mtime evidence with the new oidc write
const A3 = 'src/modules/operations/ingestion-consumer.ts  mtime=2026-09-26T10:03:05Z  (không chạm)';
const B3 = A3 + '\nsrc/app/admin/shell-router.ts    mtime=2026-09-27T22:21:23Z   <-- Admin/SEC lane (dịch so với lần đo đầu)\ntests/admin-crypto-config-oidc.test.ts mtime=2026-09-27T22:29:19Z  <-- ghi SAU runtime.ts của tôi';
if (t.indexOf(A3) !== -1 && t.indexOf('22:29:19Z') === -1) { t = t.replace(A3, B3); applied.push('mtime'); }

// D) sharpen the closing sentence of that section
const A4 = 'làm full suite đỏ và tôi **không** tự hấp thụ. Cần lane Admin/SEC xác nhận hoặc dọn.';
const B4 = 'làm full suite đỏ và tôi **không** tự hấp thụ. Cần lane Admin/SEC xác nhận hoặc dọn.\n\nBằng chứng mạnh nhất cho phần **nguyên nhân**: `admin-crypto-config-oidc.test.ts` có mtime\n`2026-09-27T22:29:19Z`, **sau** `runtime.ts` của tôi (`22:13:48Z`) — file test bị lane khác ghi vào\ngay lúc tôi đang chạy full suite. 5 suite đỏ đều thuộc vùng admin; 0 suite url-ingestion đỏ.';
if (t.indexOf(A4) !== -1) { t = t.replace(A4, B4); applied.push('closing'); }

// E) Delta 56 restated with the real count
const A5 = '- **Δ56 — 3 đỏ admin-shell trong full suite.** Nguyên nhân ngoài phạm vi tôi, nhưng chúng\n  làm full suite đỏ và tôi **không** tự hấp thụ. Cần lane Admin/SEC xác nhận hoặc dọn.';
const B5 = '- **Δ56 — 5 suite đỏ trong full orchestrator, tất cả ngoại lai.** Run đầu tôi thấy 3; run xác\n  nhận lại (cùng cây, sau khi lane khác ghi file) thấy **5**: thêm\n  `admin-crypto-config-oidc` (mới, W-ENC-08-CSRF-OIDC) và `admin-error-boundary-offline`\n  (flake ETIMEDOUT ephemeral-port, đã ghi nhận ở Δ35 cycle 14). Không suite url-ingestion nào\n  đỏ. Tôi **không** sửa và **không** hấp thụ; cần lane Admin/SEC dọn. Ghi rõ số 3 ở run đầu là\n  quan sát tại thời điểm đó, không phải con số cuối.';
if (t.indexOf(A5) !== -1) { t = t.replace(A5, B5); applied.push('delta56'); }

t = t.replace(/\n+$/, '\n');
fs.writeFileSync(F, t, 'utf8');
console.log('applied=' + JSON.stringify(applied));
console.log('endsWithSingleLF=' + (t.charCodeAt(t.length-1) === 10 && t.charCodeAt(t.length-2) !== 10));
let c = 0, l = 0;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) { if (i > 0 && t.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);
console.log('stale_3failed_gone=' + (t.indexOf('3 failed, 1 skipped, 86 passed, 90 total') === -1));