# Báo cáo lane Qwen-Vault (Security & Vault Implementer)

## RESUME POINT
- Lane: Qwen-Vault — VAULT-01..06, SecretResolver, ownership binding. Receipt file này bắt đầu từ Muc 1.
- Packet gần nhất: **W-VAULT06-ROTATION-LIFECYCLE-1** (2026-09-26, Muc 5) — VAULT-06: kiểm chứng `services/orchestrator/src/modules/connector-credentials/workflow.ts` ở 2 tính chất: (a) restart/reconcile revision PENDING do crash/lost-connection — idempotent, không duplicate ACTIVE, không PENDING mồ côi; (b) emergency revoke retire TOÀN chain, không còn ACTIVE nào invoke được. Mở rộng 2 file lifecycle tests.
- Trạng thái packet: **[VERIFIED offline]** — `pnpm --filter @du/orchestrator test -- <2 file đích>` 3 lần liên tiếp **2 suites / 40 passed**, mỗi lần **Exit Code: 0** (Times 4.39s / 4.576s / 4.696s); `pnpm --filter @du/orchestrator exec tsc --noEmit` 3 lần **Exit Code: 0** (PGID 7344/32592/27080). Cả 2 tính chất packet ĐÃ đúng trong src — production diff = 0. **Mở MỚI**: Δ7 (reconcile replay trên revision đã ACTIVE trả label 'RETIRED' trong khi state không đổi — state-idempotent, label-misleading; test pin cả hai) + Δ8 (reconcile KHÔNG emit audit event — restart-repair vô hình trước audit trail, pin bằng `events.length === 0`). **Mở cũ**: Δ1–Δ6 (các cycle trước) — Reviewer adjudicate. Live legs (PG migration 008, connector /disable thật, 2-replica concurrent rotation) thuộc Tester; G-SEC vẫn NO-GO; lane không tick VAULT-06.
- Write scope cycle này: CHỈ 2 file test — `services/orchestrator/tests/admin-actions-vault04-offline.functional.test.ts` (20→24) và `services/orchestrator/tests/mock-vault-harness-offline.functional.test.ts` (13→16); mỗi MemStore thêm toggle `failNextActivate` (mô hình crash window B đúng comment src). `workflow.ts`, `connector-http-store.ts`, `dispatcher.ts` chỉ ĐỌC. Không commit/push, không DB/Redis window. Lưu ý git: cả cây du-rework untracked (`??`) — scope chu kỳ chứng minh bằng transcript, không bằng ` M` flag.
- (Lịch sử) Muc 4 W-VAULT-POLICY-HCL-IDENTITY-1: contracts vault-policies.test.ts 45→62, build x3 + full 16/350 x3 Exit Code 0, Δ5 Δ6. Muc 3 W-VAULT-CONNECTOR-ISOLATION-1: connector 45/45 x3 + typecheck x3 Exit Code 0, Δ4. Muc 2 W-VAULT-POLICY-CANONICAL-1: 45 tests x3, full 14/283, Δ2 Δ3. Muc 1 W-VAULT-BINDING-FIX-1: 3 suites/52 x3 Exit Code 0, Δ1.

## 1 — CYCLE 102 FIX: W-VAULT-BINDING-FIX-1 — mock-vault harness BINDING_DENIED

### Nguyên nhân (đã tái tạo trước khi sửa)
Chạy gốc: `pnpm --filter @du/orchestrator test -- tests/mock-vault-harness-offline.functional.test.ts` → **7 failed, 5 passed, 12 total**, Exit Code 1. Toàn bộ fail tại `workflow.ts:166` `HttpError(403, 'BINDING_DENIED')` — sau khi thiết kế migration-008 (Reviewer Turn 30 đã resolve T20-V1: load ACTIVE revision → bắt buộc binding → candidate check → canonical path từ binding → rồi mới `writeCas`) được chấp nhận, `MemStore` của harness (file untracked, viết từ CYCLE 102) chưa bao giờ được cập nhật: seed row không có `tenantId`/`accountId`, nên `ConnectorRevisionBindingSchema.safeParse` fail ngay bước binding gate. 2/7 fail là **masking** đúng như T-CODEX-TEST-26 ghi: test `VAULT_POLICY_DENIED` và test 503-retryable bị chặn TRƯỚC hành vi chúng cần kiểm. Suite `connector-credentials-offline` đã có binding ('tenant-a' / 'du-conn-openai-main', dòng 157-158/247-248) nên 39/39 xanh — harness mock-vault là file lạc hậu duy nhất.

### Fix (chỉ trong file test)
1. Seed row `MemStore`: thêm `tenantId: 'tenant-openai'`, `accountId: 'du-conn-openai-main'` (đúng bộ với `VAULT_PREFIX`/`REF` có sẵn).
2. `createPending`: clone cột binding từ head — cùng ngữ nghĩa "PENDING cloned from CURRENT" của `connector-http-store.ts` thật; nếu không thì rotate lần 2 (test 1/2/4/5/6) sẽ BINDING_DENIED trên rev2.
3. Test "path outside the role prefix" tách thành 2 test theo đúng 2 tầng enforce được (xem Δ1).

