# F-AW05-1 fix — reject dot segments in `decodePathSegment` (2026-10-04)

**Packet:** AWEB-05 fix-dotsegment · **Lane:** cc_1 (owner `bff/**`) · **Dispatch:** 2026-10-04T13:11+07:00.
**Finding:** F-AW05-1 (`reports/aweb05-verify-2026-10-04.md` §6, verdict CHANGES_REQUIRED — 2 biểu hiện AC5/AC9).
**Trạng thái:** DONE. Không commit, không tick. Chỉ 2 file được ghi: `bff/upstream.ts` + test focused; `handle.ts` không chạm (mtime 12:53 từ AWEB-04).

## 1. Diff (bounded)

```diff
# services/orchestrator/src/app/admin/bff/upstream.ts:75-93
-/** Decode one URL path segment; null for empty/oversized/embedded-slash values. */
+/**
+ * Decode one URL path segment; null for empty/oversized/embedded-slash values
+ * and for dot segments (`F-AW05-1`): a decoded `.`/`..` must 404 BEFORE any
+ * upstream call — otherwise URL normalisation could shift the request onto a
+ * different route instead of denying it.
+ */
 export function decodePathSegment(raw: string): string | null {
   let decoded: string;
   try {
     decoded = decodeURIComponent(raw);
   } catch {
     return null;
   }
   if (decoded.length === 0 || decoded.length > 128 || decoded.includes('/') || decoded.includes('\\')) {
     return null;
   }
+  if (decoded === '.' || decoded === '..') return null;
   return decoded;
 }
```

Hệ quả: mọi route dùng segment này (`api-keys/:id`, `connectors/:id/revisions/:rev`, `profiles/:b/:v/:n`) trả **404 trước upstream** khi segment là `.`/`..`; id hợp lệ không đổi hành vi (không siết thêm charset theo đúng yêu cầu "giữ tối thiểu").

## 2. Regression case mới (AC5/AC9)

Thêm vào `tests/aweb05-bff-reads.test.ts` + helper `rawRequest` (raw socket): **bắt buộc** vì `new URL()` của client tự resolve dot-segment trước khi gửi — chỉ raw request line mới chạm đúng seam `decodePathSegment`.

```
it F-AW05-1 AC5: literal ".." api-key id → 404 before upstream (raw target)
   GET /admin/api/api-keys/..            → 404, code NOT_FOUND, stub.requests == 0
it F-AW05-1 AC9: literal ".." connector segment → 404 before upstream (raw target)
   GET /admin/api/connectors/../revisions/1 → 404, code NOT_FOUND, stub.requests == 0
```

## 3. Literal verification

```
# jest (cwd du-rework/services/orchestrator, NODE_ENV=test)
pnpm exec jest --runInBand tests/aweb05-bff-reads.test.ts tests/aweb02-bff-foundation.test.ts tests/aweb04-bff-profiles.test.ts
Test Suites: 3 passed, 3 total
Tests:       46 passed, 46 total          # 44 cũ + 2 case AC5/AC9; JEST=0

pnpm --filter @du/orchestrator typecheck
> tsc --noEmit -p tsconfig.json
TSC=0

# app build (không đổi app code — chạy để xác nhận cây xanh)
pnpm --filter @du/admin-web build
dist/assets/index-C0rx7kEy.js  413.64 kB │ gzip: 133.57 kB
BUILD_EXIT=0

# browser regression riêng spec AWEB-05 (harness thật)
npx playwright test --config admin-web/playwright.config.ts --grep "AWEB-05 API keys"
ok 1..8 admin-web/api-keys-connectors.spec.ts (8 case: ready/copy-once/revoke/empty-error/viewer-denied/connector-missing/connector-ready/320px)
8 passed (13.7s)                            # PW=0
```

## 4. Boundary

| File | Thay đổi |
|---|---|
| `bff/upstream.ts` | +1 guard `decoded === '.' || decoded === '..'` + doc |
| `tests/aweb05-bff-reads.test.ts` | +helper `rawRequest` + 2 case AC5/AC9 |
| `bff/handle.ts` | **không chạm** (mtime 12:53 từ AWEB-04) — không cần sửa |

Không file nào khác bị ảnh hưởng; harness + file tạm đã dọn, port đã đóng.

## Verdict

**F-AW05-1 FIXED + verified**: dot-segment đã decode → 404 trước upstream trên cả 2 route (AC5/AC9 assert kèm bằng chứng âm `upstream 0 request` qua raw request line); 46/46 jest (44+2), tsc 0, build 0, playwright spec AWEB-05 8/8. Không đổi hành vi id hợp lệ.
