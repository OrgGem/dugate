# FIX observability — ghim NODE_ENV=test cho test process của package (2026-10-08)

> [!IMPORTANT]
> RESUME POINT — **XONG**: lượt này chỉ viết receipt (không sửa thêm file nào). RED có literal từ phiên (không re-run); GREEN đã chạy lại **2 lần bằng chính phiên này** (default + NODE_ENV=production, đều 44/44 exit 0); tsc exit 0, output rỗng. Không đỏ không liên quan.

- Lease (chỉ 2 file): `packages/observability/jest.config.cjs`, `packages/observability/tests/setup-node-env.cjs` (tạo mới). Không sửa `src/observability/*.ts`, không sửa `tests/observability.test.ts`, không đụng file khác ở services/orchestrator hay package khác.
- Không commit, không git add, không push, không tick gate. Không đọc/in nội dung `.env.live`. Offline, không claim DB window.
- Receipt này (file duy nhất được tạo lượt này): `du-rework/coordination/reports/fix-observability-node-env-2026-10-08.md`.

## (a) RED trước fix

- Lệnh: `cmd /v:on /c "set NODE_ENV=production& node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs"`
- cwd: `D:\Git\dugate\du-rework\orchestrator\packages\observability` (node v22.16.0)
- Exit Code: **1** · `Test Suites: 1 failed, 2 passed, 3 total` · `Tests: 1 failed, 43 passed, 44 total`
- Test đỏ: `structured logger › emits the required structured JSON schema with stable environment and correlation fields` (`tests/observability.test.ts:240`)
- Literal expected/received:
```
    - Expected  - 1
    + Received  + 1
    -   "environment": "test",
    +   "environment": "prod",
        > 240 |     expect(lines[0]).toMatchObject({
```
- RED này được **chạy và chép nguyên văn trong phiên này** (trước khi sửa); lượt viết receipt này **không re-run RED**, lấy lại từ log phiên — không diễn giải lại.
- Ghi chú quy trình: lần chạy RED đầu tiên của tôi dùng dạng `set "NODE_ENV=production"` lồng nháy và **không truyền được biến** (suite xanh 44/44 ⇒ false-green do quoting). Đổi sang dạng `set NODE_ENV=production&` mới tái hiện đúng đỏ. Ghi lại vì đây là bẫy của chính lệnh, không phải của code.

## (b) Fix đã làm

- Tạo mới `packages/observability/tests/setup-node-env.cjs`:
  - dòng 1-6: chú thích lý do (jest chỉ mặc định NODE_ENV=test khi biến **chưa có**; shell kế thừa được thì không ghi đè; `src/logger.ts:55` đọc `DU_ENVIRONMENT ?? APP_ENV ?? NODE_ENV`).
  - dòng 8: `process.env.NODE_ENV = 'test';` — ghim cứng, không phụ thuộc shell.
  - dòng 11-12: `delete process.env.DU_ENVIRONMENT;` `delete process.env.APP_ENV;` — hai biến này được logger ưu tiên **trước** NODE_ENV; để nguyên thì shell đặt chúng vẫn làm đỏ cùng loại. Không test nào trong package đọc 2 biến này (grep chỉ thấy ở `src/logger.ts:55` và `README.md:14`).
- Sửa `packages/observability/jest.config.cjs:7`: thêm `setupFiles: ['<rootDir>/tests/setup-node-env.cjs'],` (setupFiles chạy **trước** khi test framework và trước khi nạp module test ⇒ `Logger` dựng trong test đọc đúng `test`).

## (c) GREEN sau fix — 2 lần chạy lại trong lượt này (node v22.16.0)

Lần 1 — shell có NODE_ENV=production (điều kiện tái hiện RED):
```
cmd /v:on /c "set NODE_ENV=production& node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs"
cwd: D:\Git\dugate\du-rework\orchestrator\packages\observability
⇒ PASS · Test Suites: 3 passed, 3 total · Tests: 44 passed, 44 total · Exit Code: 0
```

Lần 2 — shell mặc định:
```
node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs
⇒ PASS · Test Suites: 3 passed, 3 total · Tests: 44 passed, 44 total · Exit Code: 0
```

## (d) Typecheck

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
cwd: D:\Git\dugate\du-rework\orchestrator\packages\observability
⇒ Output: (empty) — 0 byte output từ chính lệnh tsc · Exit Code: 0
```
(Công cụ chạy lệnh có in thêm vài dòng metadata Directory/Output/Exit; phần đó không phải output của tsc.)

## (e) File đã sửa / tạo

- `packages/observability/jest.config.cjs` — sửa (thêm 1 dòng setupFiles).
- `packages/observability/tests/setup-node-env.cjs` — tạo mới.
- `packages/observability/src/observability*/log-metadata.ts` — **không do lượt này sửa**; thay đổi `EVENT_FIELDS` (mục W-SEC-AUDIT-TAXONOMY-1) là của lane khác, đã được verify độc lập trước đó.
- `packages/observability/tests/observability.test.ts` — không sửa (không nới/bỏ/đổi assertion hay kỳ vọng nào).
- `packages/observability/src/logger.ts` — không sửa.
- Receipt: `coordination/reports/fix-observability-node-env-2026-10-08.md` (file này).

## (g) Giới hạn trung thực

- Fix chỉ ghim môi trường cho **test process của riêng package observability** (qua `setupFiles` của jest config package đó). Không bao phủ orchestration service hay package nào khác; suite khác tự phải tự ghim nếu muốn.
- Đây **không phải** fix product runtime: `src/observability/*.ts` không bị đụng; hành vi logger trong production (đọc `DU_ENVIRONMENT ?? APP_ENV ?? NODE_ENV`) giữ nguyên.
- Có chủ ý mạnh hơn yêu cầu tối thiểu: xóa 2 biến ưu tiên cao hơn trong test process, để suite không còn phụ thuộc bất kỳ biến môi trường nào của shell. Nếu reviewer muốn chỉ ghim `NODE_ENV` thì bỏ 2 dòng `delete` là đạt mức tối thiểu.

## (f) Test đỏ không liên quan

**Không có.** Cả 2 lần GREEN (mục c) đều 44/44, 3 suite cùng xanh; tsc sạch (mục d). Không gặp test đỏ nào khác để báo nguyên văn.