### Định nghĩa win/lose của từng test từng-đỏ (nay xanh)
| Test | WIN = | Lose khi |
|---|---|---|
| rotate writes through HTTP KV v2 | rev2 ACTIVE, version 1→2 trên đúng `VAULT_PATH`, `readValue` trả đúng SECRET | BINDING_DENIED / sai path / version không tăng |
| stale CAS → 412 | rejects `{status:409, code:'VAULT_CAS_CONFLICT'}`, versions vẫn [1], rows length 2 | mapping 412 mất, hoặc churn revision |
| cross-tenant candidate BEFORE wire (MỚI) | rejects `{422, 'INVALID_SCHEMA'}`, `writes=0`, `rows=1`, routes KHÔNG chứa 'write'/'policy-denied' (zero wire call) | request kịp chạm server |
| REAL 403 on the wire → VAULT_POLICY_DENIED | (a) `client.credentialWriter.writeCas` foreign path → rejects `CAPABILITY_DENIED`, route 'policy-denied' có thật trên wire; (b) `failNextWrite('policy-denied')` → `wf().rotate` rejects `{403,'VAULT_POLICY_DENIED'}`, zero writes, rows untouched | 403 wire không map qua `refIssue`, hoặc tạo nửa tác dụng |
| server 5xx retryable | first rotate rejects `{503,'TEMPORARY_UNAVAILABLE'}` với `rows=1` (no half-effect), retry thành công ACTIVE, versions [1] | 5xx bị nuốt, hoặc để lại PENDING mồ côi |
| lease revoke fail-closed | sau `revokeCurrentToken`, rotate rejects 403-class, versions [1], đúng 1 ACTIVE=rev2 | rotate lén ghi được bằng lease chết |
| workflow.revoke retires chain | `{revoked:true, previousRevision:2}`, 0 ACTIVE, audit không chứa SECRET | còn ACTIVE mồ côi / leak audit |
| metadata masks values | raw GET metadata → 200, có 'versions', không chứa SECRET | metadata trả data |
| zero-secret error chain | dump 2 error không chứa SECRET/'hvs.' | message echo giá trị |

### Δ1 — Δ-DEVIATION (chờ Reviewer adjudicate, lane không tự quyết)
Test 3 GỐC đòi `wf().rotate` với ref cross-tenant phải nhận **403 VAULT_POLICY_DENIED từ wire**. Under the binding-first design đã được Reviewer Turn 30 phê, điều đó **không thể xảy ra**: candidate bị binding gate chặn tại `422 INVALID_SCHEMA` TRƯỚC `writeCas`, và path ghi lên wire là canonical-from-binding. Hai lựa chọn loại trừ nhau: hoặc regression code về hành vi cũ (vi phạm T20-V1 đã resolve), hoặc cập nhật test. Đã chọn **cập nhật test** (tách 2 tầng), giữ nguyên ten test cho wire-403 va chứng minh cả 2 lop: binding local (layer 1) + Vault role policy that 403 tren day HTTP qua chinh seam `credentialWriter` ma workflow dung (layer 2). Duong `VAULT_POLICY_DENIED` va 503-retryable **nay moi that su duoc kiem chung** qua workflow (truoc day bi BINDING_DENIED che — khong phai "xanh may moc").
So total thay doi **51 → 52**: do test-3 tach thanh 2 test, KHONG phai tang coverage ao.

### Bang chung chay (offline, khong mo cua so DB/Redis)
- `pnpm --filter @du/contracts build` → `tsc -p tsconfig.json`, **Exit Code: 0**.
- Suite dich `mock-vault-harness-offline.functional.test.ts`: **13 passed, 13 total**, Exit Code: 0.
- Lenh step-4 cua packet (3 suite gop), **3 lan lien tiep**: moi lan `Test Suites: 3 passed, 3 total` / `Tests: 52 passed, 52 total`, wrapper tra ve literal `Exit Code: 0` ca 3 lan (run 1/2/3, Times 3.24s / 3.31s / 3.66s).
- `pnpm run lint` (= `tsc --noEmit -p tsconfig.json` cua @du/orchestrator): **Exit Code: 0**.
- Diff kiem tra `git status --porcelain`: chi file test tren thay doi (no van untracked `??` nhu truoc); khong cham src/, khong cham contracts/src (files contracts dang M trong cay la cua lane khac, khong phai cua cycle nay).
- Khong commit, khong push, khong mo DB/Redis/S3/Vault window.

### Con mo (khong thuoc packet)
- Live legs: migration 008 apply tren PostgreSQL that + round-trip legacy, real Vault writer/reader policy separation, foreign tenant/account zero-write tren deployed identities → Tester lane, G-SEC van NO-GO.
- Δ1 cho Reviewer xac nhan cach tach test 3 phu hop hop dong VAULT-03 sau binding-first.

## 2 — W-VAULT-POLICY-CANONICAL-1: Canonical Path Enforcement and Traversal Rejection (contracts)

