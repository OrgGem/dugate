# RV01 loopback HTTP test — chứng minh end-to-end offline cho các route đã nối

## Bối cảnh

Trong lượt user-steer, lane này đã nối thật: 6 action route, GET/DELETE `/operations/:id`, GET `/operations`,
cancel, resume, billing/*; nhưng mọi test hiện dùng fake DB/host — **chưa có request HTTP thật nào qua server.ts → facade**.
Lane đã đề xuất dựng test loopback HTTP như `admin-operations-sort-http-offline.test.ts`; task này thực hiện đề xuất đó.

## Mục tiêu

1. Tạo **test suite MỚI** (new-file-only, gợi ý `services/orchestrator/tests/rv01-loopback-http-offline.test.ts`):
   dựng HTTP server thật từ `server.ts` (hoặc harness tương đương, tham chiếu `admin-operations-sort-http-offline.test.ts`)
   + fake DB/host offline hiện có; gọi request thật qua socket loopback (127.0.0.1), assert status/body cho:
   - 6 action submit route; GET `/operations`; GET/DELETE `/operations/:id`; cancel; resume; billing balance/usage;
   - các GET route đã nối trong lượt steer của bạn.
2. Ghi **literal pass/fail từng case**; mọi red phải liệt kê trung thực kèm nguyên nhân nghi vấn (cột DB thiếu, wiring thiếu —
   như bạn đã dự đoán: `services 500`, `total_used`, migration 0024, fake-DB gap).
3. Nếu một red chỉ sửa được bằng **source change** → **STOP phần đó**, ghi thành finding (không sửa source).

## Ranh giới (tuyệt đối)

- CHỈ file test mới; KHÔNG sửa file có sẵn (kể cả `server.ts`); KHÔNG đổi source sản phẩm.
- Không infra live (offline thuần, không DB/Redis thật); không `npm install`; không tick gate; không commit.
- Không nhắm `nocobase-10`; không tái hiện lỗi bảo mật legacy.

## Acceptance

- Suite chạy được bằng lệnh ghi rõ trong receipt; bảng case → status/body assert → pass/fail.
- Receipt: `coordination/reports/qwen-rv01-loopback-http-2026-10-02.md` (gồm danh sách red + finding).

## COMMON

- Task của chính lane này (RV01) — không va chạm lease nào (new-file-only).
- Evidence là đầu vào quyết định cho wave fix tiếp theo, không phải blocker.
