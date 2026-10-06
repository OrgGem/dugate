# WTV-02 — Independent verify CONV-07 (`runtime.test.ts` split) — cc_2

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Dispatch:** 2026-10-03T13:20+07:00 (coordinator command-code).
- **Mode:** READ-ONLY source/test + **được chạy test**. Không sửa file nào; **không tick gate; không commit; không chạm `nocobase-10`**.
- Nguồn: `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` WTV-02 + CONV-07. Receipt gốc `cc-conv07-2026-10-03.md` **không dùng làm bằng chứng** — mọi số liệu dưới đây tự re-derive.

**TL;DR (VI):** **IDENTICAL.** `expect(` **574 = 574**; multiset **97 test name = 97**; **8 describe name = 8**; hooks tăng 5→19 (mỗi file tự sở hữu hook của nó — đúng thiết kế split, không phải mất test). Skip guard giữ nguyên semantics: HEAD cũng 100% window-gated (mọi describe nằm trong 1 `liveDescribe`), AFTER mỗi file có `liveDescribe` riêng import từ harness (`LIVE = process.env.DU_LIVE_INFRA === '1'`). Chạy độc lập 8 file: mỗi file **EXIT=0, toàn bộ skip** (97 skipped tổng); chạy song song cặp + cả 8 file (không `--runInBand`) **EXIT=0, không collision**; `tsc --noEmit` **EXIT=0**. Không drift. Chưa chứng minh offline: phần LIVE thực thi (cần `DU_LIVE_INFRA` window) — harness tự ghi "parallel compatibility is NOT certified" cho chế độ live shared-DB.

## 1. Layout trước/sau

| | File | Dòng |
|---|---|---|
| **HEAD** | `tests/runtime.test.ts` | **3869** |
| AFTER | `tests/runtime.test.ts` (remaining) | 1785 |
| AFTER | `tests/runtime-admin-auth.test.ts` | 199 |
| AFTER | `tests/runtime-facade.test.ts` | 288 |
| AFTER | `tests/runtime-health.test.ts` | 270 |
| AFTER | `tests/runtime-hitl.test.ts` | 458 |
| AFTER | `tests/runtime-recovery.test.ts` | 374 |
| AFTER | `tests/runtime-version-lifecycle.test.ts` | 288 |
| AFTER | `tests/runtime-webhook.test.ts` | 298 |
| AFTER | `tests/helpers/runtime-harness.ts` | 410 |

Mọi file hand-authored **< 2000 dòng** ✓ (`runtime-encryption-metadata.test.ts` 1247 và `runtime-lease-fencing-offline.test.ts` 639 là file **có trước**, tracked ở HEAD — không thuộc split, không tính vào so sánh).
Git state: `runtime.test.ts` là `M`, 7 file runtime-* mới + harness là `??` (đúng "chưa commit").

## 2. Test IDs + assertion count (re-derived)

Script `wtv02-count.js`: BEFORE = `git show HEAD:…/runtime.test.ts`; AFTER = 8 file split + harness (không gồm 2 file pre-existing).

```
it/test decls   : HEAD= 98   AFTER.sum= 98
expect(         : HEAD= 574  AFTER.sum= 574
describe        : HEAD= 8    AFTER.sum= 8
hooks bAll/bEach: HEAD= 5    AFTER.sum= 19
test-name-multiset: before=97 after=97 IDENTICAL
describe-name-multiset: before=8 after=8 IDENTICAL
```

- **Không giảm** ở bất kỳ metric nào; test-name multiset khớp tuyệt đối (từng tên, kể cả nested describe names) — **0 drift**.
- `hooks` tăng 5→19: mỗi file split có `beforeAll/afterAll` riêng (setup/teardown fixture của chính nó) — tăng là hệ quả tất yếu của split, không phải thêm test.
- Phân bổ AFTER (it/test + expect): runtime.test 40/278 · admin-auth 7/15 · facade 14/58 · health 4/27 · hitl 7/72 · recovery 9/33 · version-lifecycle 7/33 · webhook 9/55 · harness 0 test (chỉ helpers).
- Sau khi cộng: 40+7+14+4+7+9+7+9 = **97** test — khớp đúng multiset 97 và tổng skipped khi chạy (§3).

