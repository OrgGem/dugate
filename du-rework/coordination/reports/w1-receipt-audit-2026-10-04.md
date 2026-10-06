# W1 receipt audit — qwen1.md W1-1/W1-2 (READ-ONLY) — 2026-10-04

**Packet:** `coordination/dispatch-specs/2026-10-04-1900-W1-RECEIPT-AUDIT.md` · **Lane:** cc_1 (`term_c03791d1-2f0a-4c30-afc1-533d28f193ea`) · **Run:** `run_069ecd6957cd` (task `task_6e63e91cdfef`, dispatch `ctx_87ceace0f0a2`).
**Snapshot đo:** 2026-10-04 **18:50–19:05 +07** (`qwen1.md` mtime 18:50:18, 1994 dòng; HEAD `b088eec` 10-02 không đổi).
**Mode:** READ-ONLY — file duy nhất ghi là receipt này; **KHÔNG chạy lại suite** (W2-B sở hữu); không sửa source/test/plan; không tick; không commit/push.

## 0. TL;DR

| Hạng mục | Kết quả |
|---|---|
| F-W1-1..6 claims ↔ artifacts | **6/6 SUPPORTED** (file:line hiện tại, §1) |
| T-SUB-01/03 "đã xong" | **2/2 SUPPORTED** (order, hash RAW, priority outbox→dispatcher, sourceUrl gate) |
| Lease compliance | **PASS** — scan cửa sổ 18:07–18:50: đúng **5 file code**, tất cả trong lease; forbidden = **0** (§2) |
| No-tick / no-commit | **PASS** — HEAD `b088eec`; plan/task không bị tick (§3) |
| DD-03 / DD-04 | **HỢP LÝ** với nhãn tự khai ("suy ra, không đo được") / đúng scope W1c (§4) |
| 8-suite đỏ | **Loại trừ hợp lý** theo bằng chứng nêu (§4); W2-B sẽ chạy tái xác nhận |
| **T-PROF-03 publish/rollback/CAS** | **KHÔNG có bằng chứng trong W1 receipt** — xem §5 (câu hỏi trọng tâm) |
| Literal outputs | Có exit code/counts dạng đo được + nội bộ nhất quán; không re-run theo spec |

## 1. Claims ↔ artifacts (F-W1-1..6, T-SUB-01/03)

| Claim | Artifact hiện tại (file:line) | Verdict |
|---|---|---|
| **F-W1-1** snapshot không raw credential, runtime-validated | `submission.ts:502-533` `buildProfilePolicySnapshot()` (strict parse → 500 nếu fail); INSERT cột `profile_policy_snapshot` `:378`; giá trị builder `:420`; `JSON.stringify(profile.policy)` = **0 match** trong file | SUPPORTED |
| **F-W1-2** bỏ `.passthrough()` 2 tầng | `packages/contracts/src/profile-policy.ts:553-573` `ProfilePolicySnapshotSchema` `.strict()` cả 2 tầng; `contracts/src/runtime.ts:63-69` comment + `:69` `PinnedProfilePolicySchema = ProfilePolicySnapshotSchema`; `index.ts:14` re-export | SUPPORTED |
| **F-W1-3** guard đã nối dây | `submission.ts:25` import; `:512` dùng `fileUrlAuthConfigCarriesSecret(...)` làm predicate `fileUrlAuthConfigured`; def `file-url-auth.ts:155`. (Consumer duy nhất; decode ở acquisition vẫn DD-04) | SUPPORTED |
| **F-W1-4** DTO chuyên biệt + ref bất biến | `ProfileCredentialRefSchema` `:525-531`; `credentialRef` trong snapshot `:571`; builder truyền `(tenantId, profileId, revision)` `:513-517` | SUPPORTED |
| **F-W1-5** top-level `sourceUrl` qua extension gate | def `submission.ts:767-791` (param `sourceUrl`, comment PLAN04-01); call `:365-369` truyền `submission.sourceUrl`; test `w1-sub03-*` 6 case | SUPPORTED |
| **F-W1-6** sentinel test inject thật | `w1-sub02-snapshot-secret.test.ts`: **10 `it()`** (khớp claim); POSITIVE CONTROL `:161`; `leaks()` deep-scan `:140-155`; `not.toContain(sentinel)` `:282`; strict-reject legacy/unknown `:229`/`:244` | SUPPORTED |
| **T-SUB-01** admission seam | comment `:225-229`; `resolveEffectiveProfile` `:234` **trước** `randomUUID` `:299-301` và INSERT `:378+`; idempotency hash trên **RAW** input `:270-276` (`canonicalRequestHash({input: submission.input…})`) | SUPPORTED |
| **T-SUB-03** priority + extension | `submission.ts:459-467` `priority:` (pinned `bullMqPriority` / legacy `bullMqPriorityFor(PROFILE_JOB_PRIORITY_DEFAULT)`); `dispatcher.ts:55-63` đọc `payload.priority` | SUPPORTED |