### Ket luan kiem tra (step 1–2 cua packet) — truoc khi them test
1. **`matchesVaultAccountPath` nam ở `packages/contracts/src/vault.ts:137`, KHONG phai `vault-policies.ts`** nhu packet ghi (Δ2). Lane kiem tra ham that, khong di chuyen code.
2. **Traversal da fail-closed o HAI tang, truoc khi cycle nay dien ra**: (a) tang schema (`vaultKv2Refine`/`segmentIssue` → `hasForbiddenChars` chan `'..'`, `'~'`, backslash, `%` (chan ca `%2e%2e`/`%2f`/`%5c` vi `%` bi cam tuyet doi), whitespace, control chars, empty/leading/trailing segment); (b) tang exact-segment trong `matchesVaultAccountPath`: dung 7 segment, doi chieu literal `du`/`tenants`/`connectors`/`accounts`, `tenantId` qua `^[a-z0-9][a-z0-9._-]{0,63}$` nen `..`/`.`/`%2e%2e`/`Tenant-A` deu bi loai — ham tra ve `false` ke ca khi ref CHUA qua schema (du cho cho candidate chua kiem chung). `inScope` trong `vault-policies.ts` (seam `evaluateVaultAccess`) cung chan rieng segment `.`/`..` (comment trong code ghi ro ly do: chong prefix bo noi rong qua duong du-chuan-hoa HTTP).
3. **Canonical that duoc pin bang test (step 2)**: `du/tenants/<tenantId>/connectors/<connectorId>/accounts/<accountId>` — 7 segment dung, khong co `<rest>`, khong chua mount, khong chua `data/`. `secret/data/...` chi xuat hien o tang HCL/wire do `renderVaultPolicyHcl` ghep (`mount + "/data/" + prefix`), khong phai gia tri field `path`. Packet buoc 2 mo ta `secret/data/du/tenants/<t>/accounts/<a>/<rest>` thieu `connectors/<c>` va cho phep `<rest>` — nep theo packet se REGRESS code da duoc Reviewer cert (T20-V1, Turn 30). Lane GIU code, them test bac bo ca hai bien the trai phai cua packet (Δ3, cho Reviewer adjudicate).

### Fix (chi trong file test — production diff = 0)
`packages/contracts/tests/vault-policies.test.ts`: them import tu `../src/vault` + **4 describe / 24 test moi** (suite tu 21 → 45):
- `matchesVaultAccountPath — canonical structure is the only accepted shape` (9): chan shape 7-segment (ca scope co/khong `tenantId`); bac 5-segment shortcut thieu `connectors`, `accounts/<a>/nested` (`<rest>`), `secret/data/`-folded, `data/`-prefixed, leading slash, keyword case-folded, legacy `du/connector/openai/prod`.
- `matchesVaultAccountPath — traversal fails closed on an UNVALIDATED ref` (10): `..`/`.` o tenant/connector/account position (ke ca `ref.account='..'`/`'.'`), leading `../../`, trailing `../`, `%2e%2e`; foreign tenant/account/connector; positive control schema-layer chan `'..'` substring doc lap (defense-in-depth).
- `evaluateVaultAccess — traversal cannot walk out of a granted prefix` (2): `du/connector/protected/../../evil`, `du/connector/./openai/prod`, `du/connector/x/../../..` → PREFIX_DENIED du string van bat dau bang prefix; positive control `du/connector/x..y/v1.2` → allow (check nham dot-segment, khong nham id chua cham hop le).
- `credential-source alias normalization never relaxes the canonical path` (3): alias `vault-kv-v2` → canonicalize `vault-kv2` gi nguyen path; alias KHONG phai duong tat — `matchesVaultRevisionBinding` van bac foreign tenant/account; alias mang path 5-segment hoac traversal bi bac end-to-end.

### Dinh nghĩa win/lose cua nhom test moi
| Nhom | WIN = | Lose khi |
|---|---|---|
| canonical structure | ham chi tra `true` DUNG voi shape 7-segment; moi bien the packet-cua (5-segment, `<rest>`, `secret/data/`-folded, case-fold, legacy) tra `false` | bat ky alias nao luot qua exact-segment check |
| traversal unvalidated | moi chu `..`/`.`/`%2e%2e`/leading/trailing escape tra `false` ma khong can schema truoc no | ham dựa vào schema caller de an toan |
| foreign binding | sai tenant/account/connector bat ky huong nao (scope hoac path) → `false` | compare bo sot dung mot chieu |
| policy traversal | dot-segment bi PREFIX_DENIED du string-prefix khop; `x..y`/`v1.2` van allow | check qua rong (chan id hop le) hoac qua hen (cho escape) |
| alias normalization | `kind` duoc canonical hoa, `path` khong bi; alias khong mai duoc binding | normalize cho phep bo qua canonical check |

### Δ2 / Δ3 — Δ-DEVIATION (cho Reviewer adjudicate, lane khong tu quyet)
- **Δ2**: buoc 1 cua packet dat `matchesVaultAccountPath` trong `vault-policies.ts`; thuc te no o `vault.ts:137` (`vault-policies.ts` chua `evaluateVaultAccess`/`inScope` — lane kiem ca hai seam). Khong co gi di chuyen; chi ghi de ledger khong bi dua tren duong dan sai.
- **Δ3**: buoc 2 cua packet yeu cau canonical `secret/data/du/tenants/<t>/accounts/<a>/<rest>` — TRAI VOI hop dong da ratified `du/tenants/<t>/connectors/<c>/accounts/<a>` (7-segment, mount tach, `data/` chi la tang wire). Lane khong doi code theo packet; test moi pin canonical ratified va bac ca hai dang sai. Neu coordinator THAT SU muon canonical moi, day la contract change (workflow + wire + migration binding columns) — can packet rieng co Reviewer, khong phai viec cua cycle offline nay.

