# Verifier độc lập số 3 — Node 24 upload red

**Kết luận: FAIL-FOUND theo Node 24.21.0.** Hai lần Node 24 liên tiếp đều đỏ ở cùng một assertion của suite public-upload. Cùng suite xanh trên PATH Node 22.16.0. Tôi không sửa source/test/config, không commit/push, không tick gate. Không chạy PostgreSQL/Redis và không claim DB window.

CWD các lệnh Jest/typecheck: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`. Raw logs: `du-rework/coordination/reports/raw/verify-node24-red-2026-10-09/CODEX2/`.

Node 24 đúng đường dẫn được cung cấp: `$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe`, resolve thành `C:\Users\Gem\AppData\Local\Temp/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe`. `Test-Path=True`; `node -v` trả `v24.21.0`, exit 0. PATH Node là `C:\nvm4w\nodejs\node.exe`, `node -v = v22.16.0`, exit 0.

## Lệnh và kết quả

| Run | Runtime trước khi chạy | Lệnh | REAL_EXIT | Literal |
|---|---|---|---:|---|
| 1A | Node 24.21.0; executable path ở trên; `node -v` exit 0 | `& $env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | 1 | `Test Suites: 1 failed, 1 total`; `Tests:       1 failed, 11 passed, 12 total` |
| 1B (lần lặp, process riêng) | Node 24.21.0; executable path ở trên; `node -v` exit 0 | Cùng lệnh 1A | 1 | `Test Suites: 1 failed, 1 total`; `Tests:       1 failed, 11 passed, 12 total` |
| 2 | PATH `C:\nvm4w\nodejs\node.exe`, Node 22.16.0; `node -v` exit 0 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | 0 | `Tests:       12 passed, 12 total` |
| 3 | Node 24.21.0; executable path ở trên; `node -v` exit 0 | `& $env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-bff-offline.test.ts tests/tenant-list-cursor-codec-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/usage-contracts-integration-offline.test.ts tests/usage-summary.test.ts tests/usage-aggregation.test.ts` | 0 | `Test Suites: 5 passed, 5 total`; `Tests:       32 passed, 32 total` |
| 4 | Node 24.21.0; executable path ở trên; `node -v` exit 0 | `& $env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/bff-connectors-actions.test.ts tests/admin-connector-view-model.test.ts tests/admin-connector-render.test.ts` | 0 | `Test Suites: 3 passed, 3 total`; `Tests:       124 passed, 124 total` |
| 5 | Node 24.21.0; executable path ở trên; `node -v` exit 0 | `& $env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | `TSC_ERROR_LINES=0`; `TSC_OUTPUT_LINES=0` |

Run 1A và 1B không giống hoàn toàn: cùng một test đỏ và cùng expected value, nhưng số `Received` thay đổi giữa hai process.

### Đối chiếu với lane trước

Receipt `verify-node-version-INDEPENDENT-OC-2026-10-09.md:3,29-31,98` ghi Node 24.21.0 không khả dụng, hai lần Jest **NOT RUN** (exit N/A), và không có red trong những process đã chạy. Kết quả độc lập hiện tại khác ở phần đó: executable được chỉ định tồn tại, `node -v` là `v24.21.0`, và hai lần Jest thực chạy đều exit 1 với `1 failed, 11 passed, 12 total`; `Received` lần lượt là `219856896` và `218427392`. Tôi ghi nhận hai kết quả song song, không hòa giải chúng.

Phần PATH Node khớp: receipt trước ghi Node 22.16.0, `12 passed, 12 total`; lần này cũng Node 22.16.0, exit 0, `12 passed, 12 total`.

## RED nguyên văn

Cả hai lần đều đỏ tại:

`FAIL tests/public-upload-encryption-gateway.test.ts`

`public upload encryption gateway › streams chunked encryption with downstream backpressure and keeps the object size exact`

Run 1A:

```
Expected: < 171966464
Received:   219856896
```

Run 1B:

```
Expected: < 171966464
Received:   218427392
```

Assertion hiện tại ở `tests/public-upload-encryption-gateway.test.ts:709`: `expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024)`. Hai raw Jest logs giữ toàn bộ stack và literal output: `10-pub-upload-v24-run1.log`, `11-pub-upload-v24-run2.log`. Đây là red của Node 24 trong lần xác minh này; suite xanh 12/12 trên Node 22. Không suy diễn nguyên nhân từ chênh lệch này.

## Các suite được loại/không chạy

- `tests/usage-summary.test.ts` được truyền vào lệnh 3 nhưng unit config loại bằng `jest.unit.config.cjs:21` (`usage-summary\\.test\\.ts$`). Kết quả 5/5 là 5 suite được thu thập; suite usage-summary **không được tính là pass**.
- `tests/migrations.test.ts` bị loại bởi `jest.unit.config.cjs:18`; không chạy và không tính là pass.
- `tests/f3-tenant-list-live-db.test.ts` và `tests/f3-tenants-route-live.test.ts` không nằm trong các lệnh chỉ định; không chạy vì cần DB. Không mở DB window và không claim live verification.

## Thay đổi đã tồn tại trước khi bắt đầu

Trước lần chạy đầu tiên, `git status --porcelain` đã có 134 dòng; bản đầy đủ nằm ở `01-status-before.txt`. Status sau lệnh 5 không có dòng khác so với snapshot trước khi chạy. Các path code/test liên quan được ghi nguyên văn trong snapshot; đặc biệt:

```
 M du-rework/orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts
 M du-rework/orchestrator/services/orchestrator/tests/rv01-loopback-http-offline.test.ts