**Drift ghi chú (không phải finding):** audit W1-1 trỏ số dòng pre-W1-2 (`submission.ts:218/:399/:439`) — sau W1-2 chúng dịch thành `:234/:420/:459-464`. Comment `submission.ts:227` ghi "randomUUID at :260" trong khi thực tế `:299-301` → stale comment cosmetic (LOW/informational, không ảnh hưởng semantics).

## 2. Lease compliance (bằng chứng mtime + scan cửa sổ)

**Scan toàn bộ** `services/orchestrator/{src,tests,migrations}` + `packages/contracts/{src,tests}` cho mtime **18:07–18:50 +07** → đúng 5 file:

| File | mtime (+07) |
|---|---|
| `services/orchestrator/src/modules/operations/submission.ts` | 18:24:13 |
| `packages/contracts/src/profile-policy.ts` | 18:17:26 |
| `packages/contracts/src/runtime.ts` | 18:18:21 |
| `services/orchestrator/tests/w1-sub02-snapshot-secret.test.ts` | 18:23:16 |
| `services/orchestrator/tests/w1-sub03-sourceurl-extension.test.ts` | 18:25:39 |

Tất cả **trong lease** (spec W1 §Lease). Forbidden paths (không xuất hiện trong cửa sổ; mtime cũ hơn): `src/server.ts` (10-03 02:15), `docs/21-openapi.json` (10-04 15:24), `packages/worker-sdk/src/crypto-storage.ts` (10-02 20:37), `modules/admin-actions/**` (max 10-01 21:08), `modules/encryption/**` (max 10-02 18:23), `app/admin/bff/**` (max 10-04 13:56). Claim "giữ nguyên" xác nhận: `dispatcher.ts` 15:58, `runtime.ts` (orchestrator) 17:17, `0026`/`0027` 14:06/14:07, migrations dir = 0 file trong cửa sổ.

**Test-stub claim phụ:** grep `it.skip|describe.skip|.todo(|TODO|FIXME` trên 5 test-stub = **0 match** (control `describe(` match đủ 5 file → glob hợp lệ); mtimes 17:18–17:19 (trước W1) → W1 đúng là không phải sửa.

## 3. No-tick / no-commit

- `git log -1` = **`b088eec`** (10-02 14:27) — không commit/push mới.
- `qwen1.md:1993` tự khai: *"Chua commit/push/reset. Chua tick gate. Khong mo DB/Redis/S3/Vault."*
- Plan/task không bị tick: PLAN04-01..05/CONT/WTV rows vẫn `[ ]`; `PLAN-COMPLETION` mtime 18:27:24 (trước khi W1 kết thúc) — không có write từ W1 vào plan file.

## 4. DD-03 / DD-04 / 8-suite đỏ — đánh giá loại trừ