### Bang chung chay (offline, khong mo cua so DB/Redis/Vault that)
- `pnpm --filter @du/contracts build` (= `tsc -p tsconfig.json`): **Exit Code: 0**.
- Lenh step-4 cua packet (`pnpm --filter @du/contracts test -- tests/vault-policies.test.ts`), **3 lan lien tiep** (moi lan mot goi lenh rieng, khong gop lenh de tranh wrapper-an-exit-code): moi lan `Test Suites: 1 passed, 1 total` / `Tests: 45 passed, 45 total`, literal `Exit Code: 0` (Times 2.961s / 2.206s / 2.597s).
- Extra ngoai packet: full suite `pnpm --filter @du/contracts test` → `Test Suites: 14 passed, 14 total` / `Tests: 283 passed, 283 total`, **Exit Code: 0** (khong co test nao bi do skip).
- Diff scope: `git status --porcelain -uall -- du-rework/packages/contracts/tests` → `tests/vault-policies.test.ts` van untracked `??` (file CYCLE chua tung commit, nhu Muc 1); **khong cham bat ky `src/` nao** cua contracts; files `M`/`??` khac trong cay (usage-metrics, operations-list, vault.ts...) la cua lane khac, nguyen ven.
- Khong commit, khong push, khong mo DB/Redis window.

### Con mo (khong thuoc packet)
- Δ1 (Muc 1) + Δ2 + Δ3 cho Reviewer.
- Live legs khong doi: real Vault writer/reader separation, foreign tenant zero-write tren deployed identities → Tester; G-SEC van NO-GO; VAULT-01/02/03 van trang thai task-board cu, lane khong tick.

## 3 — W-VAULT-CONNECTOR-ISOLATION-1: VAULT-05 foreign account & path mismatch denial trước Vault/provider (connector)

### Kết luận kiểm tra (step 1–2) — hiện trạng ĐÃ fail-closed, lane chỉ bổ sung test chứng minh
1. `src/vault/resolver.ts`: `parseCredentialSource` fail-closed CREDENTIAL_INVALID với malformed/unsupported kind (union legacy-db/vault-kv2 + alias); `assertVaultAccountPrefix` → `matchesVaultAccountPath` (contracts) → BINDING_DENIED; `resolveVault` không config reader → CREDENTIAL_INVALID, **không bao giờ fallback legacy**; retry có trần, 5xx → PROVIDER_UNAVAILABLE safeToRetry.
2. Chuỗi so sánh 3 bên GrantClaims↔Revision↔VaultKv2Ref nằm ở `DurableConnectorRuntime.invoke` (services.ts): parse `claims.connectorRevision` → `getRevision(..., {tenantId: claims.tenantId})` (predicate) → branch `isBoundRevisionTenant(revision.tenantId) && revision.tenantId !== claims.tenantId` → `matchesVaultRevisionBinding(source, {tenantId, connectorId, accountId})` (services.ts:106) **trước** `secretResolver.resolve` (:116) → `invokeAdapter`/transport **sau** resolve. Seam quản trị: `DurableConnectorManagement.test` (:312) cũng check binding trước probe.
3. **Δ4 (Δ-DEVIATION)**: packet ghi "SecretResolver strictly compares GrantClaims, ConnectorRevision, VaultKv2Ref". Trong code, `SecretResolver.resolve(source)` không hề thấy GrantClaims — so sánh là trách nhiệm invoke boundary ở mục 2. Lane verify + pin test tại seam THẬT, không dời code, production diff = 0; chờ Reviewer adjudicate cách diễn đạt packet.

### Fix (chỉ trong 2 file test — 7 test mới, baseline 38 → 45)
- `tests/vault-account-isolation.test.ts` (8 → 13): harness `createRuntime` thêm `RuntimeOptions {grantTenantId, unscopedRepository, revisionTenantId}` (mặc định giữ nguyên hành vi, các test cũ không đổi kết quả); describe MỚI "VAULT-05 grant, revision and ref comparison precede Vault and provider" — 5 test, mỗi test assert `reads === 0` VÀ `providerCalls() === 0`:
  1. Foreign **grant** tenant (signed grant tenant-b, ref khớp hoàn hảo tenant-a) → `{BINDING_DENIED, message: 'Invocation grant connector revision binding is invalid.'}`. Message được pin chính xác để loại false-green từ validateGrant ('Invocation grant binding is invalid.' — hash forge theo tenant-b nên không thể ăn gian qua cửa đó).
  2. Store **bỏ qua** tenant predicate (defense-in-depth) → runtime branch :94 vẫn DENY trước parse/resolve.
  3. Unsupported kind `aws-kms` → CREDENTIAL_INVALID.
  4. Vault ref mất version pin → CREDENTIAL_INVALID trước mọi read.
  5. legacy-db credential trên revision ĐÃ bound tenant → CREDENTIAL_INVALID trước provider (branch services.ts:119).
