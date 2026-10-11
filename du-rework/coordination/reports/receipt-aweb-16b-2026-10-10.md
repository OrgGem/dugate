# Receipt AWEB-16b — Overview server-side metrics

## Hoàn thành

- Thêm `GET /api/v1/operations/metrics` và BFF route tương ứng. BFF xác thực principal/tenant rồi chỉ chuyển tenant scope đã được phép xuống backend; API key bị ghim vào tenant của key.
- Backend tính `total`, `success`, `failure`, `cancelled`, `timedOut`, `running`, số mẫu duration, p50 và p95 trong một câu SQL. Cùng một snapshot DB được dùng cho các số đếm và percentile, tránh kết quả lệch do các truy vấn chạy ở những thời điểm khác nhau.
- Aggregation lọc theo khoảng `[from, to]` đã chọn và `tenantId` hiệu lực khi có scope tenant. Chỉ duration của operation đã hoàn tất, có duration không âm, tham gia percentile.
- Overview dùng aggregation cho các chỉ số tổng quan toàn khoảng thời gian; phản hồi phải khớp tenant và time window hiện tại trước khi được áp dụng. Chỉ báo sampled time và trạng thái stale được hiển thị. Danh sách tối đa 100 operation vẫn phục vụ dữ liệu gần đây/biểu đồ; không dùng mẫu đó để tính headline metrics.
- Thêm test offline cho xác thực query, tenant fencing, truy vấn aggregation, trường hợp platform không có tenant scope và đăng ký BFF route.

## Xác minh

- Jest offline: `aweb-16b-overview-metrics-offline.test.ts` và `aweb-16a-overview-tenant-operations.test.ts` — 2 suites, 8 tests passed.
- Orchestrator service TypeScript typecheck — passed.
- Admin web production build (`pnpm run build`) — passed. Build có cảnh báo hiện hữu về JavaScript chunk lớn hơn 500 kB.
- Không git add, commit hoặc push.

## Giới hạn dữ liệu

Các operation thiếu `started_at`/`completed_at` hoặc có duration âm không được tính vào p50/p95. `durationSamples` được trả về để người vận hành thấy kích thước mẫu percentile. `stale` hiện được xác định theo thời gian thực thi truy vấn (quá 30 giây); endpoint không dùng cache.