- **DD-03 (shape snapshot cũ trong DB dev):** nhãn "kết luận suy ra từ tài liệu, không đo được offline" là trung thực; `0026:172-179` "Deliberately NOT backfilled" khớp. Hợp lý — đề xuất giữ mở: live confirm hoặc packet migration riêng.
- **DD-04 (acquisition decode ref):** grep `credentialRef` toàn `services/orchestrator/src` = **chỉ 1 hit** (writer `submission.ts:513`), **0 reader** → claim "con đường đọc credential chưa tồn tại" chính xác; scope đúng W1c.
- **8-suite đỏ:** (a) 6 suite `admin-shell-*` + `admin-p6-01-shell-fixtures` — mtimes 09-24→10-02, pre-W1, ngoài write-set ✓; (b) `enc-meta-sentinel-runtime-refs` — tự nhãn **RED GAP DETECTOR** (`:281`) + comment "Fails today (finding)… METADATA_SLOTS result_ref" (`:292-293`), không về profile snapshot ✓; (c) `br12-isolation-offline` — file **không chứa `inputSchema`**; `declaredParameterKeys` (`submission.ts:542-548`) ném TypeError khi undefined — khớp probe "Cannot read properties of undefined". Attribution "pre-existing trước W1" hợp lý nhưng **không time-verify được từ git** (cây dirty đa lane, không baseline) — ghi rõ là hạn chế.
- Số liệu nội bộ nhất quán: baseline 4+1=5 suite, 43+40=83 test; focused 6+1=7 suite, 40+59=99 test; full-tree 8+10+145=163 suite. Không re-run để xác nhận (per spec).

## 5. T-PROF-03 publish/rollback/CAS — câu hỏi trọng tâm

**Kết luận: KHÔNG có bằng chứng T-PROF-03 trong W1 receipt.**
- Grep `T-PROF` toàn `qwen1.md` = **0 hit**; W1 spec (18:05) 4 hạng mục không gồm T-PROF-03; W1 diff 5 file không chạm `modules/profiles/**` (lease cho phép nhưng W1 không dùng).
- Trong cây: `modules/profiles/publish.ts` (mtime **15:27 +07 — trước W1**) có comment T-PROF-03 + CAS guard thật (`pinActiveRevision`, `getEffectiveRevision`, `expectedRevision`, `FOR UPDATE`) — nhưng **không được W1 verify**. Không có test exercise module này: grep `pinActiveRevision|getEffectiveRevision|expectedRevision` trong `tests/` chỉ hit `aweb04-bff-profiles.test.ts` (chuỗi wire BFF, không gọi publish.ts).
- `0026/0027` có receipt verify riêng (cc_2, 14:56) ở mức **migration apply/pointer invariant** — adjacent, không phải evidence hành vi publish/rollback/CAS.
- **Hệ quả cho checkpoint (b):** định nghĩa (b) tại `plan-review-730:31` yêu cầu *"publish/rollback/CAS invariant có evidence"* để mở W1c/W3 → **chưa đủ điều kiện theo định nghĩa này**. Nếu coordinator hiểu (b) theo W1-spec (4 hạng mục hoàn tất) thì claim của qwen_1 đúng phạm vi. Đề xuất: chốt **một** định nghĩa (b) và cấp packet evidence T-PROF-03 (W2-B item hoặc closure verify) trước khi dùng (b) làm gate mở W3.

## 6. "File release" cho W1c/W3 (đề xuất — chưa mở)

Receipt **không có mục release tường minh**. Trích từ nội dung (nhãn audit-derived, không phải đề xuất của qwen_1):
- **DTO frozen (checkpoint (a)):** `packages/contracts/src/{profile-policy.ts, runtime.ts}` + `index.ts` re-export — consumer W1b dùng được ngay (schema `.strict()` đã land).
- **Producer done:** `submission.ts` (admission + snapshot + sourceUrl gate); **download/acquisition leg chưa** — thuộc W1c (DD-04).
- **Chưa chạm/thiếu evidence:** `modules/profiles/{publish,policy}.ts` (T-PROF-03), `file-url-auth.ts` (chỉ mới có consumer đọc predicate).
- `dispatcher.ts` / `runtime.ts` (orchestrator): giữ nguyên theo claim — không nằm trong release.

## 7. Limitations

- Không chạy lại bất kỳ suite nào (đúng constraint; W2-B sở hữu); không đọc transcript/terminal; chỉ receipt + artifacts + git + mtime.
- Attribution thời gian dựa mtime (không có commit per-lane, cây dirty đa lane) — mọi kết luận "pre-W1" đều ghi theo mtime, không theo diff.
- "Checkpoint (b)" có 2 định nghĩa lệch (W1-spec vs plan-review-730) — audit nêu, không tự chọn thay coordinator.
- Số test/exit code trong receipt không được tái xác nhận độc lập ở packet này (đó là W2-B).

READ-ONLY compliance: chỉ receipt này được ghi; không tick/sửa file nào khác; không commit/push.