- `tests/secret-resolver.test.ts` (21 → 23): management describe thêm 2 test — revision có `tenantId: 'tenant-b'` ngoài path, và `accountId` column lệch ref → `test('openai')` trả `{ok:false, errorCode:'BINDING_DENIED'}` với **zero resolver probe** (đếm readSecret === 0).
- `tests/vault-machine-policies-offline.test.ts`: KHÔNG sửa (đã có assertVaultAccountPrefix-before-read + fixture PREFIX_DENIED traversal cases).

### Định nghĩa win/lose của nhóm test mới
| Nhóm | WIN = | Lose khi |
|---|---|---|
| Foreign grant tenant + defense-in-depth store | rejects `BINDING_DENIED` đúng message invoke-boundary, reads 0, provider 0 | lọt tới resolve/probe, hoặc chết ở validateGrant (message khác) |
| Unsupported kind / missing version | rejects `CREDENTIAL_INVALID` trước reader | có readSecret nào được gọi |
| legacy-db trên bound revision | rejects `CREDENTIAL_INVALID` | giải mã đọc được secret của row bound |
| management.test foreign tenant/account column | `{ok:false,'BINDING_DENIED'}` + 0 probe | probe chạm Vault fixture |

### Bằng chứng chạy (mỗi lệnh một tool call riêng — không wrapper gộp)
- Targeted 3 suites, 3 lần liên tiếp: `Test Suites: 3 passed, 3 total` / `Tests: 45 passed, 45 total`, mỗi lần **Exit Code: 0** (Times 5.107s / 2.699s / 2.788s).
- `pnpm --filter @du/connector typecheck`: 3 lần, mỗi lần **Exit Code: 0**. Giới hạn verifying: tsconfig `include: ["src/**/*.ts"]` → typecheck gate KHÔNG phủ tests/; tests được ts-jest typecheck lúc chạy (xanh ×3).
- Diff scope: 2 file test edited đều untracked `??` (tree rework chưa commit — như các Muc trước); `git diff --stat -- du-rework/services/connector` chỉ hiển thị thay đổi pre-existing của cả tree, không có delta src/ từ cycle này vì lane không mở tool edit/write vào bất kỳ file `src/` nào.
- Không commit, không push, không DB/Redis window, không tick task row VAULT-05.

### Còn mở
- Δ1 (Muc 1), Δ2 + Δ3 (Muc 2), Δ4 (Muc 3) — Reviewer adjudicate.
- Live legs không đổi: foreign tenant zero-write trên Vault/PG deployed thật → Tester; G-SEC vẫn NO-GO.

## 4 — W-VAULT-POLICY-HCL-IDENTITY-1: VAULT-02 machine identities + HCL capability matrix (contracts)

### Kết luận kiểm tra (step 1) — renderer ĐÃ tách vai trò tuyệt đối; production diff = 0
1. `renderVaultPolicyHcl` (packages/contracts/src/vault-policies.ts) với cả 2 scope sets (dev default `du/connector` và tenant-wildcard `du/tenants/+/connectors/+/accounts`): **orchestrator-writer** đúng 2 block — `secret/data/...` capabilities `["create","update"]` + `secret/metadata/...` `["read","list"]`; KHÔNG block data nào chứa `read` (vaultPolicyFor writer = `['write','metadata-read']` — `read` không hề có trong capability set, nên branch data-read bất khả thi về cấu trúc). **connector-reader** đúng 2 block `["read"]`/`["read"]`; mọi block chỉ `read` (zero create/update/patch/delete/list/sudo). **worker/browser/unknown actor**: comment-only, `hasVaultIdentity=false`, ZERO path block → fail closed đúng packet.
2. Artifact deployed `infra/vault/policies/{orchestrator-writer,connector-reader,worker-browser}.hcl` được sinh từ CHÍNH hàm này (README infra) — thêm **drift guard** byte-identical (normalize CRLF) để mọi src change tương lai bắt buộc regenerate infra.
3. Packet không yêu cầu sửa src và thực tế không cần sửa: cả 3 gạch đầu dòng ma trận đã đúng trong code. Lane chỉ ĐO LẠI bằng parser cấu trúc thay vì substring `toContain` (substring không phát hiện block bị nới rộng/đảo vai trò).