?? du-rework/coordination/reports/fix-public-upload-encryption-gateway-red-2026-10-08.md
```

Ngoài ba dòng ở trên, đây là nguyên văn các status line source/test/config khác thuộc `du-rework/orchestrator/` đã tồn tại trước run:

```
 M du-rework/orchestrator/apps/admin-web/src/app-shell/app-shell.tsx
 M du-rework/orchestrator/apps/admin-web/src/features/api-docs/api-docs-screen.tsx
 M du-rework/orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx
 M du-rework/orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx
 M du-rework/orchestrator/apps/admin-web/src/features/usage/usage-screen.tsx
 M du-rework/orchestrator/apps/admin-web/src/lib/api/client.ts
 M du-rework/orchestrator/packages/observability/jest.config.cjs
 M du-rework/orchestrator/packages/observability/src/log-metadata.ts
 M du-rework/orchestrator/services/orchestrator/jest.config.cjs
 M du-rework/orchestrator/services/orchestrator/src/app/admin/bff/handle.ts
 M du-rework/orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts
 M du-rework/orchestrator/services/orchestrator/src/db/migrations.ts
 M du-rework/orchestrator/services/orchestrator/src/modules/runtime/runtime.ts
 M du-rework/orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts
 M du-rework/orchestrator/services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts
?? du-rework/orchestrator/apps/admin-web/src/components/ui/toast.tsx
?? du-rework/orchestrator/packages/observability/tests/setup-node-env.cjs
?? du-rework/orchestrator/services/orchestrator/src/app/admin/bff/health.ts
?? du-rework/orchestrator/services/orchestrator/tests/admin-bff-health-offline.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/admin-toast-error-boundary-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/api-docs-build-label-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/f3-tenant-list-live-db.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/f4-component-tenant-select.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/fix-section8-legacy-cursor-offline.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/med1-migration-ledger-object-drift.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/med1-verify-migrations-object-drift.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/operations-download-live-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/operations-timeline-filters-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/portal-auto-refresh-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/setup-node-env.cjs
```

Diff có sẵn của `public-upload-encryption-gateway.test.ts` thêm fake DB state/matcher cho `UPDATE artifacts SET operation_id=$2` (diff ở `19-preexisting-public-upload-test-diff.txt`). Assertion RSS tại line 709 không nằm trong diff và cũng xuất hiện trong HEAD. File test đã ở trạng thái modified **trước** khi tôi chạy; tôi không sửa nó. `rv01-loopback-http-offline.test.ts` cũng đã modified trước run và không bị chạy trong các lệnh được yêu cầu.

Các source/test paths khác đã dirty từ trước được liệt kê nguyên văn trong `01-status-before.txt`; không có status delta trong khoảng pre-run tới post-run. Không xác định tác giả của các thay đổi đó.

## Revision và raw evidence

- Trước và sau: `git log -1 --format=%H` → `72e225ae5465e5a648c34bf31fbabbd182763233`, exit 0.
- `git status --porcelain` trước/sau exit 0; baseline 134 dòng; không có dòng status delta trong run.
- Typecheck Node 24: exit 0, zero error/output lines.
- Không gate tick, không source/test/config edit, không commit/add/push.

Raw run manifest: `18-run-results-manifest.txt`; raw directory: `du-rework/coordination/reports/raw/verify-node24-red-2026-10-09/CODEX2/`.
