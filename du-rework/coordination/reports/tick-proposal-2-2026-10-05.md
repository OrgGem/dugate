# TICK-PROPOSAL-2 — map 2 row P763 → evidence + đề xuất tick — 2026-10-05

**Packet:** TICK-PROPOSAL-2 (coordinator 02:39; follow-up nudge [0236](../reviews/2026-10-05-0236-coordinator.md): "cc_3 tick-proposal P763 rows"). **Lane:** cc_3 (`term_4954d39e`).
**Mode:** READ-ONLY — file duy nhất ghi là receipt này; **không tick**; không commit/push; không re-run test (trích dẫn nguyên văn receipt gốc). **Snapshot:** 2026-10-05 02:39–03:0x +07 · HEAD `b088eececcb5f3df0b4edbe073a29401dafda624` · PLAN pre-pin `24638082e1e3c461e5a344916c829dfac3886a3b7cfcad3efdeaf21fb2612d0f` (mtime `1791141285087670000`, khớp post-pin update795).

## 0. TL;DR

- Cả 2 row vẫn `[ ]` (`tasks/PLAN-COMPLETION-2026-10-04.md:275,:277`). Chuỗi evidence **offline** của cả hai đã đủ; phần còn lại của cả hai là **live/window** (đã có nơi theo dõi: parent T-PROM-02 + `LIV-PC-01` trong live-plan §4).
- **Đề xuất: TICK ở phạm vi OFFLINE cho cả 2 row**, kèm 3 ghi chú điều kiện (chi tiết §1–§2):
  1. Row W1C-COMPOSE: **không thấy artifact reviewer riêng** cho các hunk composition trong ledger (hiện có tester-verify + coordinator-settle; Part-4 verdict W1c *không* cover composition) → coordinator chốt: gọi 1 review ngắn hoặc ghi nhận verify-leg là chuỗi review.
  2. `create-app.ts` đã tiến hoá **sau** verify (các hunk additive CW-A/ENCMETA) → digest cũ `5913db5e…` không còn là digest hiện tại; **hunk W1C còn nguyên** tại anchor mới (:64, :472-478, :500-503). Tick-note nên ghi kèm "verified at `5913db5e`; later additive hunks preserved W1C".
  3. Row PROMPT-WIRING giữ nguyên văn đòi "observed provider request + live" ⇒ đề xuất này là tick **offline leg** (ledger đã chốt `T-PROM-02 OFFLINE = CLOSED` tại turn 793/795); **parent T-PROM-02 và live không đóng**.
- Nếu coordinator đọc tuyệt-đối theo văn bản row (đòi live ngay trong acceptance): cả hai **NO-TICK tới live window** — trade-off ghi ở cột gap.

## 1. Bảng chính (row → evidence → verdict → proposed-tick → gap)