### Δ5 / Δ6 — Δ-DEVIATION (chờ Reviewer adjudicate, lane không tự quyết)
- **Δ5**: packet ghi writer metadata `['read']` (không `list`); code + HCL deployed + test gốc (Qwen-2 cycle 95, pin `read, list`) cho phép `list` trên `secret/metadata/du/...` — `list` ở tầng metadata cho phép LIỆT KÊ tên path trong prefix (không lộ plaintext, metadata value-free đã chứng minh Muc 2). Bỏ `list` là siết quyền deploy → sửa src + regenerate infra, không phải việc lane tự quyết offline. Test mới PIN hành vi deployed hiện tại.
- **Δ6**: literal packet `'secret/data/du/tenants/+/connectors/+/accounts/+'` KHÔNG thể sinh bởi renderer (luôn nối `/*` sau pathPrefix). Gần nhất sinh được: `…accounts/*` — theo ngữ nghĩa glob chuỗi của Vault (`+` = đúng 1 segment không chứa `/`, `*` = 0+ ký tự bất kỳ kể cả `/`), glob này BAO đường dẫn canonical 7-segment nhưng là superset (nhận thêm `…/accounts/<a>/nested`) → tầng HCL chưa enforce "đúng 7 segment" như binding gate phía runtime đã enforce (Muc 2/3). Siết đúng-7 ở HCL cần src change (suffix glob-aware/`+` cuối) — cần packet riêng. Test mới pin CẢ HAI chiều: canonical glob-match = true, `accounts/<a>/nested` glob-match = true (tài liệu hóa Δ6), và biến thể `…accounts/+/*` KHÔNG khớp canonical (vì thiếu segment sau `+`) → chứng minh vì sao literal packet không render được.

### Step 2 — 17 test mới trong `packages/contracts/tests/vault-policies.test.ts` (45 → 62)
- **Parser cấu trúc test-local** `parseHclBlocks`: cân bằng ngoặc kép/ngoặc nhọn, header `path "..." {` regex, capabilities chỉ token hợp lệ Vault (8 token), không duplicate, không rỗng, mọi path phải thuộc `secret/data/|secret/metadata/` (chặn mount-folded drift).
- Nhóm well-formed (3): mọi actor × 2 scope sets parse sạch; render deterministic byte-identical; write-family chỉ xuất hiện trên data paths, data paths không bao giờ mang list/sudo/deny.
- Writer (3): block set CHÍNH XÁC (deep-equal) cho dev scope và tenant-wildcard scope; đúng 1 data block capabilities `['create','update']` — không `read` (mọi scope set).
- Reader (3): block set chính xác 2 scope; mọi block chỉ `['read']`.
- Worker/browser (3): it.each 2 actor — zero blocks, không chứa keyword `capabilities`, có `NO Vault access`; ghost actor (`root`, `''`) fail-closed như worker, `vaultPolicyFor(...).hasVaultIdentity=false`.
- Disjoint (2): không path+caps block nào dùng chung writer/reader; trên data paths writer∩reader = ∅ (writerCaps=`create,update`, readerCaps=`read`).
- Canonical coverage (2): glob khớp `secret/data/<CANON_PATH>` và `secret/metadata/<CANON_PATH>` (chính `CANON_PATH` 7-segment đã ratified Muc 2); foreign mount `kv-prod/...` không khớp block nào; + test pin giới hạn renderer Δ6 (see trên).
- Drift guard (1): 3 file infra/vault/policies byte-identical với render output.

