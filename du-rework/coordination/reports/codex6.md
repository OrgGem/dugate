# Codex-6 Receipt — SEC-00 / VAULT-05, Reviewer Finding 1 (Cycle 126+)

**Thời điểm:** 2026-09-25 05:30 UTC  
**Workspace:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; working tree có thay đổi, không commit/push.  
**Môi trường:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`. Không mở kết nối PostgreSQL `:5433` hoặc Redis `:6380`.

## Đã code

- Bổ sung `006_connector_revision_lifecycle` và `007_connector_credential_source` vào danh sách tuần tự trong `PgSqlClient.migrate()`. DB sạch sẽ áp dụng migration 001–007 khi khởi động.
- Migration 007 backfill các revision cũ thành JSONB tường minh `{ "kind": "legacy-db", "credentialRef": ... }`, sau đó đặt `credential_source NOT NULL`. Revision mới không truyền source từ endpoint legacy được ghi thành `legacy-db` rõ ràng. Source thiếu/hỏng khi đọc bị từ chối; không tự suy đoán fallback sang DB.
- Thêm typed source cho `legacy-db` và `vault-kv2`; Vault source yêu cầu account, mount, path, key và version đã pin. Resolver giữ đường AES-GCM cho `legacy-db`, đọc đúng ref/version cho Vault, giới hạn retry và không fallback sang DB khi Vault lỗi. Credential đi vào provider slot đã cấu hình.
- Orchestrator credential workflow phát hành source `vault-kv2`; HTTP adapter kiểm tra source trả về từ Connector. Connector management test thực hiện probe credential.
- Thêm `typecheck` và `test:unit` cho Connector. Unit config loại hai suite cần DB/Redis (`black-box-durable`, `durable-integration`) và bỏ qua bài DB projection lồng trong P8-03.

## Receipt kiểm thử

Các lệnh chạy từ `D:\Git\dugate\du-rework`; log thô nằm cạnh receipt này.

| Lệnh | Kết quả | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-contract-build.log](codex6-contract-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-typecheck.log](codex6-typecheck.log) |
| `pnpm --filter @du/orchestrator lint` (TypeScript `--noEmit`) | PASS, exit 0 | [codex6-orchestrator-typecheck.log](codex6-orchestrator-typecheck.log) |
| `pnpm --filter @du/connector test:unit` | PASS, exit 0; 14 suite pass, 163 test pass, 1 skipped, 0 failed | [codex6-test-unit.log](codex6-test-unit.log) |

Test skip là bài `live usage_events projection...` của P8-03, vốn tạo PgSqlClient và mặc định trỏ `:5433`. Hai suite integration có thể kết nối DB/Redis bị loại khỏi target unit. Các unit khác trong P8-03 vẫn chạy. Typecheck/build không mở dịch vụ ngoài tiến trình.

**Digest nguồn:**

- `services/connector/src/db/pg-client.ts`: `9CB9C0467C39339BCB009C0B8FC7EBAA6C72EE347A4F3DF4C3619A72FFA7E94C`
- `services/connector/src/db/migrations/007_connector_credential_source.sql`: `748060A06B360E76449D95C9ED82ACBB04DEEECF0942DC74678BFBE37F33C7A2`
- `services/connector/src/vault/resolver.ts`: `F11E7FC46246D44A5AF7C9B10479719C46E92CEC77D3FF00E6BE1B86C4B128E2`

## Trạng thái spec / code / receipt

- **Đã code:** runner 006/007, explicit `credential_source`, resolver cho legacy/Vault và wire source Orchestrator ↔ Connector.
- **Đã verify:** contract build, Connector/Orchestrator typecheck và offline Connector unit tests như bảng trên.
- **Đã accept:** chưa. Không tick task row; receipt offline không đóng gate tích hợp/live.

**MISMATCH / gate cần owner xử lý trước acceptance:**

1. Task spec mô tả discriminator `vault-kv-v2`, còn yêu cầu triển khai của packet này chỉ rõ `vault-kv2`. Code ghi mới dạng `vault-kv2`, đồng thời nhận alias `vault-kv-v2` và canonicalize khi đọc để tương thích snapshot cũ. Product/contracts owner cần xác nhận tên wire canonical và cập nhật spec/contract tương ứng.
2. SEC-00 yêu cầu ADR được duyệt về provider key hay tenant `x-api-key`, shared hay tenant-owned connector account, account binding, credential slot, Vault prefix/version/revoke và OIDC boundary trước acceptance. `docs/15-decisions.md` hiện chưa có các quyết định SEC-00 đó; validator kiểm tra hình dạng `account` nhưng chưa thể xác thực tenant/account binding theo một quyết định chưa chốt.
3. Chưa có receipt tích hợp với Vault thật hoặc revision ACTIVE do Orchestrator VAULT-03 tạo. VAULT-05 integration và SEC-00 acceptance vẫn mở; next owner là Product + platform + security cho ADR, rồi Connector/Orchestrator cho integrated closeout.

Task rows không bị chỉnh sửa.

---

## SEC-00 ADR update — 2026-09-25

- **Hồ sơ:** thêm [ADR-17 SEC-00](../../docs/15-decisions.md) vào decision log. ADR chốt `vault-kv2` làm wire kind ghi mới, nhận alias đọc `vault-kv-v2`, source legacy tường minh; provider account thuộc đúng một tenant; OIDC role/session và Vault writer/reader là trust domain riêng.
- **Rotation/revoke:** KV v2 CAS (`cas=0` lần đầu, version hiện tại khi rotate), revision PENDING ghim version, CAS activation PENDING→ACTIVE và retire revision cũ trong cùng transaction. Revoke đặt tombstone/retire trước ack, budget 2 giây, kiểm tra lại trước provider dispatch; lỗi hoặc trạng thái không rõ fail-closed. Rollback tạo revision mới chỉ khi version cũ chưa bị revoke/destroy.
- **Kiểm tra:** Markdown local-link check offline trên 2 file (`docs/15-decisions.md` và receipt này) — 9 local targets, 0 broken, exit 0. Raw output: [codex6-doc-link-check.log](codex6-doc-link-check.log). Cwd `D:\Git\dugate\du-rework`; không chạy typecheck vì thay đổi chỉ là tài liệu.
- **Ranh giới:** chỉ sửa `docs/15-decisions.md` và receipt này; không sửa code sản phẩm/task rows, không mở DB/Redis, không commit/push.
- **Acceptance:** ADR-17 chốt hướng kiến trúc, nhưng SEC-00/G-SEC chưa được đóng. Task spec vẫn mô tả `vault-kv-v2` là kind chuẩn; cần đồng bộ tài liệu contract/task sau quyết định. Code hiện tại cũng chưa enforce tenant/account prefix, trusted account binding, OIDC production fallback policy, và revoke propagation budget đã nêu trong ADR. Các mục này là implementation/integration gate còn mở; không tick task row.

---

## Cycle 138 — SEC-00 contract/task-spec alignment — 2026-09-25

- **Hồ sơ:** đồng bộ [`SEC-OIDC-VAULT-2026-09-24.md`](../../tasks/SEC-OIDC-VAULT-2026-09-24.md) theo ADR-17. `vault-kv2` là discriminator canonical cho mọi write; reader chấp nhận `vault-kv-v2` như alias tương thích và chuẩn hóa về canonical. Thêm `account` vào `VaultKv2Ref` và yêu cầu owner sign-off/contract freeze trước secure enable. Mục MISMATCH trong receipt SEC-00 ở trên ghi nhận trạng thái lịch sử trước cập nhật này.
- **Account-prefix enforcement:** revision mang trusted `(tenant_id, connector_id, account_id)`; `ref.account` phải trùng account binding và path phải khớp chính xác `du/tenants/{tenant_id}/connectors/{connector_id}/accounts/{account_id}`. Connector kiểm tra grant/revision/ref trước mọi Vault request; tenant, connector, account hoặc path mismatch phải có Vault read count 0 và provider call count 0. VAULT-02 yêu cầu Vault identity/policy giới hạn tenant/account prefix; wildcard tenant prefix chỉ chấp nhận nếu Vault identity templating/token binding thu hẹp mỗi token theo tenant/account được cấp.
- **Kiểm tra:** Markdown local-link check offline, chạy từ `D:\Git\dugate`; quét ADR-17, task spec và receipt. 3 file, 14 local targets, 0 broken, exit 0. Raw output: [codex6-cycle138-doc-link-check.log](codex6-cycle138-doc-link-check.log). Không chạy typecheck vì chỉ thay tài liệu.
- **Trạng thái:** spec/ADR thống nhất; implementation/account-prefix enforcement và negative-test evidence chưa được xác minh trong nhiệm vụ tài liệu này. SEC-00 và G-SEC vẫn mở. Không tick task row; không mở DB/Redis, không sửa code sản phẩm, không commit/push.

---

## Cycle 139 — VAULT-01 / ADR-17 account-prefix isolation — 2026-09-25

**Task/test ID:** VAULT-01, tenant/account prefix isolation.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`; Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`.  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; no commit/push.  
**Safety boundary:** không kết nối PostgreSQL `:5433`, Redis `:6380` hoặc Vault thật. Test dùng repository, Vault reader và provider transport giả lập trong bộ nhớ; không tick task row.

### Implementation

- Thêm `matchesVaultAccountPath` trong `packages/contracts/src/vault.ts`. Ref phải có đúng 7 segment `du/tenants/{tenant_id}/connectors/{connector_id}/accounts/{account_id}`; so khớp tenant từ invocation grant đã verify, connector từ revision được grant chỉ định, và account segment với `credential_source.account`. So sánh segment chính xác nên sibling prefix, path lồng nhau, segment sai hoặc path thừa đều bị từ chối.
- Trong `DurableConnectorRuntime.invoke`, xác minh binding `connectorId:revision`, lấy đúng revision ACTIVE rồi kiểm tra tenant/connector/account path trước `SecretResolver.resolve`. Khi mismatch, trả `BINDING_DENIED`; nhánh này không gọi Vault reader và không đi tới adapter/provider transport.
- Thêm kiểm tra cấu trúc connector/account trước khi ghi revision/config và trước khi Orchestrator gọi Vault writer. Orchestrator writer hiện nhận connector/account nhưng không nhận trusted tenant ID; tenant equality được enforce ở Connector invoke boundary theo tenant trong signed grant.
- Thêm `services/connector/tests/vault-account-isolation.test.ts`: sáu trường hợp mismatch (tenant, connector, account path, ref-account, sibling prefix, nested path) kiểm tra đồng thời Vault read count = 0 và provider call count = 0; trường hợp hợp lệ kiểm tra đọc đúng ref và dispatch một lần. Fixture không dùng DB/Vault thật.

### Offline verification

Tất cả lệnh chạy từ `D:\Git\dugate\du-rework`; raw output:

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-cycle139-connector-typecheck.log](codex6-cycle139-connector-typecheck.log) |
| `pnpm --filter @du/connector test -- tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts` | PASS, 2 suites / 28 tests, exit 0 | [codex6-cycle139-vault01-unit.log](codex6-cycle139-vault01-unit.log) |
| `pnpm --filter @du/orchestrator test -- tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/connector-revision-http-offline.functional.test.ts` | PASS, 3 suites / 47 tests, exit 0 | [codex6-cycle139-orchestrator-tests.log](codex6-cycle139-orchestrator-tests.log) |
| `pnpm --filter @du/connector test:unit` | FAIL, exit 1; 14 suites / 172 tests passed, 1 skipped, 2 suites / 3 tests failed | [codex6-cycle139-connector-test-unit.log](codex6-cycle139-connector-test-unit.log) |
| `pnpm --filter @du/orchestrator lint` (`tsc --noEmit`) | FAIL, exit 2; two type errors in `src/modules/artifacts/s3-storage-facade.ts:726,749`, outside Cycle 139 implementation | [codex6-cycle139-orchestrator-typecheck.log](codex6-cycle139-orchestrator-typecheck.log) |

Full Connector unit run failures are confined in the captured output to loopback HTTP tests: two shutdown tests in `security-lifecycle.test.ts` hit `EADDRINUSE` on `127.0.0.1` and time out; `runtime-foundations.test.ts` hits `ETIMEDOUT` on `127.0.0.1`. The targeted VAULT-01 and secret-resolver suites pass separately. The cause of the loopback failures was not established; do not count the aggregate suite as green.

### Spec / code / receipt status

- **SPECIFIED:** ADR-17 and the Cycle 138 task spec require the canonical tenant/connector/account path.
- **IMPLEMENTED:** exact path binding is checked against grant tenant, granted revision connector, and persisted ref account before a Vault read; mismatch rejects before provider dispatch.
- **VERIFIED:** targeted Connector unit tests and Orchestrator offline regression tests pass as listed. Connector typecheck passes. Aggregate Connector unit run and Orchestrator typecheck remain red for the failures listed above.
- **ACCEPTED:** no. Offline unit evidence does not close live Vault/policy or deployment gates; task row remains untouched.

Không mở DB/Vault thật; không commit/push; không thay đổi task rows.

---

## Cycle 140 — W-VAULT04-FIX1 / VAULT-04 Orchestrator harness drift — 2026-09-25

**Packet/task:** W-VAULT04-FIX1, VAULT-04.  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; receipt lúc `2026-09-25 16:20 UTC`.  
**CWD targeted/regression:** `D:\Git\dugate\du-rework`; **CWD aggregate:** `D:\Git\dugate\du-rework\services\orchestrator`.  
**Boundary:** chỉ sửa Orchestrator tests/harness và receipt; không sửa `services/connector/src/**` hay `packages/contracts/**`. Không kết nối PostgreSQL `:5433`, Redis `:6380`, S3 thật hoặc Vault thật; `DU_LIVE_INFRA` không bật.

### Đã sửa

- Trong [`mock-vault-harness-offline.functional.test.ts`](../../services/orchestrator/tests/mock-vault-harness-offline.functional.test.ts), seed ACTIVE legacy revision giờ khai báo `credentialSource: { kind: 'legacy-db', credentialRef: 'legacy-openai-main' }` theo contract hiện hành. Vault fixture dùng path canonical `du/tenants/tenant-openai/connectors/openai/accounts/du-conn-openai-main`; mock policy scoped theo prefix tenant đó. Case deny dùng tenant khác nhưng vẫn canonical để xác nhận Vault mock trả policy 403 trên wire.
- Đồng bộ hai revision fixture trong [`connector-revision-http-offline.functional.test.ts`](../../services/orchestrator/tests/connector-revision-http-offline.functional.test.ts) với binding migration 008: legacy seed là unbound `tenantId: ''`; Vault PENDING fixture lấy `tenantId` và `accountId` từ canonical pinned source. Chỉ là test fake, không thay source Connector.
- Để aggregate offline ổn định, test/harness loopback Orchestrator dùng quiet-band ports và non-pooled HTTP; webhook listener nhận preferred quiet port. CSRF negative fixture đổi ký tự cuối thành giá trị chắc chắn khác token gốc. Các chỉnh sửa đều trong tests/harness, không đổi production source.

### Verification

Raw logs nằm trong `coordination/reports/`:

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/orchestrator test -- tests/mock-vault-harness-offline.functional.test.ts` | PASS, 1 suite / 12 tests, exit 0 | [targeted.log](codex6-W-VAULT04-FIX1-targeted.log) |
| Regression subset: 8 affected Orchestrator suites | PASS, 8 suites / 189 tests, exit 0 | [regression-final.log](codex6-W-VAULT04-FIX1-regression-final.log) |
| `npx jest --runInBand --config jest.unit.config.cjs` (run 1) | PASS, 55 suites; 1286 tests passed, exit 0 | [aggregate-1.log](codex6-W-VAULT04-FIX1-aggregate-1.log) |
| Same aggregate command (run 2, consecutive) | PASS, 55 suites; 1286 tests passed, exit 0 | [aggregate-2.log](codex6-W-VAULT04-FIX1-aggregate-2.log) |
| Same aggregate command (run 3, consecutive) | PASS, 55 suites; 1286 tests passed, exit 0 | [aggregate-3.log](codex6-W-VAULT04-FIX1-aggregate-3.log) |

Mỗi aggregate run ghi `1 skipped` suite và `15 skipped` tests; các skip đều thuộc live-gate dùng `DU_LIVE_INFRA`, gate không được bật. Không có DB/Redis/S3/Vault thật nào được gọi. Các log chẩn đoán lỗi loopback ban đầu cũng được giữ nguyên, nhưng ba run acceptance cuối liên tiếp đều exit 0.

**SPECIFIED:** packet VAULT-04 và contract hiện hành yêu cầu `RevisionRow.credentialSource`; binding tenant/account ở migration 008 giải thích các fixture cần phản chiếu trường tenant/account khi tạo Vault revision.  
**IMPLEMENTED:** test fixtures đồng bộ với discriminator nguồn và binding hiện hành; aggregate offline chạy ba lần liên tiếp xanh.  
**VERIFIED:** 12/12 test đích, regression subset 189/189, aggregate 3/3 exit 0.  
**ACCEPTED:** chưa tick task row; live Vault/S3/DB gates không thuộc packet offline này.

**Ledger 140 — VAULT-04 / W-VAULT04-FIX1:** sửa missing `credentialSource` và fixture binding trong Orchestrator tests; 3 aggregate offline liên tiếp exit 0; chỉ tests/harness/report changed; không DB/Redis/S3/Vault thật, không commit/push.
## W-VAULT01-ORCH-BIND-1 — 2026-09-26

**Workspace/CWD:** `D:\\Git\\dugate\\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; working tree has existing changes; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live PostgreSQL/Redis/Vault.

### Implementation

- Updated `services/orchestrator/src/modules/connector-credentials/connector-http-store.ts` to validate Vault sources with `matchesVaultAccountPath` before creating a PENDING revision.
- The revision POST now sends `credentialSource` together with independent `tenantId` and `accountId` fields required by Migration 008. Invalid or non-canonical bindings fail closed.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-contract-build.log](codex6-contract-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-connector-typecheck.log](codex6-connector-typecheck.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-orchestrator-lint.log](codex6-orchestrator-lint.log) |
| `pnpm --filter @du/orchestrator test -- tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts` | PASS, 2 suites / 39 tests, exit 0 | [codex6-orchestrator-offline-tests.log](codex6-orchestrator-offline-tests.log) |

The test command emitted PowerShell's routine `NativeCommandError` wrapper for Jest's stderr `PASS` line; Jest completed successfully with 2/2 suites and 39/39 tests passing. No live infrastructure was used. Task rows were not changed; no commit or push was made.

## W-VAULT01-TRUST-ORIGIN-1 — 2026-09-26

**Task:** Resolve Reviewer Turn 20 finding T20-V1 at the authenticated trust boundary.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live PostgreSQL/Redis/Vault.

### Implementation

- `workflow.ts` now requires the active revision's Migration 008 trusted `tenantId`/`accountId` binding before a Vault write, validates the candidate against that binding, and constructs the canonical Vault path from stored ownership before `writeCas`.
- `dispatcher.ts` resolves connector ownership before rotation, fences tenant-scoped principals against the stored tenant, and supplies the stored account ID instead of accepting `params.account` as a trust anchor.
- Revision wire rows retain `tenantId`/`accountId`; offline stores carry those fields across new revisions.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-VAULT01-TRUST-ORIGIN-contracts-build.log](codex6-W-VAULT01-TRUST-ORIGIN-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-VAULT01-TRUST-ORIGIN-connector-typecheck.log](codex6-W-VAULT01-TRUST-ORIGIN-connector-typecheck.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-W-VAULT01-TRUST-ORIGIN-orchestrator-lint.log](codex6-W-VAULT01-TRUST-ORIGIN-orchestrator-lint.log) |
| `pnpm --filter @du/orchestrator test -- tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts` | PASS, 2 suites / 39 tests, exit 0 | [codex6-W-VAULT01-TRUST-ORIGIN-offline-tests.log](codex6-W-VAULT01-TRUST-ORIGIN-offline-tests.log) |

The test command has the routine PowerShell stderr wrapper around Jest's `PASS` line; Jest itself completed 39/39 tests successfully. No task row was marked accepted. No commit or push was made.

## W-VAULT02-POL-1 — 2026-09-26

**Task:** VAULT-02 machine identities and policy boundaries.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live DB/Redis/Vault.

### Implementation

- Added `services/connector/tests/vault-machine-policies-offline.test.ts` covering writer CAS/metadata-only access, reader read-only access, worker/browser identity denial, foreign tenant/account and sibling-prefix denial, traversal denial, zero Vault-read/provider-call behavior, and expired/revoked token handling.
- Hardened `packages/contracts/src/vault-policies.ts` to reject `.` and `..` traversal segments before prefix capability evaluation.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-VAULT02-POL-contracts-build.log](codex6-W-VAULT02-POL-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-VAULT02-POL-connector-typecheck.log](codex6-W-VAULT02-POL-connector-typecheck.log) |
| `pnpm --filter @du/connector test -- tests/vault-machine-policies-offline.test.ts tests/token-renewal.test.ts tests/vault-account-isolation.test.ts` | PASS, 3 suites / 28 tests, exit 0 | [codex6-W-VAULT02-POL-tests.log](codex6-W-VAULT02-POL-tests.log) |

The Jest command emitted the routine PowerShell stderr wrapper around a `PASS` line; Jest completed 28/28 tests successfully. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-VAULT06-LIFECYCLE-1 — 2026-09-26

**Task:** VAULT-06 lifecycle, rotation, rollback and no-drift verification.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live DB/Redis/Vault.

### Verification coverage

- Orchestrator offline suites cover CAS rotation through PENDING → ACTIVE → RETIRED, pinned versions for in-flight submissions, emergency revoke fail-closed, legacy-to-Vault migration without DB fallback, and PENDING reconciliation.
- Connector lifecycle/security suites cover rotation lifecycle, machine-policy separation, account isolation, and token failure boundaries.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-VAULT06-LIFECYCLE-contracts-build.log](codex6-W-VAULT06-LIFECYCLE-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-VAULT06-LIFECYCLE-connector-typecheck.log](codex6-W-VAULT06-LIFECYCLE-connector-typecheck.log) |
| `pnpm --filter @du/orchestrator test -- tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts` | PASS, 2 suites / 39 tests, exit 0 | [codex6-W-VAULT06-LIFECYCLE-orchestrator-tests.log](codex6-W-VAULT06-LIFECYCLE-orchestrator-tests.log) |
| `pnpm --filter @du/connector test -- tests/security-lifecycle.test.ts tests/vault-machine-policies-offline.test.ts tests/vault-account-isolation.test.ts` | PASS, 3 suites / 25 tests, exit 0 | [codex6-W-VAULT06-LIFECYCLE-connector-tests.log](codex6-W-VAULT06-LIFECYCLE-connector-tests.log) |

Jest emitted the routine PowerShell stderr wrapper around a `PASS` line; all requested commands completed successfully. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-VAULT05-INTEG-1 — 2026-09-26

**Task:** VAULT-05 Connector `SecretResolver` and mock-provider reconciliation integration.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, quiet-band loopback harnesses, no live DB window.

### Verification coverage

- Full invocation grant and connector revision/account binding checks.
- Canonical Vault KV v2 path matching and pinned secret resolution.
- Mock-provider outage/retry and reconciliation behavior.
- Zero-call negative guards for foreign/traversal bindings and provider dispatch.
- Machine-policy separation and resolver failure handling.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-VAULT05-INTEG-contracts-build.log](codex6-W-VAULT05-INTEG-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-VAULT05-INTEG-connector-typecheck.log](codex6-W-VAULT05-INTEG-connector-typecheck.log) |
| `pnpm --filter @du/connector test -- tests/r1-d-03-mock-provider-reconciliation.functional.test.ts tests/secret-resolver.test.ts tests/vault-account-isolation.test.ts tests/vault-machine-policies-offline.test.ts` | PASS, 4 suites / 49 tests, exit 0 | [codex6-W-VAULT05-INTEG-connector-tests.log](codex6-W-VAULT05-INTEG-connector-tests.log) |

Jest emitted the routine PowerShell stderr wrapper around a `PASS` line; all 49 tests completed successfully. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-VAULT04-CONF-1 — 2026-09-26

**Task:** VAULT-04 provider-key write-only configuration, masked state, and security sweep.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live DB window.

### Verification coverage

- Admin provider-key rotation remains write-only; responses, metadata and audit projections are masked and contain no plaintext.
- Connector account isolation, machine-policy separation, token renewal failures and SecretResolver behavior pass together with the Orchestrator VAULT-04 workflow suites.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-VAULT04-CONF-contracts-build.log](codex6-W-VAULT04-CONF-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-VAULT04-CONF-connector-typecheck.log](codex6-W-VAULT04-CONF-connector-typecheck.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-W-VAULT04-CONF-orchestrator-lint.log](codex6-W-VAULT04-CONF-orchestrator-lint.log) |
| `pnpm --filter @du/connector test -- tests/vault-account-isolation.test.ts tests/vault-machine-policies-offline.test.ts tests/token-renewal.test.ts tests/secret-resolver.test.ts` | PASS, 4 suites / 49 tests, exit 0 | [codex6-W-VAULT04-CONF-connector-tests.log](codex6-W-VAULT04-CONF-connector-tests.log) |
| `pnpm --filter @du/orchestrator test -- tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts` | PASS, 2 suites / 39 tests, exit 0 | [codex6-W-VAULT04-CONF-orchestrator-tests.log](codex6-W-VAULT04-CONF-orchestrator-tests.log) |

Jest emitted the routine PowerShell stderr wrapper around `PASS` lines; all 88 requested tests completed successfully. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-SEC-SINK-1 — 2026-09-26

**Task:** Closeout Packet D — Security Observability & Sentinel Sink Scan.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live DB window.

### Implementation / audit finding

- Removed the raw `String(err)` coercion from `services/orchestrator/src/modules/queue/dispatcher.ts`. Duplicate BullMQ job detection now uses a bounded typed/name/message classifier for control flow only; the error text is never persisted, logged, returned, or added to audit data.
- Existing error-boundary, structured-redaction, provider-key, Vault-token, path, and audit masking tests were rerun as the security sweep.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-SEC-SINK-contracts-build.log](codex6-W-SEC-SINK-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-SEC-SINK-connector-typecheck.log](codex6-W-SEC-SINK-connector-typecheck.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-W-SEC-SINK-orchestrator-lint.log](codex6-W-SEC-SINK-orchestrator-lint.log) |
| `pnpm --filter @du/orchestrator test -- tests/mm05-queue-integrity-offline.functional.test.ts tests/adm-base-03-safe-error-offline.functional.test.ts tests/admin-error-boundary-offline.test.ts` | PASS, 3 suites / 43 tests, exit 0 | [codex6-W-SEC-SINK-orchestrator-security-tests.log](codex6-W-SEC-SINK-orchestrator-security-tests.log) |
| `pnpm --filter @du/connector test -- tests/vault-account-isolation.test.ts tests/vault-machine-policies-offline.test.ts tests/secret-resolver.test.ts tests/token-renewal.test.ts` | PASS, 4 suites / 49 tests, exit 0 | [codex6-W-SEC-SINK-connector-security-tests.log](codex6-W-SEC-SINK-connector-security-tests.log) |
| `pnpm --filter @du/observability test` | PASS, 1 suite / 22 tests, exit 0 | [codex6-W-SEC-SINK-observability-tests.log](codex6-W-SEC-SINK-observability-tests.log) |

The workspace root has no Jest binary for the standalone `tests/unit/sentinel-sink-matrix.test.ts`; package-level observability and service security suites provide the runnable offline sink coverage. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-SEC-CORR-1 — 2026-09-26

**Task:** Preserve and sanitize `x-correlation-id` across the Admin shell/API boundary (Reviewer Turn 40, Finding 23).  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no DB window.

### Implementation

- `services/orchestrator/src/app/admin/shell-server.ts` now normalizes the incoming `x-correlation-id` with `@du/observability` `normalizeCorrelationId` (safe alphanumeric/UUID-compatible format; invalid or missing values use `randomUUID()`).
- The normalized ID is set on every shell response and reused by deferred-render and unhandled-error paths, preserving wire/log joinability without accepting unsafe header text.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-SEC-CORR-contracts-build.log](codex6-W-SEC-CORR-contracts-build.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-W-SEC-CORR-orchestrator-lint.log](codex6-W-SEC-CORR-orchestrator-lint.log) |
| `pnpm --filter @du/orchestrator test -- tests/adm-base-03-safe-error-offline.functional.test.ts tests/admin-error-boundary-offline.test.ts tests/admin-shell-render.test.ts` | PASS, 3 suites / 175 tests, exit 0 | [codex6-W-SEC-CORR-tests.log](codex6-W-SEC-CORR-tests.log) |

The first test capture encountered a transient loopback `EADDRINUSE`; the immediate rerun passed all 175 tests and replaced the raw log. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-SEC-ADR-SYNC-1 — 2026-09-26

**Task:** Synchronize ADR-17 SEC-00 with Reviewer Turn 50 Finding 23/5.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Scope:** Documentation only; no source edits, DB window, commit, or push.

### Documentation update

- Added an explicit claim-surface boundary to [`docs/15-decisions.md`](../../docs/15-decisions.md): browser `roleFor` maps ambiguous multi-tenant claims to least-privilege read-only `viewer`, while bearer `mapOidcClaimsToPrincipal` returns `null` and denies by default.
- Recorded that both paths consume the canonical [`@du/contracts` OIDC claim-shape contract](../../packages/contracts/src/oidc-claim-shapes.ts), making the difference an intentional policy boundary rather than parser drift.

### Verification / raw log

| Command | Result | Raw output |
|---|---|---|
| Offline Markdown local-link check over ADR and receipt | PASS, `FILES=2 TARGETS=66 ANCHORS=0 BROKEN=0`, exit 0 | [codex6-W-SEC-ADR-SYNC-1-link-check.log](codex6-W-SEC-ADR-SYNC-1-link-check.log) |

No source, database, Redis, Vault, or live IdP activity was used. No commit or push was made.

## W-VAULT-LIVE-PREP-1 — 2026-09-26

**Task:** SEC status update and Vault Live Chain preparation.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; docs/ledger only; no source edit, DB window, commit, or push.

### Turn 60 / ledger status

- Read the Turn 60 Independent Audit in `coordination/reports/review.md`. It adjudicates `W-SEC-ADR-SYNC-1` as **ACCEPTED for documentation/ADR scope only** (claim-surface distinction and shared claim-shape contract).
- Updated `tasks/README.md` with that packet-level **ACCEPTED** note. No SEC umbrella row was ticked and `G-SEC` remains open.

### Migration 008 readiness review

Reviewed `services/connector/src/db/migrations/008_connector_revision_binding.sql` and its registration in `services/connector/src/db/pg-client.ts`.

- Adds `tenant_id` (legacy-safe empty binding) and `account_id`, changes the revision key to `(connector_id, tenant_id, revision)`, and backfills account coordinates from Vault paths.
- Installs the chain guard trigger for cross-tenant/connector/account reuse and duplicate ACTIVE revisions.
- Enforces tenant/account shape, credential-source kind, account/ref agreement, exact seven-segment canonical Vault path, and bound-source-is-Vault checks.
- Tester live preflight should apply migrations 001→008 on an isolated PostgreSQL instance, verify the migration registration/order, exercise an explicit legacy unbound row, then create a bound Vault revision before any end-to-end calls. No migration was applied in this preparation task.

### Prepared Vault Live Chain scenarios

1. **Identity/prefix separation:** provision distinct writer and reader machine identities. Writer may CAS write metadata under `du/tenants/<tenant>/connectors/<connector>/accounts/<account>` but cannot read provider secret; reader may KV-v2 read only that exact prefix/version and cannot write. Assert sibling/foreign tenant and account paths are denied.
2. **Trusted binding and rotation:** Admin creates a PENDING revision from authenticated tenant/connector ownership; Orchestrator persists migration-008 binding; activate with CAS `PENDING → ACTIVE`, rotate to a new pinned version, and retire the prior revision. Assert in-flight submissions keep their pinned revision/version.
3. **Emergency revoke:** revoke/tombstone the ACTIVE revision, then retry an in-flight invocation and a new invocation. Both must fail closed before provider dispatch; audit records remain masked and no secret/token appears in response or logs.
4. **Provider reconciliation:** exercise provider success, outage, bounded retry, and recovery against the reader-resolved pinned secret. Verify no DB/legacy fallback on Vault failure and that reconciliation does not drift the stored version/ref.
5. **Tenant/account negative chain:** send foreign or traversal-shaped values through Admin → Orchestrator → Connector. Assert denial before Vault/provider I/O (zero Vault reads, zero writes, zero provider calls), no cross-tenant audit success, and no raw path leakage.

These are prepared live acceptance scenarios only; no live Vault, PostgreSQL, Redis, provider, or deployment identity was exercised by this packet. `G-SEC` remains **NO-GO/open** pending Tester-owned evidence.

### Documentation verification / raw log

| Check | Result | Raw output |
|---|---|---|
| Offline Markdown local-target/line-anchor check over `tasks/README.md`, `docs/15-decisions.md`, and this receipt | PASS, `3 files / 102 targets / 4 anchors / 0 broken`, exit 0 | [codex6-W-VAULT-LIVE-PREP-1-link-check.log](codex6-W-VAULT-LIVE-PREP-1-link-check.log) |

## W-DATA03-SRV-1 — 2026-09-26

**Task:** DATA-03 server-side URL submission and ingestion READY gate.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; existing dirty worktree preserved; no commit/push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no live DB window.

### Implementation

- Added optional `sourceUrl` to the submission contract and included it in the canonical idempotency hash.
- Added `PENDING_INGESTION` operation/task states. HTTPS syntax, credential, and destination policy validation fail closed before database writes.
- URL submissions are admitted with HTTP 202 and a pending operation/task gate; the server skips business dispatch while ingestion is pending.
- Added `markIngestionReady`, which records the pinned storage version and SHA-256 receipt, transitions the operation to `QUEUED` and the root task to `READY`, then emits the normal task dispatch outbox event.
- Added offline coverage for URL admission, hostile URL rejection, and the pinned-version/hash READY transition.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-DATA03-SRV-contracts-build.log](codex6-W-DATA03-SRV-contracts-build.log) |
| `pnpm --filter @du/connector typecheck` | PASS, exit 0 | [codex6-W-DATA03-SRV-connector-typecheck.log](codex6-W-DATA03-SRV-connector-typecheck.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-W-DATA03-SRV-orchestrator-lint.log](codex6-W-DATA03-SRV-orchestrator-lint.log) |
| `pnpm --filter @du/orchestrator test -- tests/url-ingestion-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts` | PASS, 3 suites / 42 tests, exit 0 | [codex6-W-DATA03-SRV-orchestrator-tests.log](codex6-W-DATA03-SRV-orchestrator-tests.log) |

Jest emitted the routine PowerShell stderr wrapper around a `PASS` line; all requested offline suites completed successfully. No live infrastructure was used. No task row was marked accepted. No commit or push was made.

## W-OIDC-SWEEP-1 — 2026-09-26

**Task:** Comprehensive offline OIDC/security validation sweep.  
**Workspace/CWD:** `D:\Git\dugate\du-rework`  
**Source identity:** `HEAD 7811298844450f373687c478d08d1edfa53ae124`; no source edits, commit, or push.  
**Environment:** Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`; offline only, no DB window claimed.

### Verification / raw logs

| Command | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/contracts build` | PASS, exit 0 | [codex6-W-OIDC-SWEEP-1-contracts-build.log](codex6-W-OIDC-SWEEP-1-contracts-build.log) |
| `pnpm --filter @du/orchestrator lint` | PASS, exit 0 | [codex6-W-OIDC-SWEEP-1-orchestrator-lint.log](codex6-W-OIDC-SWEEP-1-orchestrator-lint.log) |
| OIDC/security Jest sweep (11 suites) | PASS, 11/11 suites; 178 passed, 10 skipped, 188 total; exit 0 | [codex6-W-OIDC-SWEEP-1-tests.log](codex6-W-OIDC-SWEEP-1-tests.log) |

Suites covered: claim-shape contract, admin dispatcher, OIDC-03 role/action/tenant, OIDC-04 claims, admin OIDC flow, shell OIDC integration, OIDC client, both OIDC-02 replica suites, sentinel RBAC boundary, and VAULT-04 admin actions. Skips are the suite-declared offline guards; no live DB/Redis/IdP window was claimed.