| Row (PLAN) | Evidence (file:line) | Verdict hiện có | Proposed tick | Gap còn lại |
|---|---|---|---|---|
| **P763-W1C-COMPOSE** `[ ]` — PLAN:275 | Owner §6 `p730-acquire-2026-10-04.md:78-135` (3 hunk create-app; 5 case; focused 76×3 exit 0; boot-reg 15; tsc 0; post-SHA `5913db5e`) + `tester.md:12758-12834` VERIFY-COMPOSITION (3 vòng × 76 exit 0; digest/patch khớp; no-touch hash nguyên; `DEVIATION: NO`) + settle turn 770 (`reviews/2026-10-04-2344-coordinator.md:7,:18`) | **Owner DONE + Independent VERIFY PASSED** (offline) | **TICK (offline scope)** — lý do: chuỗi owner→independent đủ + hash continuity lúc verify + không deviation; đây là chặn-đường đã được downstream dùng (consumer-auth seam). *Điều kiện*: coordinator chốt review-leg (xem gap) | (a) **Review-leg**: chưa có verdict Claude riêng cho hunk composition trong ledger (row ghi "Independent verify **+ review**") → cần quyết: review ngắn hoặc chấp nhận verify-leg. (b) **Live cells** (row ghi "real PG/MinIO cells giữ live window"): row PG thật + fetch thật quan sát header. (c) **Missing-key full-boot**: hiện chứng minh bằng code-path, chưa chạy boot thật với `ENCRYPTION_KEY` gỡ (`tester.md:12813`). (d) Digest hiện tại đã khác pin (additive hunks) — dẫn chứng §3. *Alt strict: NO-TICK tới khi có (a)* |
| **P763-PROMPT-WIRING** `[ ]` — PLAN:277 | `p745-carrier-impl-b2-2026-10-04.md` §§5-9 (B2 17/17; B2-WIRING 10 site :80-86; evidence :88-93) + `tester.md:13211-13247` VERIFY-B2 (17/17×3, focused 38×3, DELTA-A 10/10, tsc 0; inspection 11 declaration :13238; **provider-side LIVE-ONLY** :13244) + `w1-review-b2-2026-10-05.md` (**AW-C** :7; T6/adapter/11-site/dead-field/2-literal :9-22; B2-1..4 ALL PASS :24-31; T-PROM-02 offline KÍN :40-44; remaining :52-56) + settle turn 793 (`reviews/2026-10-05-0206-coordinator.md` — "T-PROM-02 OFFLINE CHAIN CHÍNH THỨC KÍN") + fold `plan-update-795-2026-10-05.md:12` | **VERIFY PASS + Reviewer AW-C**; T-PROM-02 offline chain closed tới **mocked invoke boundary** | **TICK (offline leg scope)** — lý do: substitution-before-invoke + ≥6 site (thực tế 11) + dead-field + DELTA-A đủ; independent verify + reviewer đủ; ledger đã tuyên bố offline CLOSED. *Điều kiện*: tick-note ghi rõ scope "offline leg; parent T-PROM-02/live giữ mở" | (a) **Observed provider request** đúng nghĩa (và `key-4/exact/_default/cleared/null` tại provider-use) — đã được gán `LIV-PC-01` (`live-plan-refresh-2026-10-05.md:18,:28`). (b) carrier-null leg live + claim live + worker-kill immutability. (c) no-log assertion + step_checkpoints no-duplicate (conditions 3-4 `w1-review-b2:37-38,:55-56`). (d) cleared-exact/`_default` vector (MISMATCH-CLEAR rider — LIV-PC-01). (e) A-pin qua publish B/child/retry/HITL (live). *Alt strict: NO-TICK tới live (giữ nguyên văn)* |

## 2. Đối chiếu từng điều khoản acceptance

**P763-W1C-COMPOSE (PLAN:275)** — "Production-equivalent boot thật tạo resolver và inject ingestion-consumer" → **✓ offline**: comptest pin factory gọi 1 lần với `resolveSourceAuth` + cùng `db`; Postgres-only no-op; consumer factory được mock **ở đúng ranh giới factory** để bắt options, resolver chạy THẬT trên pool app scripted (`p730-acquire-2026-10-04.md:118-124`). "Configured bearer/header tới allowlisted mock" → **✓ offline ở mức seam** (bearer decrypt case 3; consumer-auth suite pin header behavior — `tester.md:12814`); observed-header live còn mở. "Deny query/wrong-ref/key/tag trước upstream" → **✓ offline** (query `QUERY_AUTH_FORBIDDEN`; `AUTH_CONFIG_MISSING`/`REF_TENANT_MISMATCH`/`REF_NOT_FOUND`; deny-before-fetch). "No-secret persisted/logs" → **✓ offline** (W1c no-secret sinks + review §6.4). "Independent verify + review" → verify **✓**; review **chưa có artifact riêng** (gap a). "Real PG/MinIO cells giữ live window" → **đúng như row** — còn mở.

**P763-PROMPT-WIRING (PLAN:277)** — "resolveStepPrompt và apply ? prompt : existingDefault trước actual invoke" → **✓ offline** (`prompt-application.ts` ternary; adapter chokepoint `worker.ts:410-425` — W-REVIEW-B2 §1). "observed provider request đủ 6 sites" → **offline proxy ✓/live ✗**: 11 site khai `promptStepId` đúng step của chính nó (static inspection + runtime representative — `tester.md:13238-13239`); nhưng tests **dừng ở mocked `ctx.connector.invoke`** (`tester.md:13244`) ⇒ "observed provider request" thật thuộc live leg. "key-4/exact/_default/cleared/null semantics" → semantics resolver đã review/đóng ở PREFCONSUME (Δ-PC-5; `w1-review-part4:72,:76`); vector end-to-end cleared-exact/nonempty-`_default` = **LIV-PC-01**. "A pin giữ qua publish B/child/retry/HITL" → live (LIV-PC-01 steps). "Independent + live evidence và reviewer trước full T-PROM-02; không count pure resolver test như provider-use" → independent **✓** (VERIFY-B2), reviewer **✓** (W-REVIEW-B2 AW-C); live ✗ (pending); "không count pure resolver" được tôn trọng: bằng chứng wiring nằm ở invoke-row của handler, không phải resolver unit.

