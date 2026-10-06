# Phase 1 Profiles — Independent verify (cc_2)

**Packet:** profile-phase1-verify · **Lane:** cc_2 · **Dispatch:** 2026-10-04T15:12+07:00 (spec `coordination/dispatch-specs/2026-10-04-1512-profile-phase1-verify.md`).
**Mode:** READ-ONLY vs source/test/plan; không commit. File ghi: receipt này (+ script tạm đã xoá). Migrations 0026/0027 đã verify riêng (`migrations-0026-0027-verify-2026-10-04.md`) — không lặp lại phần DB.
**Đối tượng:** `reports/profile-parity-phase1-2026-10-04.md` (lane Claude).

## 0. TL;DR — VERDICT: `CHANGES_REQUIRED` (1 finding, định hướng mapping)

- Re-derive **đạt toàn bộ**: contracts 27/27, cả 2 `tsc` 0, openapi 26 schema / 45 paths / 10 `x-absent` / **0 unresolved** / version 1.3.0.
- Adversarial tự viết: **14/15** — cipher edges, params strict, stepId `_default`, parse CSV, read/write split đều đúng.
- **FAIL duy nhất F-PP1 (finding):** `PROFILE_JOB_PRIORITY_WEIGHTS` **ngược chiều legacy**. Legacy: **HIGH=1 / MEDIUM=10 / LOW=20** (`lib/pipelines/submit.ts:26-32`, "lower = higher priority"); contract: `{LOW:1, MEDIUM:10, HIGH:20}` (`profile-policy.ts:103-108`) và receipt §5.2 khẳng định "đúng legacy BullMQ 20/10/1" — **sai chiều**. Chưa có consumer ngoài test/openapi nên chưa gây drift runtime, nhưng nếu T-SUB-03 dùng trực tiếp làm BullMQ `priority` thì HIGH chạy **sau cùng** — đúng điểm dispatch cảnh báo "dễ sai chiều".

## 1. Re-derive (literal)

```
cwd: du-rework/packages/contracts   (NODE_ENV=test)
> pnpm exec jest --runInBand tests/profile-policy.test.ts
Test Suites: 1 passed, 1 total · Tests: 27 passed, 27 total          PP_JEST_EXIT=0
> pnpm exec tsc --noEmit -p tsconfig.json                             CONTRACTS_TSC_EXIT=0
> pnpm exec jest --runInBand tests/vault-policies.test.ts
Test Suites: 1 failed · Tests: 2 failed, 60 passed, 62 total          (pre-existing — xem §4)

cwd: du-rework/services/orchestrator
> pnpm exec tsc --noEmit -p tsconfig.json                             ORCH_TSC_EXIT=0

cwd: du-rework
> node <check> docs/21-openapi.json
{ "version": "1.3.0", "schemas": 26, "paths": 45, "xAbsent": 10, "refs": 18, "unresolved": 0 }
```
Khớp **chính xác** các con số receipt §2/§8.

## 2. Adversarial — 14/15 PASS (script riêng, import từ source)

| # | Case | Kết quả |
|---|---|---|
| A1 | cipher hợp lệ `iv24:tag32:ct-even-hex` | accept ✓ |
| A2 | uppercase hex | reject ✓ |
| A3 | IV 23/25 | reject ✓ |
| A4 | TAG 31/33 | reject ✓ |
| A5 | ct rỗng / odd-length / non-hex | reject ✓ |
| B1/B2 | upsert `policy={}` pass; thiếu policy fail | ✓ |
| B3 | policy unknown key (strict) | fail ✓ |
| B4 | publish thiếu `expectedRevision` fail; có → pass | ✓ |
| B5 | rollback thiếu `targetRevision` fail; có → pass | ✓ |
| C1 | PromptOverrideKey `stepId` default `'_default'` (khớp DB 0026:125) | `_default` ✓ |
| D1 | `parseAllowedFileExtensions(' .pdf, DOCX ,,pdf ')` | `['.pdf','DOCX','pdf']` — order/case/dup giữ, rỗng bỏ ✓ |
| E1 | write schema nhận `fileUrlAuthConfig`, từ chối `fileUrlAuthConfigured` | ✓ |
| E2 | read schema yêu cầu `fileUrlAuthConfigured`, từ chối `fileUrlAuthConfig` | ✓ |
| **F1** | **priority khớp chiều legacy** | **FAIL** — `legacy={"LOW":20,"MEDIUM":10,"HIGH":1}` vs `contract={"LOW":1,"MEDIUM":10,"HIGH":20}` |

`SUMMARY 14/15 PASS` — FAIL duy nhất là finding dưới đây.

## 3. FINDING F-PP1 — mapping priority ngược chiều legacy

