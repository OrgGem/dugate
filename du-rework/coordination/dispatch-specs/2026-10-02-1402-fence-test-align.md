# FENCE-TEST-ALIGN — sửa assertion stale + thêm case canonical-bearer (TEST-ONLY)

## Bối cảnh

`du-rework/coordination/reports/tester-fence-red-reverify-2026-10-02.md`: phân loại **(a) test stale** —
case `the x-api-key path is fenced by the key, not by the tenant param` (`services/orchestrator/tests/admin-operations-sql.test.ts:469-483`)
kỳ vọng 403, nhưng route compat (`legacy-http-mount` claims `GET /api/v1/operations` trước canonical) trả **200 envelope legacy**,
bỏ qua param `tenant`, SQL scoped **tenant-A từ key** (probe populated: không lộ tenant-B). Không có fence gap.

## Mục tiêu

1. **Cập nhật case x-api-key** để assert đúng hành vi compat: envelope `{operations,next_page_token}` 200; chứng minh `tenant` bị bỏ qua
   nhưng kết quả vẫn **scoped theo tenant của key**; nếu harness cho phép, dùng fixture **populated** (row A + row B) để assert **không có row B**
   trong kết quả (không weaken assertion — mạnh hơn hiện tại). Ghi chú tham chiếu receipt re-verify trong test comment.
2. **Thêm case canonical-bearer**: Admin-bearer tenant-operator gọi cùng route với tenant foreign → kỳ vọng **403** theo `server.ts:1832-1839`
   (xác nhận nhánh canonical reachable với bearer, facade không chặn bearer — đọc code trước khi viết). Nếu không reachable trong harness → ghi rõ thay vì ép.
3. Chạy suite `admin-operations-sql` (+ focused liên quan) — ghi literal; **0 red**.

## Ranh giới

- Chỉ file test này (+ helper của chính task nếu thật cần; KHÔNG chạm helper của CONV-10 ngoài phần được phép thêm); không sửa production;
  không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/qwen-fence-test-align-2026-10-02.md`.
