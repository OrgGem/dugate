# DISPATCH SPEC: WFA-HANDOVER — tiếp quản Workflow API từ Codex fleet

- Task: `WFA-HANDOVER` (canonical plan: `du-rework/tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §6, acceptance WFA-T01..T38)
- Assigned Agent: **qwen_2** (`term_4bca69af-a9d5-40f4-8dac-2edb1853dbac`)
- Role: WFA implementation + verification owner (kế tiếp Codex fleet)
- Status: DISPATCHED / LEASE_ASSIGNED
- Repo scope: `du-rework` (không đụng legacy root)
- Directives:
  - **Do NOT commit, do NOT push** (giữ nguyên code freeze của WFA plan §1).
  - Không tự sửa hành vi khi chưa có test fail‑trước (fail-first cho mọi fix mới).
  - **Không** hand-edit `du-rework/docs/21-openapi.json` — regenerate qua `tools/openapi/gen_openapi.py`.
  - Trước khi sửa file thuộc lease cũ của `/root/workflow_api` hoặc `/root/workflow_runtime`, kiểm tra lane đó đã idle (Codex đã chạm usage limit tối 07/10; xác minh bằng `git status` không có write mới + không có jest đang chạy) rồi ghi "lease takeover" vào receipt.

---

## 1. Bối cảnh handover

Codex đã chạy 3 subagents song song (`gpt-6-luna`, reasoning max) theo WFA plan:

| Agent | Lease cũ | Trạng thái lúc bàn giao |
|---|---|---|
| `/root/workflow_api` (Linnaeus) | WFA-01/02: contract report, compat/public/bootstrap/operation + `wfa-api-*` tests | Implementation xong, báo rerun 67/67 sau 4 RV01 fail |
| `/root/workflow_runtime` (Aristotle) | WFA-03: contracts/catalog/migration, worker/manifest/named adapters + `wfa-runtime-*` tests | 10/10 node adapters xong, còn bounds/traversal/SSRF hardening |
| `/root/workflow_verify` (Planck) | WFA-04: `tests/workflow-api/` + verification report, product source read-only | Partial evidence; receipt mới nhất `schema-worker-full-after-owner-patches` 8/8 |

Log Codex gốc (đọc khi cần đối chiếu, không cần đọc hết):
`%APPDATA%/orca/codex-runtime-home/home/sessions/2026/10/07/rollout-*.jsonl` (3 files, agents workflow_api/workflow_runtime/workflow_verify).
Reports: `du-rework/coordination/reports/wfa-api-contract-2026-10-07.md`, `wfa-integration-2026-10-07.md`, `wfa-verification-2026-10-07.md`.

## 2. State đã DONE (xác minh trên disk 07/10, không cần làm lại)

**WFA-02 admission (orchestrator):**
- `src/compat/legacy-http-mount.ts:501-595` — handler workflows/workflows-schema đầy đủ: auth → multipart → decode → `host.submitLegacyWorkflow` → **202** + `Operation-Location` + envelope `{name, done:false, metadata:{state RUNNING, workflow, progress_percent 0}}`. 503 chỉ còn khi chưa wire host (`:566-567`) — không phải stub mặc định.
- `src/compat/legacy-workflow-decoders.ts:53-160` — decode named (3 process, ≥1 file, `resolution_data` chỉ disbursement) + schema (input JSON object, fileless OK), thứ tự file `files[] → source_file → target_file → file`, cap 64.
- `src/compat/legacy-public-artifact.ts:63-124` + `src/modules/artifacts/artifacts.ts:924-934,1108-1131` — encrypted upload + compensation cleanup khi admission fail.
- `src/modules/operations/submission.ts:233-303,493-499,530-695` — preflight (MetadataCrypto gate, bindings, schema pin + slot map), seal + persist snapshot trong 1 tx.
- Tests `tests/wfa-api-preflight/lifecycle/artifact-encryption/key-fence.test.ts` — 19 its, không skip/TODO.

**WFA-03 runtime:**
- `packages/contracts/src/legacy-workflow.ts` — union 10 node types (`:30-93`), bounds (`:10-14`), graph check (`:257-296`), 32-slot map + allocate giữ assignment cũ (`:135-195`), pin bất biến + digest (`:197-206,320-326`), egress policy (`:329-370`).
- `src/modules/workflow-schemas/workflow-schemas.ts` — resolve/provision (CAS expectedRevision, advisory lock, kế thừa slot map)/retire; migration `migrations/0037_legacy_workflow_schema_catalog.sql` (FK uuid đã đúng, lỗi type cũ đã fix).
- `businesses/document-core/.../workflows/schema/legacy-schema-runtime.ts` — **10/10 node có handler thật** (parallel/human/input/join/connector/file_parse/file_url_download/callback/archive_compress/archive_extract). Không TODO/stub.
- Named adapters thật: `legacy-named-disbursement.ts`, `legacy-named-doc-compare.ts`, `businesses/lc-checker/src/legacy-workflow.ts:370-520` + discriminant 3 lớp (manifest `lc-checker/src/manifest.ts:67-87`, router `worker.ts:397`, validator `:78-134`).

**Verification đã có evidence:** T04..T13 (admission/reject, no-side-effect), T29..T32 (auth/fence), T14 pin + T37 catalog fresh-DB, T16/T17 parallel/join, T23/T24 human/input, input-only pin/result/download, one-file doc-compare async-fail, paused cancel, encryption refusal.
OpenAPI v1.5.0 đã generate 60 paths / validate exit 0 (`tools/openapi/*`, `docs/21-openapi.json:5,3625,3794`).

## 3. Việc còn lại (theo thứ tự ưu tiên)

| # | Acceptance | Việc làm | Điểm chạm |
|---|---|---|---|
| 1 | T01/T02 | **Named success E2E**: disbursement + lc-checker qua HTTP → worker → poll/result/download, fail-first test | `tests/workflow-api/http-worker.integration.test.ts` + named adapters §2 |
| 2 | T03 | doc-compare **2-file success** (hiện chỉ có nhánh 1-file async-fail) | cùng file trên |
| 3 | T15,T18..T22 | 6 leaf nodes worker evidence: `connector`, `file_parse`, `file_url_download`, `callback`, `archive_compress`, `archive_extract` (mock local + bounds/traversal/SSRF fences) | `legacy-schema-runtime.ts:726-1097` |
| 4 | T26/T27 | retry-idempotency (không lặp side-effect) + cancel có children/provider in-flight | runtime + lifecycle |
| 5 | Ổn định | Rerun **full** `http-worker.integration.test.ts` không `-t` filter, thay receipt 6+2 cũ bằng pass ổn định | harness §4 |
| 6 | Fix nhỏ | (a) `loadLegacyOutput` file-backend → 404 `No Output` (`legacy-host-adapter.ts:591-599` chỉ nhánh inline); (b) `GET /api/v1/services` 500 thiếu `serviceCatalogue` (`legacy-http-mount.ts:887-904`); (c) poll có thể trả `WAITING_INPUT` thay vì `WAITING_USER_INPUT` khi thiếu workflow marker (`legacy-host-adapter.ts:36-38,429-437` — map đã có nhưng conditional); (d) `join merge` đang = concat (`legacy-schema-runtime.ts:277-288`); (e) docs stale: `06-public-api.md:29`, `39:30-32` (services/billing ghi chưa implement nhưng code đã có handler), `06:15`, `06:44` (`?sync`/Idempotency-Key đúng cho workflow routes, sai cho 6 core actions) | từng file ghi trên |
| 7 | T38/WFA-06 | Regen + validate OpenAPI, cập nhật parity docs phân biệt verified vs exception | `tools/openapi/*`, `docs/06-public-api.md`, `docs/39-legacy-parity-contract.md` |

Không mở rộng scope: Portal/Workflow Builder, public API mới, provider trả phí, production cutover đều non-goals (WFA plan §1).

## 4. Harness kiểm tra

- Node `>=24.21.0 <25`, pnpm 10.18.3; chạy từ canonical paths.
- Isolated infra (containers verifier-owned, còn chạy thì tái dùng, mất thì dựng lại theo `tests/workflow-api/isolation.ts`): PG `du-wfa-20261007-55498-pg` @ `127.0.0.1:55498`, Redis `du-wfa-20261007-56398-redis` @ `127.0.0.1:56398`; unique PG schema + non-default Redis DB; synthetic docs + loopback mock providers; không đụng production/legacy DB.
- Worker suite: `node <node24>/node.exe tests/workflow-api/run-jest.cjs <log-name> tests/workflow-api/http-worker.integration.test.ts` từ `du-rework/`.
- Owner suites: `cd services/orchestrator && node node_modules/jest/bin/jest.js --runInBand tests/wfa-api-*.test.ts tests/wfa-runtime-*.test.ts tests/legacy-http-mount.test.ts tests/rv01-loopback-http-offline.test.ts`.
- Xong việc mới stop 2 containers verifier-owned.

## 5. Bàn giao

- Receipt: `du-rework/coordination/reports/wfa-qwen-handover-2026-10-07.md`; raw logs tại `du-rework/tests/workflow-api/logs/` (đặt tên `<case>-node24-2026-10-07.log`, giữ cả receipt fail-đầu như thông lệ WFA-04).
- Evidence mỗi receipt: command + cwd + Node version + exit code + passed/failed/skipped + test IDs (WFA-Txx).
- Đồng bộ `docs/19-traceability-audit-matrix.md`, `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md` cho test/contract mới.
- Independent review trước release vẫn do lane khác làm (WFA plan §8); không tự tick ACCEPTED.
