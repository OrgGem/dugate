# COMP09-WORKFLOW-BRIEF — workflow evidence brief cho COMP-09 / PAR00-J05 (READ-ONLY)

**TaskRef:** task_15575c1b3916
**Spec:** `coordination/dispatch-specs/2026-10-02-0245-COMP09-workflow-brief.md`
**Status:** brief tổng hợp read-only. KHÔNG tự map `process→business/action` hay `schemaSlug→schema business`; KHÔNG code; KHÔNG đề xuất route/endpoint/schema mới; KHÔNG đọc sâu source để tự verify (chỉ dùng receipts + tasks/plan theo spec). Chỉ ghi đúng file receipt này; không tick gate; không commit; không nhắn `nocobase-10`; không đọc giá trị secret.

**Nguồn dùng (đúng allow-list của spec):**
- Slice-E: `coordination/reports/codex-comp01-slice-e-webhook-callback-inventory-2026-10-02.md`
- Slice-G: `coordination/reports/codex-comp01-slice-g-workflow-schema-services-billing-2026-10-02.md`
- Slice-C (phần workflow §4–§5): `coordination/reports/codex-comp01-slice-c-output-action-map-2026-10-02.md`
- `tasks/API-COMPAT-DUGATE-2026-09-28.md` dòng 55–121 (COMP rows, bằng chứng COMP-09 dòng 110–115, điều kiện mount 119–121)
- `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` dòng 28–43 (J05) + 55–61 (PAR00-M04) + dòng 39 (gate)

Mọi trích dẫn dưới đây là **factual từ receipts/tasks**; các mục MUST-NOT-REPLICATE chỉ ghi nhận hiện tượng + yêu cầu không tái hiện, không mô tả cách dựng lại.

---

## 1. Bảng 3 workflow × evidence / mapping status / constraint

`Mapping status` = trạng thái alias `process→business/action` trong rework theo `API-COMPAT:114`: cả 3 = **ABSENT** (`businesses/document-core/src/pipelines/legacy-workflow-mapping.ts` không chứa `disbursement`/`lc-checker`/`doc-compare`; `resolveLegacySchemaSlug` chỉ có trong test + file của nó, chưa mount).

| Workflow (`process`) | Evidence hành vi legacy (từ receipts) | Mapping status (rework) | Constraint đã biết (selector-integrity / identity / file-count) |
|---|---|---|---|
| `disbursement` | Process registry + là workflow duy nhất khai báo `resolution_data` (slice-C §4, `registry.ts:372-402`); kết quả parent: report text → `outputContent`, crosscheck object → `extractedData`, `stepsResultJson` (slice-C §4: `disbursement.ts:234-259`; `workflow-engine.ts:216-230`); có HITL pause → `WAITING_USER_INPUT` (slice-E §2: `workflow-engine.ts:246-271`); webhook terminal PAUSED/SUCCEEDED/FAILED là single-shot, không retry/timeout, không signature (slice-E §2) | **ABSENT** (alias) — nhưng **business implementation PRESENT**: manifest action `disbursement` (`document-core.manifest.ts:243-247,322-327`), recipe `recipe-disbursement-workflow-v1` (`recipe-definitions.ts:425-439`), artifact `disbursement-result.json` (`worker.ts:1162-1186`) (slice-C §4) | **identity:** FORM field `apiKeyId` + ADMIN fallback (`API-COMPAT:113`: `route.ts:49-56,74-85`); **selector-integrity:** không áp cho `process` selector (đi qua registry check — slice-C §4: `registry.ts:372-402`); vấn đề `input.schemaSlug` override chỉ thuộc schema route (§2); **file-count:** không có constraint riêng được ghi nhận trong nguồn cited |
| `lc-checker` | Report text + LC-check object → `completeWorkflow` (slice-C §4: `lc-checker.ts:168-209`; `workflow-engine.ts:216-230`) | **ABSENT cả alias lẫn named action/recipe**: không có trong manifest 6 core + disbursement, không có recipe workflow tương ứng (slice-C §4: `manifest.ts:26-333`; `recipe-definitions.ts:425-457`; `API-COMPAT:114`) | **identity:** FORM + ADMIN fallback (`API-COMPAT:113`); **selector-integrity:** N/A theo evidence hiện có; **file-count:** không có evidence trong nguồn cited |
| `doc-compare` | Report text + compare result → `completeWorkflow` (slice-C §4: `doc-compare.ts:196-224`; `workflow-engine.ts:216-230`) | **ABSENT cả alias lẫn named workflow**: rework `compare` chỉ có 6 variant core action/recipe riêng, không phải `doc-compare` workflow (`API-COMPAT:114`; slice-C §4: `manifest.ts:209-240,243-333`; `recipe-definitions.ts:387-422,425-457`) | **file-count (điểm nóng):** nhận 1 file tại HTTP boundary nhưng workflow yêu cầu ≥2 (`doc-compare.ts:46-56`) → tạo Operation rồi fail **bất đồng bộ**; **không có upper bound file** (`API-COMPAT:115`); **identity:** FORM + ADMIN fallback (`API-COMPAT:113`) |

