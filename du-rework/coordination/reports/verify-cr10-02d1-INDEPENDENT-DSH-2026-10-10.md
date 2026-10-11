# Verify độc lập (DSH) — CR10-02-D1 safe log message — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet CR10-02-D1 do lane Qwen implement.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (không revert, không mutation tạm); **KHÔNG** tick gate; artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/packages/observability` (suite/tsc/dist) và `orchestrator/services/connector` (e2e).
**Node:** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-cr10-02d1-2026-10-10/DSH/` (`obs-run1..3.log`, `obs-tsc.log`, `connector-cr10-02-e2e.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm

| File/artifact | Trạng thái | Ghi chú |
|---|---|---|
| `orchestrator/packages/observability/src/log-events.ts` | ` M`, 62 dòng, sha `0fb9443537d62b07` | nhãn mới tại **`:59`** |
| `orchestrator/packages/observability/tests/payload-privacy.test.ts` | ` M`, 80 dòng | 3 test mới tại `:52`, `:61`, `:73` |
| `orchestrator/packages/observability/dist/log-events.js` | gitignored, mtime `10-10 14:06` | sha256 **`bfb78f891f05c4613b800fdfb08b4e3164aabfdf48e66161b41fddad96b71e42`** |

Nguyên văn dòng nhãn trong source (`src/log-events.ts:59`): `usage dispatch cycle failed` (có dấu phẩy cuối dòng) — đúng 1 dòng literal, nằm trong `SAFE_LOG_MESSAGES` (Set<string>), không wildcard/prefix/regex.

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --testTimeout=20000` (observability, lần 1) | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 47 passed, 47 total` |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 47 passed, 47 total` |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 47 passed, 47 total` |
| 4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (observability) | **0** | không output · `error_lines=0` |
| 5 | grep `dist/log-events.js` cho nhãn (`-SimpleMatch`) | — | **1 hit** ✓ |
| 6 | `Get-FileHash dist/log-events.js` | — | `bfb78f891f05c461…b71e42` — **khớp chính xác hash SAU rebuild mà receipt §4.6 khai** |
| 7 | `node -e` chạy `require.resolve` cho `@du/observability` (cwd connector) | 0 | `…/packages/observability/dist/index.js` ⇒ connector dùng **dist**, không phải src |
| 8 | `node node_modules/jest/bin/jest.js --runInBand --testTimeout=20000 --runTestsByPath tests/cr10-02-usage-dispatcher-rejection.test.ts` (connector, e2e) | **0** | `Tests: 5 passed, 5 total` · **9 dòng log có nhãn `usage dispatch cycle failed`** · **0 dòng `[REDACTED]`** cho `subsystem=usage-dispatcher` |

⇒ Toàn bộ số liệu trùng khớp receipt §4.1-§4.7: 47/47 ×3, tsc 0, dist có nhãn + hash sau rebuild, connector resolve dist, và **dòng log e2e đã hết `[REDACTED]`** — đúng khe hở CR10-02 deviation 1 mà tôi đã nêu trước đó.

## 2. Kiểm test (bounds của việc mở allowlist)

3 test mới (nguyên văn tên, dùng `test(...)`):
- `:52` `CR10-02-D1: the usage dispatch cycle failure label is allowlisted verbatim` — positive control ở tầng projection: `SAFE_LOG_MESSAGES.has('usage dispatch cycle failed') === true` và `metadataLogRecord` giữ nhãn.
- `:61` `CR10-02-D1: the connector log line keeps its label end to end` — positive control qua `createLogger` theo đúng shape dòng log của `usage-dispatcher.ts:167`, assert `record.message === 'usage dispatch cycle failed'` và khác `[REDACTED]`.
- `:73` `CR10-02-D1: allowlisting is exact - near-miss and prefix messages stay redacted` — **negative control**: message gần đúng/prefix/case/whitespace vẫn bị redact ⇒ chứng minh khớp **chính xác**, không nới thành wildcard/prefix.

⇒ Việc mở allowlist là **+1 literal duy nhất**, và negative control trong cùng file pin đúng tính chính xác đó. Delta test-side (đổi `toEqual` → `toMatchObject` ở lần chạy đầu, receipt DELTA-1) là thay đổi **trong test**, không nới product; tôi đọc test và xác nhận assertion vẫn pin cả `message` lẫn việc không redact.

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite observability (47 test) | **PASS** — 3/3 lượt exit 0 |
| Typecheck observability | **PASS** — exit 0, 0 lỗi |
| Nhãn trong source + trong dist | **ĐẠT** — `src/log-events.ts:59`; `dist/log-events.js` 1 hit |
| dist đã rebuild | **ĐẠT** — hash `bfb78f89…b71e42` khớp hash sau rebuild của receipt; mtime 14:06 sau thời điểm sửa source |
| E2E connector (dòng log thật) | **ĐẠT** — 5/5 test, 9 dòng log giữ nhãn, 0 dòng `[REDACTED]`; resolve qua `dist/index.js` |
| Bounds của allowlist | **ĐẠT** — chỉ 1 literal; negative control near-miss vẫn redacted |

⇒ **CR10-02-D1: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline**; khe hở CR10-02 deviation 1 (message bị `[REDACTED]`) **đã đóng ở mức artifact cục bộ**. Không tick gate.

## 4. GAP / open items

1. **dist là artifact build cục bộ, bị gitignore** (receipt DELTA-4): môi trường build/deploy **phải chạy lại** `npm run build` của `@du/observability` thì nhãn mới tới runtime; chỉ có working tree là chưa đủ. Đây là điều kiện cutover, không phải lỗi code.
2. **Bản vendor không có nhãn** (receipt DELTA-3): `businesses/document-core/template/vendor/observability/src/log-events.ts` có `SAFE_LOG_MESSAGES` riêng, không chứa nhãn này. Nếu emitter nào dùng bản vendor đó thì log vẫn `[REDACTED]` — cần packet riêng (ngoài lease lượt này). Tôi **không** sửa.
3. **Chưa commit**: cả 2 file là ` M` ⇒ kết quả gắn với working tree + hash dist ở §1; `dist` thay đổi sẽ làm bằng chứng hết hiệu lực.
4. **Phạm vi mở allowlist là tối thiểu**: chỉ chuỗi literal này được miễn redact; không mở đường cho dữ liệu tuỳ ý. Nếu sau này cần thêm nhãn khác phải lặp lại đúng quy trình (label + positive/negative control + rebuild dist).
5. **E2E vẫn là offline**: chạy logger + dispatcher thật qua loopback/synthetic double, **không** có DB/Redis/S3/IdP thật; tôi không claim bằng chứng deployment.

## 5. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test (kể cả không revert để lấy RED — bằng chứng RED vẫn thuộc receipt gốc §4.2).
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
