# MDB-POLICY-03 — Workflow Schema Policy Implementation (receipt)

- **Task:** `MDB-POLICY-03` — dispatch spec `du-rework/coordination/dispatch-specs/2026-10-10-MDB-POLICY-03-workflow-schema.md`.
- **Canonical plan:** `PLAN-OPEN-2026-10-09.md` §9.2/§9.3 (hạng 5) + `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7.
- **Repo scope:** `du-rework` (không sửa legacy root, không live DB/Redis/S3).
- **Lease:** `scripts/ldba-context-provider.cjs` (phần `prepareWorkflowSchema`) + test mới + receipt này.
- **Ngày:** 2026-10-10. **Owner:** lane MDB-POLICY-03 (Qwen). **Verifier:** chưa có (receipt này là intake).
- **Option đã chốt bởi coordinator:** **option 1 — expose pure prep API vào `ldba-context-provider.cjs`** (chỉ định trực tiếp của user), thay vì sửa `workflow-schemas.ts`.

---

## 0. VERDICT

**IMPLEMENTED · VERIFIED-OFFLINE · NOT ACCEPTED. 0 gate tick.**

| Hạng mục | Kết quả đo |
|---|---|
| Test mới `tests/mdb-policy-03-workflow-schema.test.cjs` | **17/17 pass, 0 fail, 0 skip — exit 0 ×3 lần liên tiếp** |
| `tsc --noEmit -p tsconfig.json` (orchestrator) | **exit 0** |
| `node --check` trên provider | **SYNTAX_OK** |
| Hygiene cả 2 file | **0 ký tự nháy kép · 0 trailing whitespace** |
| `tests/ldba-03-backfill-offline.test.cjs` | exit 0 (không đổi) |
| `tests/ldba-03-production-adapter.test.cjs` | exit 0 (không đổi) |
| `tests/ldba-03-runner-skip.test.cjs` | **exit 1 — 14/16 fail, nguyên nhân là guard timezone của packet LDBA-A1, KHÔNG phải packet này** (chứng minh ở §6.1) |
| `tests/mdb-policy-01-connector.test.cjs` | 19/20 — 1 red **đã có từ trước** do MDB-POLICY-02 (§6.2) |
| `tests/mdb-policy-02-profiles.test.cjs` | 18/19 — 1 red **do packet này, đúng thiết kế** (§6.3) |

---

## 1. Đã làm gì

`prepareWorkflowSchema(parsed, request)` trong `scripts/ldba-context-provider.cjs` từ stub `requireApprovedPolicy(...)` (throw `CONTEXT_POLICY_REQUIRED`) trở thành một policy thật, trả về đúng hai giá trị mà runner tiêu thụ (`ldba-03-backfill.cjs:669-676`):

```js
return sealWorkflowSchemaEnvelope(seamHandle, { schema, connectorSlotMap, approvedEgressOrigins }, tenantId, refId)
  .then((schemaRef) => ({ digest, schemaRef }));