**Chung cho cả 3 workflow (slice-E):**
- Route workflow (`app/api/v1/docs/workflows`, `/docs/workflows/schema`) **không đọc field webhook nào** → terminal webhook của workflow-engine **không reachable qua HTTP**; README hướng dẫn field `webhookUrl` sai so với handler (slice-E §1, §7).
- Terminal webhook workflow: 1 lần fetch, không kiểm tra status, không timeout, không retry; `webhookSentAt` set cho mọi HTTP response (slice-E §2).
- Mọi callback legacy đều **unsigned**, destination không validate (slice-E §2, §8) — chỉ ghi nhận MUST-NOT-REPLICATE.

---

## 2. Schema workflow (từ slice-G) × gap cho PAR00-J05

**PAR00-J05 yêu cầu (ORCH-PAR:36):** versioned schema **catalog/import/validate/publish/resolve `schemaSlug`** qua **Admin API hoặc migration/bootstrap có receipt**; candidate **Admin URL riêng, KHÔNG dùng public `/api/v1/docs/workflows/schema`**; test: import schema đang dùng → publish → public submit → result/HITL; **XML XXE/DTD/graph invalid fail-closed**; visual builder là CONDITIONAL.
**PAR00-M04 actual (ORCH-PAR:59):** orchestrator **không có Admin schema catalog route/table** theo source search; legacy chỉ có `app/api/internal/workflow-schemas/route.ts:13,28,57`.

