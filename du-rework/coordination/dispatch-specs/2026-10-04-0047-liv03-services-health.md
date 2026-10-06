# LIV-03 — Services health & environment evidence (cc_1)

**Packet:** liv03-services-health | **Lane:** cc_1 | Dispatch 2026-10-04T00:47+07:00 (coordinator command-code).

**Bối cảnh:** services đã chạy (da xác nhận sơ bộ: 3000/health=200, 3001/admin/login=200, 8091/health/ready=200). Cần **evidence chính thức** cho LIV-03 (phục vụ LIV-11).

**Việc (read-only):**
1. **Health checks ×3** cách nhau ~10s: `Invoke-WebRequest` tới `http://127.0.0.1:3000/health`, `http://127.0.0.1:3001/admin/login`, `http://127.0.0.1:8091/health/ready` — ghi status + trích body ngắn (không secret).
2. **Bindings:** `netstat -ano` lọc LISTENING cho 3000/3001/8091/5433/6380/9003/9014/8200 → map port→PID; `docker ps --filter name=du-live` (status).
3. **Env inventory (mask):** đọc `du-rework/.env.live` — chỉ liệt kê **tên key** + đánh dấu key nào là secret (mask toàn bộ giá trị); xác nhận 2 deviation: `CONNECTOR_PORT=8091` (8081 bị `graphql-data-connector-agent-1`) và MinIO console `9014` (9004 bị `onlyoffice-documentserver`).
4. **Worker:** xác định worker process đang chạy (process node + log gần nhất của dev runner nếu truy được; nếu chỉ thấy 1 process gộp thì ghi đúng thực tế, không suy diễn).
5. Receipt: `du-rework/coordination/reports/liv03-services-health-2026-10-04.md` — bảng verdict từng mục PASS/FAIL/không-chứng-minh-được, literal commands.

**Ranh giới:** READ-ONLY (curl/netstat/Get-Process/docker ps/đọc file); KHÔNG restart service, không sửa gì, không stop container user; không tick; không commit; không chạm `nocobase-10`.