## 3. Skip guard `DU_LIVE_INFRA` — semantics giữ nguyên

**HEAD structure:** `liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)')` tại dòng 176 bao **toàn bộ** 8 nested describe (313→3649); file kết thúc bằng `});` đóng liveDescribe → HEAD **không có** test nào chạy offline.

**AFTER semantics:** `helpers/runtime-harness.ts:25-26`:

```ts
export const LIVE = process.env.DU_LIVE_INFRA === '1';
export const liveDescribe: typeof describe = LIVE ? describe : describe.skip;
```

Mỗi file split import `{ createRuntimeFixture, liveDescribe, warnIfSkipped }` và bọc **một** describe nghiệp vụ trong `liveDescribe` — tức cùng điều kiện gác, cùng hành vi skip. `createRuntimeFixture` được gọi ở module top-level nhưng chỉ tính namespace (không kết nối DB/Redis — connection chỉ xảy ra trong `setup()` bên trong `liveDescribe`).

**Chạy từng file độc lập** (cwd `D:\Git\dugate\du-rework\services\orchestrator`, `NODE_ENV=test`, `pnpm exec jest --runInBand tests/<file>`):

| File | Exit | Kết quả |
|---|---:|---|
| `runtime.test.ts` | 0 | 1 suite skipped; Tests: 40 skipped / 40 |
| `runtime-admin-auth.test.ts` | 0 | 1 skipped; 7 skipped / 7 |
| `runtime-facade.test.ts` | 0 | 1 skipped; 14 skipped / 14 |
| `runtime-health.test.ts` | 0 | 1 skipped; 4 skipped / 4 |
| `runtime-hitl.test.ts` | 0 | 1 skipped; 7 skipped / 7 |
| `runtime-recovery.test.ts` | 0 | 1 skipped; 9 skipped / 9 |
| `runtime-version-lifecycle.test.ts` | 0 | 1 skipped; 7 skipped / 7 |
| `runtime-webhook.test.ts` | 0 | 1 skipped; 9 skipped / 9 |

Tổng = **97 skipped / 97** — trùng khớp tuyệt đối danh sách 97 test name ở §2, không file nào boot/createApp/listen khi thiếu window (cùng ngữ nghĩa HEAD).

## 4. Cleanup/isolation — chỉ xóa namespace của suite

`runtime-harness.ts` (đọc trực tiếp):

- **Per-suite fixture:** mỗi file gọi `createRuntimeFixture({ suite: '<tên>' })` với tên riêng (`admin-auth`, `hitl`, `webhook`, `facade`, `health`, `version`, `recovery`, `vertical`) → `businessId = test-biz-<runId>-<suite>` (`:150-156`).
- **scopedCleanup chỉ xóa dữ liệu của suite:** chọn `operations` theo `business_id=$1` của chính suite, xóa dây chuyền usage_events/tasks/grants/checkpoints/artifacts/human_waits/task_dependencies/outbox/submission_keys/webhook_deliveries theo đúng op/task ids đó, cuối cùng `DELETE FROM business_versions WHERE business_id=$1` (`:214-244`). Redis: `queue.obliterate` **chỉ** trên queue `du-business-<biz>-<version>` của suite (`:287-293`) — comment ghi rõ "never flushdb()".
- **Namespace per-run:** qua `tests/isolation/namespace.ts` — schema `du_test_<runId>` (`:73`), Redis DB index 1–14 + prefix `du:test:<runId>:` (`:74,80-81`), artifact dir riêng (`:76-77`), teardown chỉ `DROP SCHEMA ... CASCADE` của run mình (`:155-157`), `assertSafeIsolationConfig` chặn cấu hình shared `public`/Redis DB 0 (`:173-217`), `assertTestDatabase` từ chối DB không có chữ "test" (`:198-211`).
- **Không có global wipe:** grep `TRUNCATE|FLUSHDB|FLUSHALL|flushdb` trong 8 file split = **0 match**; trong harness chỉ có 2 dòng comment nói "never global TRUNCATE / flushdb".