### Định nghĩa win/lose của nhóm test mới
| Nhóm | WIN = | Lose khi |
|---|---|---|
| Well-formed | parse 8 tổ hợp actor×scope không lỗi cú pháp, token hợp lệ, deterministic | HCL sinh lệch cú pháp hoặc đổi thứ tự giữa 2 lần gọi |
| Writer ma trận | data blocks chỉ create/update, không `read` ở mọi scope set | một block data thêm read → writer thấy plaintext |
| Reader ma trận | mọi block chỉ `read` | lọt create/update/patch/delete/list/sudo |
| worker/browser fail-closed | zero path block, không keyword capability | sinh block rỗng có `capabilities` |
| Disjoint tuyệt đối | writer∩reader data caps = ∅; không block chung | một cap chồng lấn data |
| Canonical coverage + Δ6 | `…accounts/*` khớp đúng canonical wire path; `…+/*` KHÔNG khớp canonical; nested được ghi nhận là superset | glob matcher sai ngữ nghĩa Vault → bằng thuyết minh Δ6 mất giá trị |
| Drift guard | infra/*.hcl == renderer output | src đổi mà quên regenerate deploy artifact |

### Bằng chứng chạy (mỗi lệnh một tool call riêng — không wrapper gộp)
- `pnpm --filter @du/contracts build`: 3 lần liên tiếp trên code cuối, mỗi lần **Exit Code: 0** (PGID 8448 / 32408 / 27288).
- `pnpm --filter @du/contracts test` (full suite, lệnh step-3 của packet): 3 lần, mỗi lần `Test Suites: 16 passed, 16 total` / `Tests: 350 passed, 350 total`, **Exit Code: 0** (Times 3.395s / 3.149s / 3.111s). Lưu ý minh bạch: tổng suite tăng 14/283 (Muc 2) → 16/350 do các lane khác thêm tests vào contracts tree giữa các cycle; delta CỦA LANE chỉ là `vault-policies.test.ts` 45→62 (+17) — không suite nào bị skip (350 passed = 350 total cả 3 lần).
- Targeted smoke trước evidence-chain: `test -- tests/vault-policies.test.ts` → 62/62 Exit Code: 0 (Time 2.752s). Trong đó có 1 vòng đỏ hợp lệ trên đường tới xanh: 5 lỗi TS strict (`noUncheckedIndexedAccess` trên regex groups + 1 assertion index) và 1 lỗi ngữ nghĩa glob (`accounts/+/*` KHÔNG khớp canonical vì thiếu segment sau `+`) — cả hai sửa trong test file, không đụng src; lỗi glob chứng minh Δ6 bằng hành vi thật của matcher.
- Diff scope: tool edit/write chỉ chạm `packages/contracts/tests/vault-policies.test.ts`; `src/vault-policies.ts` và `infra/vault/**` chỉ ĐỌC. Không commit/push, không DB/Redis/Vault window, không tick task row VAULT-02.

### Còn mở
- Δ1–Δ4 (như cũ) + Δ5, Δ6 — Reviewer adjudicate.
- Live legs: load HCL lên Vault thật + verify role path narrower hơn policy; foreign tenant zero-write trên deployed identities → Tester; G-SEC vẫn NO-GO.

## 5 — W-VAULT06-ROTATION-LIFECYCLE-1: VAULT-06 restart/reconcile PENDING + emergency revoke (orchestrator)

### Kết luận kiểm chứng (step 1) — src ĐÚNG, production diff = 0
1. **Restart/reconcile**: `reconcile` = CAS `activate(revision, expectedCurrent)` — chỉ promote khi ACTIVE head thật đúng bằng `expectedCurrent`, ngược lại retire fallback. Hệ quả: **không thể duplicate ACTIVE** (một slot duy nhất, target còn phải đang PENDING), **không mồ côi PENDING** (nhánh else luôn retire; `retire` chỉ nhận state PENDING nên không đụng ACTIVE — cả MemStore lẫn hợp đồng `connector-http-store.ts`: activate 200/409→true/false, retire 204/404→OK). Crash window B (activate throw) để PENDING **không routable**: `get()`/`describe()` vẫn trả revision ACTIVE cũ với pinnedVersion cũ trong khi Vault đã mang version mới — bằng chứng sống: `rev2.pinnedVersion=1` lúc `vaultVersions=[1,2]`.
2. **Emergency revoke**: `revoke` gọi `revokeAll` — TOÀN chain retire (kể cả PENDING đang mắc kẹt giữa chain); store thiếu `revokeAll` → **501 REVOKE_UNSUPPORTED fail-closed, zero rows touched** (không nửa revoke); sau revoke không còn ACTIVE anchor → rotate kế tiếp 404 NOT_FOUND, reconcile muộn `activate false + retire no-op` → không sống lại được. Audit detail revoke masked: `{state:'RETIRED', previousRevision, hasValue:true}` — zero secret.
3. Hai khe hành vi ngoài packet, pin lại làm Δ (lane không tự sửa src).

### Δ7 / Δ8 — Δ-DEVIATION (chờ Reviewer adjudicate, lane không tự quyết)
- **Δ7**: `reconcile` replay trên revision **đã ACTIVE** (lần reconcile trước thành công) trả label **`'RETIRED'`** trong khi state KHÔNG đổi (activate CAS mismatch vì current = chính revision đó ≠ expectedCurrent → retire chạy nhưng no-op trên ACTIVE). Bất biến an toàn state giữ nguyên (đúng 1 ACTIVE, zero write churn) nhưng **label gây nhầm cho loop tiêu thụ return value** (restart reconciler sẽ "sửa" tiếp một revision đang healthy). Nếu Reviewer muốn label đúng: src phải đọc state row trước khi verdict. Test mock-harness pin CẢ HAI (`again === 'RETIRED'` + `rev3.state === 'ACTIVE'`) — adjudicate hướng nào thì đúng một assertion đổi, bất biến state đứng nguyên. Test admin-file chỉ pin state (robust với fix tương lai).
- **Δ8**: `reconcile` **không emit audit event** nào (rotate/revoke có `connector.credential_rotate`/`connector.credential_revoke`) → restart-repair vô hình trước audit trail, trong khi VAULT-06 là lifecycle có side effect thật (promote/retire). Thêm audit = quyết định src + packet riêng (định nghĩa action name + detail mask). Test pin `events.length === 0` ghi lại nguyên trạng thái hôm nay.

### Step 2 — 7 test mới (2 file)
`admin-actions-vault04-offline.functional.test.ts` **20→24** và `mock-vault-harness-offline.functional.test.ts` **13→16**. Mỗi MemStore thêm toggle `failNextActivate` (throw đúng một lần tại activate — mô hình crash window B theo comment src; default false nên không đổi 33 test cũ). Admin (dispatcher thật + VAULT-02 fixture): (1) stranded PENDING → describe vẫn phục vụ pinnedVersion cũ trong khi chờ → workflow instance mới ("restart") reconcile promote: rev2 RETIRED, rev3 pins v2, zero PENDING, describe dump zero VALUE2; (2) replay: đúng 1 ACTIVE, writes array không đổi (reconcile không chạm Vault); (3) revoke toàn chain (legacy rev1 + ACTIVE rev2 + stranded rev3 đều RETIRED), revokedAllCalls=1, rotate sau revoke 404, reconcile sau revoke không resurrect, audit dump không VALUE/VALUE2; (4) facade store thiếu revokeAll → 501 fail-closed, rows nguyên. Mock harness (real HTTP, mock Vault sống suốt cycle): (5) versionsOf=[1,2], counters().writes đứng yên qua reconcile, pinnedVersion=2 sau promote, `events.length===0` = Δ8; (6) replay pin Δ7 (label vs state); (7) revoke toàn chain qua HTTP: every RETIRED, rotate sau revoke 404 mà writes vẫn = 2, dump không SECRET/'hvs.'.

### Bảng win/lose
| Nhóm test | WIN = | Lose khi |
|---|---|---|
| Admin: stranded + restart promote | PENDING sau crash; describe cũ trong khi chờ; reconcile→ACTIVE, 1 ACTIVE, 0 PENDING, pinnedVersion 1→2 | duplicate ACTIVE / mồ côi PENDING / nửa ref route được |
| Admin: replay state-safe | state nguyên, writes array không đổi | replay xoá/mượn ACTIVE hoặc ghi thêm Vault version |
| Admin: revoke toàn chain | 3 rows RETIRED hết, revokedAllCalls=1, rotate→404, reconcile→RETIRED, dump không secret | còn ACTIVE/PENDING sống sau emergency revoke |
| Admin: store thiếu revokeAll | 501 REVOKE_UNSUPPORTED, rows nguyên | revoke nửa chain im lặng |
| Harness: restart reconcile qua HTTP | writes counter đứng yên, promote đúng, describe masked, events=0 (Δ8) | reconcile ghi lại secret / promote sai slot |
| Harness: replay Δ7 | label 'RETIRED' + state ACTIVE được pin đồng thời | hành vi đổi mà test không phát hiện |
| Harness: revoke chain | every RETIRED, 404 kế tiếp, writes=2 cố định, zero-secret dump | còn invoke được sau emergency revoke / leak audit |

### Bằng chứng chạy (mỗi lệnh một tool call riêng — không wrapper gộp exit code)
- `pnpm --filter @du/orchestrator test -- tests/admin-actions-vault04-offline.functional.test.ts tests/mock-vault-harness-offline.functional.test.ts`: **3 lần liên tiếp**, mỗi lần `Test Suites: 2 passed, 2 total` / `Tests: 40 passed, 40 total`, **Exit Code: 0** (Times 4.39s / 4.576s / 4.696s). Smoke trước cũng chính con số đó, xanh ngay lần đầu — không vòng đỏ: guards `noUncheckedIndexedAccess` (find `!`, không index-array bare) áp trước từ kinh nghiệm Muc 4.
- `pnpm --filter @du/orchestrator exec tsc --noEmit`: **3 lần**, output rỗng, mỗi lần **Exit Code: 0** (PGID 7344 / 32592 / 27080). Lưu ý kỹ: tsconfig orchestrator include=src, **tests không nằm trong lệnh typecheck này** (packet chọn đúng); test được ts-jest compile lúc chạy bằng base tsconfig strict (noUncheckedIndexedAccess có hiệu lực) — đã xanh thật ở lệnh test.
- Diff scope: `git status --porcelain -uall` trên 3 file đích trả `??` cho cả `workflow.ts` — **toàn cây du-rework untracked nên absence of ` M` ≠ absence of edits**; scope chu kỳ chứng minh bằng transcript: tool edit chỉ chạm 2 file test + file receipt này; `workflow.ts`/`connector-http-store.ts`/`dispatcher.ts` chỉ ĐỌC. Không commit/push, không DB/Redis window, không tick VAULT-06/SEC task rows.

### Còn mở
- Δ1–Δ6 (như cũ) + **Δ7, Δ8** — Reviewer adjudicate; Δ8 nếu chấp nhận cần packet src riêng (action name + masking).
- Live legs: PG migration 008, `/disable` connector thật (revokeAll semantics do Connector lane sở hữu), 2-replica concurrent rotation/outage matrix → Tester windows; G-SEC vẫn NO-GO.

---
Ledger:
- 1 — W-VAULT-BINDING-FIX-1: mock-vault harness BINDING_DENIED — 3 suites/52 tests x3 Exit Code 0, Δ1 mo — Muc 1.
- 2 — W-VAULT-POLICY-CANONICAL-1: contracts canonical-path + traversal — vault-policies.test.ts 45 tests x3 Exit Code 0, build Exit Code 0, full suite 14/283 Exit Code 0, Δ2 Δ3 mo — Muc 2.
- 3 — W-VAULT-CONNECTOR-ISOLATION-1: connector invoke-boundary isolation — 3 suites/45 tests x3 Exit Code 0 (baseline 38→45, +7 test), typecheck x3 Exit Code 0, Δ4 mo — Muc 3.
- 4 — W-VAULT-POLICY-HCL-IDENTITY-1: VAULT-02 HCL identity matrix — vault-policies.test.ts 45→62 (+17), build x3 Exit Code 0, full contracts suite 16/350 x3 Exit Code 0, drift guard infra byte-identical, Δ5 Δ6 mo — Muc 4.
- 5 — W-VAULT06-ROTATION-LIFECYCLE-1: VAULT-06 restart/reconcile PENDING + emergency revoke — admin 20→24, harness 13→16 (+7 test), targeted x3 40/40 Exit Code 0, tsc x3 Exit Code 0, src diff 0, Δ7 Δ8 mo — Muc 5.