| Năng lực hiện có (slice-G) | Evidence | Gap so với J05 |
|---|---|---|
| CRUD nội bộ `/api/internal/workflow-schemas`: list, detail `?slug`, save/upsert, delete; guard `requireAdmin` | slice-G §1 (`route.ts:14,19-25,29,44-50,58-64`) | Không có **version/revision** (không list version, không publish/deprecate/rollback); không có **resolve theo version** |
| Save = **upsert, không create**: trùng slug ghi đè im lặng, không so version, không conflict response; body `{schema}` hoặc `{xml}`, **XML thắng khi có cả hai** | slice-G §1 (`:36-39,49-51`) | J05 cần catalog **versioned + publish**; cần decision semantics khi trùng slug (không tự đề xuất cơ chế) |
| Validate `V1–V8` (object/slug/flow-nonempty/nodes-array/duplicate-id/10 type/connector-slug/flow-resolve); **KHÔNG check**: connector tồn tại, `$binding` resolve, `name`, acyclicity/`parallel` termination, `input_schema`, `join.combine` enum, numeric bounds, `allowedExtensions` | slice-G §1.1 (`interpreter.ts:38-70`; list "do NOT check") | J05 test **graph invalid fail-closed** chưa có evidence tương ứng; V1–V8 không cover cycle/graph |
| XML import `xmlToSchema` (10 type, `@_` prefix; unknown type throw; `<nodes>` thiếu throw; property thiếu `name` bị bỏ; `required` chỉ true khi chuỗi `"true"`); **XML export không có route** (`schemaToXml` chỉ dùng trong test) | slice-G §1.3 (`xml-converter.ts:14-173,246`; test ref) | J05 test **XXE/DTD fail-closed**: không thấy cơ chế nào trong V1–V8/xmlToSchema được slice-G chứng minh; cần evidence fail-closed trước khi J05 ký |
| Versioning: `version` chỉ default 1 ở đường XML (`Number()`, `:160`); JSON path lưu nguyên giá trị body (kể cả absent); không có endpoint version | slice-G §1.3–§1.4, MISMATCH G-04 (`workflow-schema-guide.md:46` vs `route.ts:38-39`) | J05 cần nguồn **versioned published** — hiện chỉ là 1 field tự do trong JSON, không catalog version |
| Storage: 1 row `AppSetting` key `wb_schema:<slug>`; **không sanitisation** slug (không lowercase/charset/length/separator); read JSON hỏng → `null` (coi như absent); delete không check tồn tại; list scan toàn bộ AppSetting theo prefix | slice-G §1.2 (`loader.ts:10,13,20-37,39-52`) | Không phải catalog/table chuyên dụng; M04 actual xác nhận orchestrator chưa có route/table Admin schema catalog |
| Override per-node (`PUT …/override`): merge 5 field (`prompt/staticFormFields/extraHeaders/responseContentPath/timeoutSec`); **re-save không re-validate** | slice-G §3.1 (`override/route.ts:15-46`) | Mọi thay đổi schema có thể đi vòng qua validate; J05 publish semantics cần xét (chờ COMP-09/COMP-00, không tự đề xuất) |
| UI builder (`app/workflow-builder/page.tsx`): list/import/delete/override qua internal routes (`requireAdmin`); run dùng `submitRunSchema` → public `/api/v1/docs/workflows/schema`, hoặc `submitDuAdapterFlow` khi `decideRunEngine` chọn | slice-G §1.4 (`page.tsx:159-224,298-318`; `run-schema-client.ts:92-100`) | J05 cấm candidate public `/api/v1/docs/workflows/schema` cho control plane — run path hiện tại đúng là public route (thuộc COMP-09, chưa mở) |
| Server không enforce required-field của `input_schema` (chỉ browser check `findMissingRequiredField`); `schema.useDuAdapter` không thuộc `WorkflowSchema`, không validate, đi thẳng vào JSON đã lưu | slice-G §1.4, MISMATCH G-08/G-09 (`run-schema-client.ts:70-83`; `schema/route.ts:40-48`; `types.ts:157-168`) | J05 "schema đang dùng" cần nguồn tin cậy; hiện UI-only checks không phải server enforcement |

**Selector-integrity (factual, API-COMPAT:112):** `app/api/v1/docs/workflows/schema/route.ts:50-56` gộp `variables: { schemaSlug, ...input }` → `input.schemaSlug` **ghi đè** slug đã validate; `workflow-engine.ts:439-449` dispatch theo `ctx.pipelineVars.schemaSlug`. COMP-09 khi map **bắt buộc** bind execution vào slug đã validate, không tin field client (đây là constraint kế thừa, không phải đề xuất mới).

---

## 3. MUST-NOT-REPLICATE cho COMP-09 (kế thừa API-COMPAT:112–115 + slice-E + slice-G)

1. **Selector override:** không spread `input` đè lên `schemaSlug` đã validate; execution phải bind vào slug validated (`API-COMPAT:112`; `schema/route.ts:50-56`; `workflow-engine.ts:439-449`).
2. **Identity qua FORM + ADMIN fallback:** không nhận `apiKeyId` từ form; không fallback ADMIN key cũ nhất; rework phải dùng `resolveApiKey` (hash của `x-api-key`) (`API-COMPAT:113`: `route.ts:49-56,74-85`; `schema/route.ts:76-79`). Chỉ ghi nhận factual, không mô tả cách tái hiện.
3. **Identity tin theo header biên (`x-api-key-id`) cho services/billing:** slice-G §5 ghi nhận cơ chế này là MUST-NOT-REPLICATE (kế thừa slice-A §7); không mang sang projection COMP-08/COMP-09.
4. **Doc-compare boundary divergence:** nhận 1 file nhưng yêu cầu ≥2 → Operation tạo rồi fail async, không upper bound file (`API-COMPAT:115`); không mang behavior này vào mapping/COMP-09 (không tự đề xuất cơ chế thay thế — chờ COMP-00/P9 owner).
5. **Webhook/callback legacy (slice-E §8):** unsigned, không delivery-id, không HMAC; destination không validate (SSRF); workflow path không timeout/retry/status-check; per-node `callback` có thể chứa secret inline trong schema JSON lưu AppSetting `wb_schema:<slug>`; duplicate-delivery có thể xảy ra khi job bị re-queue.
6. **UI-only enforcement (slice-G G-08/G-09):** không coi browser check (required field, engine selector `useDuAdapter` không nằm trong `WorkflowSchema`) là server enforcement khi map schema workflow.
7. **Fake terminal state / không giả CANCELLED / list-no-resolve / plaintext fallback / ADMIN fallback:** kế thừa COMMON của spec này (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback, fake CANCELLED — ghi nhận thêm tại slice-E §8) — giữ nguyên nguyên tắc không tái hiện.