**Chạy song song (không `--runInBand`):**

```
> pnpm exec jest tests/runtime-health.test.ts tests/runtime-webhook.test.ts        (2 workers)
PAIR_EXIT=0 — Test Suites: 2 skipped, 0 of 2 total / Tests: 13 skipped, 13 total

> pnpm exec jest tests/runtime.test.ts tests/runtime-admin-auth.test.ts tests/runtime-facade.test.ts \
    tests/runtime-health.test.ts tests/runtime-hitl.test.ts tests/runtime-recovery.test.ts \
    tests/runtime-version-lifecycle.test.ts tests/runtime-webhook.test.ts          (default workers)
PAR8_EXIT=0 — Test Suites: 8 skipped, 0 of 8 total / Tests: 97 skipped, 97 total
```

→ Không `EADDRINUSE`/collision trong chế độ offline (đương nhiên: LIVE suite skip nên không boot port/DB). **Lưu ý trung thực:** đây là equal-evidence cho yêu cầu "2 file chạy song song không collision" ở mức **offline skip-mode**; bản thân harness ghi rõ `:190-197` *"Interim policy: shared-DB suites still run serially … parallel compatibility is NOT certified"* — chứng minh parallel **khi LIVE** cần cửa sổ PG/Redis (không có lease → không chạy), xem §6.

## 5. Typecheck

```
> pnpm exec tsc --noEmit -p tsconfig.json        (cwd services/orchestrator)
TSC_EXIT=0                                       (không error TS)
```

## 6. Verdict

- **`IDENTICAL`** — không có drift. Bằng chứng: (a) counts `expect` 574=574, it/test 98=98; (b) multiset test-name 97=97 + describe-name 8=8 khớp từng tên; (c) skip guard cùng điều kiện `DU_LIVE_INFRA === '1'`, cùng cấu trúc all-gated như HEAD, 97 skipped toàn bộ ở cả 8 file; (d) isolation per-suite (businessId + run namespace) và không global wipe; (e) 8 file chạy độc lập + cặp/8-file chạy song song đều exit 0; (f) `tsc` exit 0.
- **Drift list:** ∅.
- **Chưa chứng minh được offline (nói rõ):**
  1. **Thực thi 97 test LIVE** — cần `DU_LIVE_INFRA=1` + PG :5433/Redis :6380 trong window có lease; offline mọi test skip (như HEAD), nên nội dung hành vi giữ nguyên theo multiset nhưng **không chạy lại** để xác nhận pass.
  2. **Parallel LIVE** — harness tự tuyên bố chưa certify; cần 2 file chạy thật song song trên window để đo schema/Redis/queue thực tế (thiết kế namespace có hỗ trợ: schema per-run + Redis DB index 1–14 + prefix, nhưng Redis DB index random có thể trùng giữa 2 file — khi đó vẫn khác prefix/queue name, chưa được kiểm chứng live).
  3. **Scoped cleanup trên DB thật** (so với các suite E2E khác cùng window) — chỉ đọc code xác nhận phạm vi `business_id`/schema; chưa chạy.

## 7. Ranh giới

- READ-ONLY: không sửa source/test nào; chỉ ghi receipt này. HEAD vẫn `b088eec`; các file split giữ nguyên trạng thái working tree (M/??) như nhận.
- Không tick gate, không commit, không chạm `nocobase-10`. Script đếm nằm ở scratchpad phiên (`wtv02-count.js`) — không phải deliverable.