## 3. Hash continuity (read-only, chạy tại snapshot này)

| File | Pin trong receipt | Hiện tại | Kết luận |
|---|---|---|---|
| `src/app/bootstrap/create-app.ts` | `5913db5e…` (W1C post, `p730-acquire §6.1`) | `ae7e29ce64ed558c022be456bbabccecd59345962af789a32a898b18d939ed0e` | **Drift có chủ đích** — sau W1C đã có hunk additive của lane khác (CW-A compose connector store, ENCMETA Δ-LEASE `result_ref`). **Hunk W1C còn nguyên**: import `:64`, compose resolver `:472-478`, forward `resolveSourceAuth` trong nhánh S3 `:500-503` |
| `tests/p730-acquire-composition.test.ts` | `86c46315…` | `86c46315…` | **MATCH** |
| `src/modules/operations/acquisition-ref-resolver.ts` | `4b0226c1…` | `4b0226c1…` | **MATCH** |
| `src/modules/operations/ingestion-consumer.ts` | `b737b5fa…` | `b737b5fa…` | **MATCH** |
| `businesses/document-core/src/worker.ts` | `9bce7694…` (V-B2) | `9bce7694…` | **MATCH** |
| `businesses/document-core/src/actions/prompt-application.ts` | `261f395f…` | `261f395f…` | **MATCH** |
| `businesses/document-core/tests/p745-carrier-impl-b2.test.ts` | `097dc9c9…` | `097dc9c9…` | **MATCH** |
| `businesses/document-core/tests/p745-session-capture-inject.test.ts` | `27d3d113…` | `27d3d113…` | **MATCH** |
| `businesses/document-core/tests/execution-pin.functional.test.ts` | `3082c474…255bdedda` | `3082c474…255bddeda` | **Lệch 2 ký tự đảo (bde/bd… ) trong chuỗi ghi của receipt** — mtime file `2026-10-04T17:47:33Z` (= 00:47:33 +07, **trước** verify 01:24) ⇒ file không đổi sau verify; đây là **lỗi chép chuỗi ở receipt VERIFY-B2** (documentation nit, không phải drift nội dung — DELTA-A đã được chạy lại độc lập 10/10 trong verify). Đề nghị lane tester chỉnh khi chạm lần sau; tôi không sửa receipt lane khác |

## 4. Compliance (READ-ONLY)

- File duy nhất ghi: receipt này. **Không tick** row nào; không sửa PLAN/receipt/test/source nào khác; không commit/push/staging.
- PLAN rows vẫn `[ ]` tại `:275`/`:277`; PLAN pre-pin `24638082…` (đã đối chiếu trước khi ghi — sẽ re-pin sau ghi ở §5).
- Không re-run test/suite nào (packet read-only; mọi con số trích từ receipt gốc kèm file:line).

## 5. Post-write check

```
tasks/PLAN-COMPLETION-2026-10-04.md  pre : mtime_ns 1791141285087670000 · sha256 24638082e1e3c461e5a344916c829dfac3886a3b7cfcad3efdeaf21fb2612d0f
tasks/PLAN-COMPLETION-2026-10-04.md  post: mtime_ns 1791141285087670000 · sha256 24638082e1e3c461e5a344916c829dfac3886a3b7cfcad3efdeaf21fb2612d0f   (KHÔNG đổi)
git status scoped: ?? coordination/reports/tick-proposal-2-2026-10-05.md  (chỉ receipt mới; PLAN không thêm thay đổi từ lượt này)
HEAD: b088eececcb5f3df0b4edbe073a29401dafda624 (không đổi)
```

