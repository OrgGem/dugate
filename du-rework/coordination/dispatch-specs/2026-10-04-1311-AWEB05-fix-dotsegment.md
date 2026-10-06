# Dispatch spec — AWEB-05 fix: reject dot segments in `decodePathSegment` (2026-10-04 13:11 +07)

## Nguồn

- Finding **F-AW05-1** từ `reports/aweb05-verify-2026-10-04.md` §6 (verdict `CHANGES_REQUIRED`, 1 root cause, 2 biểu hiện AC5/AC9).
- Owner: **cc_1** (giữ lease `bff/**`; cc_2 là verifier, không sửa).

## Fix (bounded, ~1–2 dòng)

- `bff/upstream.ts` `decodePathSegment` (:76-87): reject thêm `decoded === '.' || decoded === '..'` (dot-segment đã decode); cân nhắc validate charset id (chỉ `[A-Za-z0-9._~-]` không chứa dot-segment) — giữ tối thiểu, không đổi hành vi id hợp lệ.
- Hệ quả kỳ vọng: `GET /admin/api/api-keys/..` và `/admin/api/connectors/../revisions/1` → **404 trước upstream**; URL không bị WHATWG normalize sang route khác.

## Verify lại (bắt buộc trong packet)

1. Thêm 2 regression case AC5/AC9 vào suite BFF (`tests/aweb05-bff-reads.test.ts` hoặc file mới) — assert 404 + upstream **0 request**.
2. Chạy: jest `aweb05-bff-reads` + `aweb02-bff-foundation` (34/34 kỳ vọng +2 case mới), `tsc`, build; ghi literal.
3. Chạy lại `npx playwright test admin-web/api-keys-connectors.spec.ts` (8/8).

## Lease

- `services/orchestrator/src/app/admin/bff/upstream.ts` (+`handle.ts` nếu cần), test focused mới. Không sửa file khác; không commit; không tick.

## Deliverable

- Receipt: `coordination/reports/aweb05-fix-path-segment-2026-10-04.md` (diff + literal + 2 case mới).

## Trạng thái

- **QUEUED** — dispatch cc_1 sau khi AWEB-04 xong (tránh 2 writer cùng `bff/**`).