**Bằng chứng:**
- Legacy (nguồn chuẩn): `lib/pipelines/submit.ts:26-32` — `resolveBullPriority`: comment *"(lower = higher priority)"*; `case 'HIGH': return 1; case 'LOW': return 20; default: return 10 (MEDIUM)`. Tức legacy: **HIGH=1, MEDIUM=10, LOW=20**.
- Contract: `packages/contracts/src/profile-policy.ts:103-108` — comment *"BullMQ weight the priority maps to **at enqueue time** (T-SUB-03)"*; giá trị `{ LOW: 1, MEDIUM: 10, HIGH: 20 }` ⇒ LOW nhận priority 1 (cao nhất), HIGH nhận 20 (thấp nhất) — **đảo ngược** so với legacy.
- OpenAPI `docs/21-openapi.json:741` phát cùng thông tin đảo: "Maps to the BullMQ weight 1 / 10 / 20".
- Test `packages/contracts/tests/profile-policy.test.ts:55` pin đúng giá trị đảo `{LOW:1,...}` nên **không thể bắt** lỗi chiều; receipt §5.2 khẳng định "đúng legacy BullMQ 20/10/1" là **sai** (legacy là 1/10/20 theo nghĩa HIGH=1).
- Chưa có consumer trong `src/**` (grep `PROFILE_JOB_PRIORITY_WEIGHTS` ngoài test/receipt/openapi = 0) ⇒ **chưa drift runtime**, nhưng đây là contract đóng băng cho T-SUB-03; dùng trực tiếp làm BullMQ `priority` sẽ đảo hành vi enqueue của PROFILE so với legacy (HIGH bị xếp cuối).

**Khuyến nghị fix (bounded):** chọn 1 hướng và nhất quán 3 nơi:
- (a) **Parity tối thiểu (khuyến nghị):** đổi thành `{ LOW: 20, MEDIUM: 10, HIGH: 1 }`, sửa test `:55`, sửa câu chữ openapi `:741`; giữ tên là số `priority` BullMQ (không "weight").
- (b) Nếu muốn giữ "weight" (cao = quan trọng hơn): đổi tên/ghi rõ semantics + dispatcher phải chuyển đổi khi enqueue (vd `priority = 21 - weight`) + sửa receipt/openapi claim + thêm test parity với legacy.

## 4. Pre-existing vault-policies (không phải lane này) — attribution độc lập

`vault-policies.test.ts` fail 2 case (`2 failed, 60 passed`). Kiểm chéo độc lập ngoài A/B của receipt: file test này **không import `profile-policy`** (grep = 0) ⇒ dòng `export * from './profile-policy'` được thêm không thể ảnh hưởng 2 case đó; kết luận pre-existing, không tính cho lane.

## 5. Lease check — khớp receipt §1

```
 M docs/21-openapi.json                     (+512/−3)
 M packages/contracts/src/index.ts          (diff ĐÚNG +1 dòng: export * from './profile-policy';)
?? packages/contracts/src/profile-policy.ts
?? packages/contracts/tests/profile-policy.test.ts
?? services/orchestrator/migrations/0026_profile_policy.sql
?? services/orchestrator/migrations/0027_profile_active_pointer.sql
?? services/orchestrator/migrations/0025_artifact_manifest_version.sql   ← không phải lane này (đã ghi đúng)
```
Không thấy file `src/**` nào khác thuộc lane; orchestrator `src/**` không bị chạm bởi lane này.

## 6. Spot-check ¶5.2/§7/§8

- Exports chính tồn tại: `PROMPT_OVERRIDE_PRECEDENCE :364`, `PROFILE_DISPATCHER_ACTIONS :474`, `PROFILE_PROBLEM_CODES :489` (các schema khác được script adversarial import trực tiếp và chạy).
- §7.3 params semantics đo đủ ở B1–B5; §7.4 (lệch AWEB-04 §1) giữ nguyên là open decision của coordinator — không kiểm thêm.
- §8: 26 schema / 45 paths / 10 `x-absent` / 0 unresolved — **khớp** (§1 ở trên).

## 7. Giới hạn / không đo được

- Không chạy DB lại (0026/0027 đã verify riêng); T-PROF-04 encrypt-on-write chưa code (phase 2) nên chưa kiểm được đường cipher đọc/ghi thật.
- R-16 blocker (backfill script ngoài lease) là quyết định coordinator, không phải lỗi kỹ thuật của lane.
- Mapping queue chỉ đối chiếu tĩnh (chưa có dispatcher PROFILE để chạy end-to-end).

**Verdict:** **`CHANGES_REQUIRED`** — đúng 1 finding `F-PP1` (`packages/contracts/src/profile-policy.ts:103-108` + `tests/profile-policy.test.ts:55` + `docs/21-openapi.json:741` vs legacy `lib/pipelines/submit.ts:26-32`); 14/15 adversarial còn lại đạt, re-derive khớp toàn bộ.

*Không tick, không commit; script tạm đã xoá khỏi repo.*
