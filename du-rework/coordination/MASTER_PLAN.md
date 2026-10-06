# Master Plan — decision/status intake

Cập nhật: 2026-10-06. Nguồn phán quyết: [Claude Reviewer, Section 11](reports/claude-audit-review-r4-2026-10-06.md#11-decision--direction-2026-10-06--bake-r41--f-vfysc1-01--f-vfy6-01-review-only-no-code-touched). File này tổng hợp quyết định và gate; task/dependency/acceptance chi tiết vẫn theo [DU Platform migration plan](../tasks/DU-PLATFORM-MIGRATION-2026-10-05.md), [Secret Catalog plan](../tasks/SECRET-CATALOG-2026-10-06.md) và [persistence policy plan](../tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md).

## Bảng trạng thái quyết định — Claude Section 11

| Decision | Phán quyết / phạm vi được duyệt | Đã code / đã verify / đã accept | Điều kiện còn mở / next owner |
|---|---|---|---|
| **D-BAKE-r4.1** | **APPROVED CONDITIONAL — verify-candidate only**. Cho phép bake 5 images tag `candidate-portal-swagger-20261006-r4.1` với scope hunks được reviewer duyệt offline; không phải release approval | Code: reuse hunks theo §11.1. Verify: yêu cầu bake/provenance/bundled-spec và live evidence. Accept: **r4/r4.1 NOT ACCEPTED**; cập nhật này không chứng minh bake đã chạy | Build integrator freeze tree, ghi full changed-file list + per-hunk hashes, Dockerfiles/base-image digests/build log/resulting image digests. Bundled OpenAPI phải khớp byte-for-byte artifact đã reconcile và validator exit 0. 0035/0036 phải ship; applied-state kiểm riêng trên DB candidate. Coordinator chỉ mở live run sau provenance conditions (a)–(c) |
| **D-SC01-01** | **Option A DESCOPE APPROVED**: đưa backend storage API `/api/v1/admin/secrets*` sang phase tiếp theo. **Option B rejected cho wave này**: không triển khai vội in-memory/DB catalog | Code: chỉ BFF-dispatch leg đã được reviewer xác nhận; backend vắng mặt là degraded state được công khai. Verify: no-plaintext/readback/error behavior còn cần evidence đúng scope. Accept: **SC-01 OPEN**, không claim SC-01 complete | BFF fail-closed typed 404/503; validation 422 `{pointer,message}`, không echo values. Portal write-only + disabled-with-reason; parser reject `value` trong readback. Docs/OpenAPI nêu backend absent/degraded. Existing SC/design owner mở next-phase Vault KV2-backed catalog với persistence/rotation design review, no-plaintext projection và live Vault proof |
| **D-BOOT-01 / F-VFY6-01** | **HYBRID policy**: fail-closed khi artifact encryption bật trong **real-data mode**; profile-cipher-only thiếu key trong **offline/dev/test** được warn-only và typed **AUTH_DECRYPT_FAILED** tại use time | Code: policy direction **SPECIFIED**, chưa claim implementation hoàn tất. Verify: boot matrix còn mở. Accept: **OPEN**; reviewer decision không tự authorize product-code change | Boot/security owner nhận implementation packet riêng, freeze predicate + exact real-data-mode definition trước sửa `main.ts`; independent reviewer kiểm. Matrix trên r4.1: keyless dev boots, keyless real-data/artifact-encryption mode refuses, tampered-key typed denial, healthy path |

## D-BAKE-r4.1 scope và verification conditions

Scope theo reviewer §11.1: BFF secrets dispatch fix (`E843A771…`), CR06-08 string/JSDoc (`145425A6…`), CR06-10 501 site/test (`48C45D6F…` / `FE787531…`), CB-02 admission writer + migration 0036 (`04EC1433…`, `5AD75BFF…`), CB-03 seams (`4FC40290…`, `AA04F120…`), reconciled OpenAPI v1.4.0 (`1388add7…`, **58 paths / 62 operations / 51 schemas; NO-DROP 0**). Đây là short hash prefixes được trích từ review để xác định scope; build receipt phải ghi full hashes của snapshot thực tế, không coi prefixes là immutable bake provenance. Hunk ngoài scope cần packet riêng.

Group A exact-path rerun **song song với bake**, ×3 + source hashes + A4 guard; bake không thay verification này. Images phải được gắn nhãn candidate; live gates chỉ chạy trên tagged r4.1 candidate sau khi freeze/bundled-spec/provenance bundle đủ. Applied-state migrations không suy từ việc file SQL có trong image.

## Sequencing / standing release verdict

1. Build integrator bake r4.1 theo scope và provenance conditions; independent verifier rerun Group A song song.
2. Boot/security owner triển khai packet F-VFY6-01 theo HYBRID predicate và real-data-mode definition; independent verify/review trước acceptance.
3. SC owner chuẩn bị next-phase backend catalog design theo Option A descope; giữ degradation công khai trong wave hiện tại.
4. Independent live verification trên exact r4.1 candidate: PG/S3/Vault byte-scan, boot matrix, HTTPS IdP/receiver, **0035/0036 applied-state**, Portal roundtrip. Coordinator giữ existing Run/leases, không tạo dispatcher hoặc writer trùng.

## Section 12 Audit Intake & Packets Completion Status (2026-10-06 23:00)

- **Closed by Reviewer §12.1:** `F-VFYSC1-02` (BFF Secrets Permanent Test 13/13 x3 exit 0).
- **Approved by Reviewer §12.2:** `F-VFY6-01` boot policy spec. Implemented by oc_1: 7-case matrix + main integration 60/60 tests exit 0, regression 487/487 exit 0 (`f-vfy6-01-closure-receipt-2026-10-06.md`).
- **Tooling Accepted by Reviewer §12.3 / §12.6:** Live-gates harness & Benchmark limit setup.
- **Executed on r4.1 candidate (§13 pending):**
  - **Packet 1 (Bake r4.1):** 5 images baked + provenance recorded (`bake-r4.1-verify-candidate-receipt-2026-10-06.md`).
  - **Packet 2 (Group A exact-path rerun):** A1..A7 verified green (exit 0), A4 symbol clarified (`vfy-group-a-exact-path-reconcile-2026-10-06.md`).
  - **Packet 4 (SC-03 Portal fixes):** F2, F3, F4, F8 (omitted=preserve / explicit null=clear) implemented & verified offline (`sc-03-portal-fixes-receipt-2026-10-06.md`).
  - **Packet 5 (Admin-web rebuild):** Rebuild exit 0, 2688 modules, digest unchanged confirming inlined openapi.json was current (`admin-web-rebuild-digest-2026-10-06.md`).
  - **Packet 6 (Secrets-backend spec):** Postgres + Vault KV2 CAS spec authored (`spec-secrets-backend-next-phase-2026-10-06.md`).
  - **Packet 7 (Live gates on r4.1):** 3/3 gates PASS (64 MiB migrate cap peak 18.07 MiB, 0035/0036 4 columns present, live HTTPS webhook 401->reacquire->200 DELIVERED, byte-scan 0 hits) (`live-gates-execution-receipt-2026-10-06.md`).
- **Benchmark Run:** Worker 1 CPU / 2048M, System 2 CPU / 4092M: Ingestion 12/12, 7.93 req/s, p50 244ms, 0 OOM (`benchmark-execution-results-2026-10-06.md`).

**REVIEW-PLAT-MIG-07 = CHANGES_REQUIRED stands.** R4/r4.1 chưa ACCEPTED hoặc được promote production. Toàn bộ code freeze, không commit/push. Chờ Claude Reviewer thẩm định độc lập batch Section 13.

## Review intake WT-01..09 — 2026-10-07 (plan-only, coordinator chưa verify)

- **Nguồn:** review đọc trực tiếp **working tree dirty tại HEAD `4308cc5`** (không phải image r4.1 đã bake), reviewer read‑only. Kế thừa review trước, không sửa receipt cũ. Plan: [`tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md`](../tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md). **Scope chỉ `du-rework/`** — 3 finding legacy root (WT‑10..12) đã tách khỏi plan để tránh nhầm lane.
- **Trạng thái:** **9 finding SPECIFIED · 0 IMPLEMENTED (cho finding) · 0 VERIFIED · 0 ACCEPTED.** 1 HIGH (`WT-01` resolver CB‑03 không bao giờ được nối ngoài test → delivery có credential fail‑closed và burn retry), 3 MEDIUM (`WT-02` read DTO đổi shape đang làm đỏ `tapi01-closure-offline.test.ts:331`; `WT-03` CB‑02 write/retry chưa có test; `WT-04` pin hỏng không thể Clear từ Portal), 5 LOW (docs `08`, Portal purpose comment, generator text‑assert, migration count tests, `du-rework/.gitattributes`).
- **Baseline đo lại (reviewer, lịch sử — Tester chạy lại):** orchestrator full suite **63 failed / 245 skipped / 4933 passed**, 9 suite đỏ; trong đó **chỉ `tapi01` thuộc change set này** (WT‑02), 8 suite còn lại đỏ từ trước (harness fake‑pg vs `list-query.ts`, FINDING test đã biết, taxonomy log, migration count). `packages/contracts` **567/567**; admin‑web typecheck **exit 0**; `validate_openapi.py` **exit 0** (`paths=58 x-absent=9`). Node **v22.16.0** lệch `engines >=24.21.0 <25`.
- **Điều này sửa lại điều gì:** không đóng `VFY-CB-01`, không tick CB‑02/03/04/05 hay bất kỳ parent nào; gate `G-*`/Section 13 giữ nguyên. Lưu ý honesty: mọi receipt dạng “487/487 exit 0” phải ghi kèm kết quả **toàn suite** vì full run hiện đang đỏ.
- **Dispatch:** 3 packet skeleton chờ owner thật (`coordination/dispatch-specs/2026-10-07-WT01-WT02-wave1.md`, `…-WT03-WT04-wave2.md`, `…-WT05-WT09-wave3.md`); scratch đã có prompt cho WT‑01/WT‑02+04/WT‑05+08+09 (00:12) — prompt không phải bằng chứng delivery, kiểm chứng receipt thật theo plan §6.