```

Trình tự: kiểm tra `request` → `preflightWorkflowSchemaJson(parsed)` → `validateWorkflowSchema` → cấp `connectorSlotMap` → suy `approvedEgressOrigins` → tính `digest` → lấy seam (đồng bộ, fail-closed) → seal → trả `{ digest, schemaRef }`.

Mọi từ chối **throw đồng bộ** một `WorkflowSchemaPolicyError` có `.code` + `.callback = 'prepareWorkflowSchema'` (lý do ở §7 Δ1).

Giữ nguyên: `prepareConnector` (MDB-POLICY-01), `resolveProfileName` + `normalizeConnectionsOverride` (MDB-POLICY-02), và 4 callback còn lại vẫn fail-closed (`readFileCacheBytes` / `artifactTokenFor` / `artifactPurposeFor` → `CONTEXT_POLICY_REQUIRED`; `prepareAdminLocalUser` → `PASSWORD_RESET_REQUIRED`).

---

## 2. Bám byte theo nguồn production (không bịa)

| Thành phần | Mirror từ | Ghi chú |
|---|---|---|
| canonical JSON (sort key đệ quy, giữ thứ tự mảng) | `legacy-workflow.ts:395-406` (`canonicalLegacyWorkflowJsonBytes`) và `metadata-crypto.ts:187-199` (`canonicalizeMetadataJson`) | hai hàm này byte-identical; một helper dùng cho cả hai |
| `digest` = `sha256:` + sha256(canonical pin bytes) | `workflow-schemas.ts:70-76` → `legacy-workflow.ts:320-326` | pin = `{ schema, connectorSlotMap, approvedEgressOrigins: sorted }` |
| `connectorSlotMap` (`legacy-connector-00..31`, cấp từ slot trống đầu tiên, tên sort `localeCompare(..., 'en')`) | `legacy-workflow.ts:129-132, 152-162, 179-195` | revision 1 ⇒ không có prior map |
| AAD 32 byte = `sha256(tenantId|slot|refId)` | `metadata-crypto.ts:204-212` (`deriveAad`) | `slot = legacy_workflow_schemas.schema_ref` (`:65`), `refId = <slug>:<revision>` (`workflow-schemas.ts:62-68`) |
| envelope `SealedMetadata` (9 field: `version/algorithm/keyRef/dek/nonce/tag/aad/ciphertext/plaintextSha256`) | `metadata-crypto.ts:95-107, 306-335` | aes-256-gcm, DEK 32B, nonce 12B, tag 16B (`:35-37`) |

**Vì sao digest an toàn khỏi drift:** mọi object trong `LegacyWorkflowSchemaSchema` là `.passthrough()` và **không** object nào khai `.default()` (`legacy-workflow.ts:116-125`), nên zod trả về input **nguyên vẹn**; canonical bytes của policy = canonical bytes mà `parseStoredPin` (`workflow-schemas.ts:116-140`) tính lại lúc đọc.

**Hai ranh giới KHÔNG copy nguyên khối (ghi rõ để không hiểu sai):**

1. **Validator.** `parseLegacyWorkflowSchema` (`legacy-workflow.ts:257-296`) dựa trên zod và cần `@du/contracts` — package này có `main: dist/index.js` (`packages/contracts/package.json:6`) và **`dist/` KHÔNG được build trên cây này** (glob `packages/contracts/dist/index.js` → 0 hit; `services/orchestrator/dist/**` cũng 0 hit). Policy mirror phần **JavaScript thuần**: `preflightSchemaJson` (`:453-472`), `preflightNodeGraph` (`:409-431`), các bất biến đồ thị (`:268-296`) và yêu cầu field của từng member union (`:26-91`). Policy **strict**: chỉ nhận cái nó xác minh được. Hệ quả: nếu mirror lỏng hơn zod, hàng ghi ra sẽ bị `parseStoredPin` từ chối lúc đọc ⇒ **unreadable, không phải sai nội dung** (fail-closed).
2. **Khoá.** Seal cần `keyProvider.wrapDek` (`metadata-crypto.ts:226-229`) — trong deployment này là Vault Transit (`modules/encryption/vault-transit-provider.ts`), cần `vaultAddress` + 2 token tách quyền (`boot-options.ts:406-437`). `node:crypto` không thể wrap DEK cho reader unwrap qua Vault, nên seam được **tiêm vào** — đúng cách `createMetadataCrypto(keyProvider, keyRef)` làm (`metadata-crypto.ts:276-284`). Không có seam ⇒ **từ chối**, không bao giờ phát ra một envelope trông-như-sealed mà không reader nào mở được (như vậy sẽ qua shape check của runner `:669-676` và ghi một hàng catalog vĩnh viễn không đọc được).

---

## 3. Env contract mới (3 tên) — cần coordinator xác nhận

| Env | Ý nghĩa | Nguồn đối chiếu |
|---|---|---|
| `DU_ENCRYPTION_METADATA_ENABLED` | phải bằng `true` thì mới có seam; ngược lại từ chối `METADATA_SEAM_DISABLED` | **đã tồn tại** — mirror fail-closed #1 của `backfill-metadata-cli.ts:107-109` |
| `LDBA03_METADATA_SEAM_MODULE` | đường dẫn module export `wrapDek(dek, keyRef)` (hình dạng `MetadataKeyProvider`) | **MỚI** |
| `LDBA03_METADATA_KEY_REF` | keyRef metadata (tương ứng `boot.metadataEncryption.keyRef`) | **MỚI** |

Hai tên `LDBA03_METADATA_*` là hợp đồng mới, chưa có tiền lệ trong repo (grep `LDBA03_METADATA` → 0 hit). Đặt tên theo họ `LDBA03_*` sẵn có. Cần coordinator chốt hoặc đổi tên.

---

## 4. Chính sách egress (theo LDBA-06 R4)

Suy `approvedEgressOrigins` **từ chính URL tĩnh HTTPS mà schema đã khai** (`file_url_download.urls`, `callback.url`, đệ quy qua `parallel`), sort tăng dần. Từ chối thẳng (không tự phê duyệt) khi gặp: `DYNAMIC_EGRESS_URL` (binding `$...`), `NON_HTTPS_EGRESS_URL`, `EGRESS_URL_USERINFO`, `INVALID_EGRESS_URL` (không parse được / có fragment), `EGRESS_WITHOUT_URL`, `TOO_MANY_EGRESS_ORIGINS` (>16).

Đây là chính sách **chặt hơn** `validateLegacyWorkflowEgressOrigins` (`legacy-workflow.ts:329-370`, chỉ đòi approved non-empty khi có egress động/credential) ⇒ miền chấp nhận vẫn nằm trong contract. Khớp quyết định R4 ở plan `:319` (*derive từ URL tĩnh HTTPS, cấm bịa*).

---

## 5. Bằng chứng test (17 test, exit 0 ×3)

`tests/mdb-policy-03-workflow-schema.test.cjs` — seam tiêm là một module **tạm trong `os.tmpdir()`** do chính test ghi ra (không thêm file thứ ba vào repo).

| # | Test | Bắt gì |
|---|---|---|
| 1 | valid schema → digest + sealed envelope | shape + mở được envelope |
| 2 | digest = sha256 canonical pin bytes **của plaintext đã mở** | ràng buộc digest ↔ nội dung đã seal |
| 3 | digest không đổi khi đảo thứ tự key input | canonicalization thật sự chạy |
| 4 | cột sealed không mang plaintext nguồn | **non-vacuous**: sentinel phải CÓ trong plaintext đã mở và KHÔNG có trong cột |
| 5 | tenant/refId sai thì AAD khác | AAD có bind thật |
| 6 | slot map cấp theo thứ tự tên | `alpha→legacy-connector-00`, `zeta→…01` |
| 7 | origins suy từ URL tĩnh HTTPS | gồm cả nhánh `callback.url` là object có `url` |
| 8 | 16 ca schema hỏng → `INVALID_SCHEMA` | null, string, mảng, nodes rỗng, name rỗng, type lạ, thiếu id, id sai pattern, human thiếu `message`, flow trỏ sai, flow lặp, output trỏ sai, `input_schema` sai, slug sai, id trùng |
| 9 | slug khác key AppSetting → `KEY_SCHEMA_SLUG_MISMATCH` | |
| 10 | 6 ca request hỏng → `INVALID_SOURCE` | null/undefined/{}/slug rỗng/tenant rỗng/revision 2 |
| 11 | 6 ca egress → 5 mã riêng | xem §4 |
| 12 | không seam → 4 mã riêng | `METADATA_SEAM_DISABLED`, `METADATA_SEAM_MODULE_REQUIRED`, `METADATA_KEY_REF_REQUIRED`, `METADATA_SEAM_LOAD_FAILED` |
| 13 | `prepareConnector` vẫn map được row | regression MDB-POLICY-01 |
| 14 | `prepareConnector` vẫn từ chối header credential | pin finding Δ6 |
| 15 | `resolveProfileName` + `normalizeConnectionsOverride` vẫn trả lời | regression MDB-POLICY-02 |
| 16 | 3 callback còn lại + `prepareAdminLocalUser` vẫn fail-closed | |
| 17 | boot contract: 8 callback đều là function | |

---

## 6. Đo 3 suite liên quan + 2 suite tiền nhiệm

### 6.1 `ldba-03-runner-skip.test.cjs` — ĐỎ, nhưng KHÔNG do packet này

Chạy trần: **16 test / 2 pass / 14 fail, exit 1**. Cả 14 fail là **cùng một** sai lệch: `report.status` là `BLOCKED_TIMEZONE_UNVERIFIED` thay vì `APPLIED` / `BLOCKED_TRANSFORM` / `BLOCKED_SKIPPED_ROWS`.

**Chứng minh nguyên nhân (không suy đoán):** chạy lại với `LDBA_ALLOW_UNVERIFIED_TIMEZONE=1` ⇒ **16/16 pass, 0 fail**. Trạng thái đó chỉ do `timezoneGuardFailure` (`ldba-03-backfill.cjs:938-948`) đặt, và nó chạy **trước** mọi mapper (`:1000`) — tức guard A1 của packet LDBA-A1 chặn lượt chạy trước khi `prepareWorkflowSchema` được gọi. Thay đổi của packet này **không thể** tạo ra mã lỗi đó.

> Bẫy cmd.exe đã gặp khi thử lần đầu: `set VAR=1 && node ...` đặt biến thành `1 ` (có khoảng trắng cuối) nên so sánh `=== '1'` trượt. Lần chạy đúng phải là `set VAR=1&&node ...`.

### 6.2 `mdb-policy-01-connector.test.cjs` — 19/20, red đã có từ trước

Red duy nhất ở `:292` (`every other context callback stays fail-closed until its own policy lands`), lỗi `Missing expected exception` tại `:297`. Vòng lặp ở `:294-297` bắt đầu bằng `resolveProfileName` — callback **đã landed ở MDB-POLICY-02**, nên `provider.resolveProfileName({}, {})` trả `''` chứ không throw ⇒ assertion đổ **ngay vòng lặp đầu**, trước khi chạm `prepareWorkflowSchema`. Đây là red MDB-POLICY-02 để lại (đã ghi nhận trong memory của fleet), không phải packet này.

### 6.3 `mdb-policy-02-profiles.test.cjs` — 18/19, red do packet này, ĐÚNG thiết kế

Red ở `:216` (`the five remaining callbacks stay fail-closed`): `actual: 'INVALID_SOURCE'`, `expected: 'CONTEXT_POLICY_REQUIRED'`. Đây là hệ quả **bắt buộc** của việc land một policy: guard của packet trước khẳng định callback còn là stub. **Không tự sửa** (file ngoài lease). Ghi nhận là Δ-DEVIATION cho coordinator.

### 6.4 Không đo trong lượt này

`tests/mdb-01-composition-provider.test.ts` (jest/TS) — **không chạy**. Theo ghi nhận của fleet nó đã đỏ từ MDB-POLICY-01 (`:41`); trạng thái hiện tại **chưa được đo lại ở đây** và không được khẳng định.

---

## 7. Δ-DEVIATION + finding cho coordinator

**Δ1 — Refusal là THROW, không phải `{ skipped: true, reason }` như spec §2.1.** Runner **không có** kênh skip cho `AppSetting`: `mapWorkflowSetting` (`ldba-03-backfill.cjs:658-687`) không có nhánh skip nào (khác `mapConnector` `:477-486`), và `SKIP_POLICIES` (`:79-93`) chỉ liệt kê **4 bảng** — **không có `AppSetting`**. Nên kể cả có nhánh skip, một `RowSkip` cho `AppSetting` sẽ thành `UNAPPROVED_SKIP` ⇒ `recordFailure` ⇒ `BLOCKED_TRANSFORM`. Trả `{skipped:true}` chỉ khiến runner báo `INVALID_WORKFLOW_ADAPTER_OUTPUT` và **che mất lý do thật**. Vì vậy policy throw có mã riêng, để report hiện đúng nguyên nhân.

**Δ2 — Packet này tạo một đường tự bọc envelope, trong khi plan đã chốt ngược lại.** `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:330` ghi rõ: *writer production `provisionLegacyWorkflowSchema` là nguồn chân lý ghi catalog — adapter workflow schema phải delegate cho nó, **không tự bọc envelope***; LDBA-06 R4 (`:319`) đã ACCEPTED theo đúng tinh thần đó. Việc đặt digest+seal trong provider là **option 1 do coordinator chọn trực tiếp**, nên đây là quyết định của coordinator, không phải lane tự chọn — nhưng **cần được ghi vào plan** để lần sau không ai đọc `:330` rồi cho rằng packet này vi phạm.

**Δ3 — Validator là mirror strict, không phải zod.** Miền chấp nhận của policy là **tập con** của zod (strict hơn ở egress; đòi đủ field bắt buộc; kiểm enum/bound khi field có mặt). Rủi ro còn lại: một schema mà zod **từ chối** nhưng policy **nhận** ⇒ hàng ghi ra sẽ bị `parseStoredPin` từ chối lúc đọc (unreadable, fail-closed). Không có ca nào như vậy trong 17 test.

**Δ4 — Seal cần seam thật ⇒ offline luôn từ chối.** Muốn chạy thật phải có (a) module wrap Vault-backed và (b) `dist` của `@du/contracts`/service được đóng gói vào runtime image — CR10-01 vừa cho thấy `scripts/` **không** được pack mặc định, nên đóng gói là việc riêng, chưa làm ở đây.

**Δ5 — 3 env mới** (§3), 2 trong đó chưa có tiền lệ.

**Δ6 — FINDING (không phải lỗi packet này):** `prepareConnector` (MDB-POLICY-01) đưa `x-api-key` vào `SECRET_HEADER_NAMES`, nên **header mặc định của legacy** (`lib/db/schema.ts:56`, `authKeyHeader` default `x-api-key`) bị từ chối `INVALID_AUTH_HEADER` ⇒ mọi connector legacy dùng default **không migrate được** dưới policy đó. Đã pin thành test riêng (test #14) để lane sau không phát hiện lại từ đầu.

---

## 8. Ranh giới / không làm

- **Không** sửa `ldba-03-backfill.cjs`, `ldba-03-production-adapter.cjs`, `workflow-schemas.ts`, contracts, migration, hay test của lane khác.
- **Không** mở DB/Redis/S3, **không** chạy container, **không** live window.
- **Không** `git add` / `commit` / `push` / `reset`. **Không** tick gate nào.
- `prepareWorkflowSchema` là hàm **đồng bộ** trả Promise ở nhánh thành công: mọi từ chối là throw đồng bộ (một row failure của runner), nhánh seal mới async — khớp `asyncContext` của adapter (`ldba-03-production-adapter.cjs:652`).

---

## 9. Hash + hygiene (ràng buộc phiên bản)

| File | sha256 |
|---|---|
| `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` | `b1b1adebea7fa6b3a28e55dbb4e344d27a6db856302c851eda93599f5d935bf9` |
| `orchestrator/services/orchestrator/tests/mdb-policy-03-workflow-schema.test.cjs` | `af06ea2cfc9e7b7dba4c751eb741f62d58cee89ce555fe66514b812d18a70610` |

Cả hai file **untracked** (`??`) ⇒ verify chỉ gắn với working tree tại thời điểm này; đổi file là hết hiệu lực.

---

## RESUME POINT (lượt sau)

- **Task:** MDB-POLICY-03. **Trạng thái:** IMPLEMENTED · VERIFIED-OFFLINE · **NOT ACCEPTED** · 0 gate tick.
- **Đã đóng:** `prepareWorkflowSchema` thật (digest canonical-pin + envelope SealedMetadata + AAD triple), 17/17 ×3 exit 0, tsc 0, node --check 0, hygiene 0/0.
- **Còn mở cho coordinator:** Δ1 (throw thay vì skip — cần chốt hoặc bổ sung kênh skip cho `AppSetting`), Δ2 (ghi quyết định option 1 vào plan `:330`), Δ4 (đóng gói contracts/dist + seam Vault), Δ5 (3 env), Δ6 (finding `x-api-key`).
- **Red cần adjudicate, KHÔNG tự sửa:** `mdb-policy-02-profiles.test.cjs:216` (do packet này) và `mdb-policy-01-connector.test.cjs:292` (đã có từ MDB-POLICY-02). `ldba-03-runner-skip.test.cjs` đỏ vì guard timezone A1 — **không phải** packet này (chứng minh: 16/16 với `LDBA_ALLOW_UNVERIFIED_TIMEZONE=1`).
- **Bước tiếp theo đề xuất:** independent verify (lane khác) trên 2 sha256 ở §9, rồi coordinator chốt Δ1/Δ2.