---

## 4. Điều kiện mở COMP-09 (liệt kê — không tự mở, không tick)

1. **COMP-00 chốt các decision còn treo** (`API-COMPAT:121`): URL generic mới, result materialization, lifecycle truth, **bảo mật khi legacy gửi identity field**, rollout encryption. Chỉ sau đó mới mở `COMP-02` + route integration.
2. **P9-01..04 hoàn tất business implementations** — COMP-09 row hiện ghi `READY-BUSINESS; public mount blocked`, dependency "business implementation P9-01..04; public mount cần COMP-02" (`API-COMPAT:97`); 3 mapping workflow giao `COMP-09 + P9-01..03 khi COMP-00 mở` (`API-COMPAT:114`).
3. **Contract/route freeze cho schema control plane** (`ORCH-PAR:36`): J05 cần versioned catalog/import/validate/publish/resolve qua **Admin API riêng hoặc migration/bootstrap có receipt**, không dùng public `/api/v1/docs/workflows/schema`; candidate wire **chưa phải public spec** (`ORCH-PAR:28`) và dependency register của PAR-00 phải xác nhận (`ORCH-PAR:39`).
4. **PAR00-M04 (schema catalog):** nguồn schema versioned đã publish cho P9 worker — hiện orchestrator chưa có route/table tương ứng (`ORCH-PAR:59`); J05 gắn `PAR-04` (control plane), `P9-04` (execution), `COMP-09` (public mapping).
5. **Gate:** `G-COMP` vẫn bắt buộc cho 6 core/31 variant + 3 workflow + schema + operations/public auxiliary; `PAR00-J02..J05` chỉ gắn dạng upstream provisioning fixture khi PAR-00 xác nhận (`ORCH-PAR:39`). Không tick gate ở receipt này.
6. **Test acceptance J05 khi được mở** (`ORCH-PAR:36`): import schema đang dùng → publish → public submit → result/HITL; XML XXE/DTD/graph invalid fail-closed; visual builder/interactive editing là CONDITIONAL, không phải điều kiện port public wire.

---

## 5. Scope / giới hạn

- Chỉ đọc: 3 receipts (E/G/C), 2 file tasks trong allow-list (trích dòng), không đọc source để tự verify, không chạy lệnh, không test. Không sửa file nào ngoài receipt này.
- Không tự map `process→business/action` / `schemaSlug→schema business`; không đề xuất route/endpoint/schema mới; các mục "gap" ở §2 chỉ là đối chiếu với yêu cầu J05 đã có, không phải thiết kế.
- Không tick gate, không commit, không nhắn `nocobase-10`, không đọc giá trị secret/key thật.
- TaskRef `task_15575c1b3916` không có trong task ledger cục bộ của agent này (đã kiểm tra `task_get` — không tìm thấy); receipt này là deliverable duy nhất.

## Verdict (readiness brief)

- **3 workflow:** mapping `process→business/action` = ABSENT cả 3; disbursement có business implementation (action+recipe+artifact), lc-checker/doc-compare chưa có registration nào được inspect thấy; doc-compare có divergence file-count tại boundary; cả 3 dính identity FORM+ADMIN fallback (MUST-NOT-REPLICATE) và webhook legacy unsigned/không retry (slice-E).
- **Schema workflow:** có CRUD nội bộ + validate V1–V8 + import XML (import-only) + storage `wb_schema:<slug>`; **thiếu** versioning/publish/resolve, graph/XXE/DTD fail-closed evidence, sanitisation slug, và server-side enforcement — là các gap phải đóng trước khi PAR00-J05 ký và COMP-09 mở mapping.
- **Điều kiện mở:** COMP-00 (5 decision) + P9-01..04 + contract/route freeze cho schema control plane + dependency register xác nhận; giữ nguyên trạng thái BLOCKED/READY-BUSINESS, không tick.
