# DUGate Rework — Hướng dẫn Khởi chạy & Quản lý Local Dev

Bộ script hỗ trợ khởi chạy, phát triển và dừng toàn bộ hệ thống `du-rework` trên môi trường local (Windows PowerShell / CMD / Bash), giả định đã có PostgreSQL và Redis đang chạy trên máy.

---

## ⚡ 1. Khởi chạy nhanh toàn bộ hệ thống (Dev Mode - 1 lệnh duy nhất)

Bạn có thể chạy toàn bộ hệ thống (Orchestrator API + Admin UI, Connector, Worker) trong **1 cửa sổ terminal duy nhất**:

```powershell
pnpm dev
# hoặc
npm run dev
# hoặc
.\scripts\dev.ps1
```

### ✨ Ưu điểm của Dev Mode:
* **1 Terminal duy nhất**: Toàn bộ log của 3 service được gom về 1 màn hình với tiền tố màu sắc riêng biệt:
  - `[orchestrator]` (Xanh dương - Port 3000 API, Port 3001 Admin UI)
  - `[connector]` (Tím - Port 8088)
  - `[worker]` (Vàng - Redis BullMQ Worker)
* **Tự động hóa hoàn toàn**: Tự kiểm tra file `.env.local`, tự build nếu thiếu file `dist`, tự chạy migration database, tự dọn dẹp port bị kẹt trước khi start.
* **Khởi động tuần tự thông minh**: Đợi Orchestrator lắng nghe và sẵn sàng rồi mới đăng ký Worker, tránh lỗi connection refused.
* **Tắt 1 chạm (Ctrl+C)**: Chỉ cần nhấn `Ctrl+C` tại terminal, runner sẽ **tự động tắt sạch sẽ toàn bộ các process con**, không để sót bất kỳ tiến trình ngầm hay cổng bị chiếm dụng.

---

## 🛑 2. Cách tắt Server / Dừng toàn bộ Services

Nếu bạn đang chạy server và muốn tắt:

### Cách 1: Tắt khi đang chạy Dev Mode
Chỉ cần nhấn tổ hợp phím **`Ctrl + C`** tại terminal đang chạy `pnpm dev`. Hệ thống sẽ bắt tín hiệu và tự động tắt sạch sẽ toàn bộ các service trong 1 giây.

### Cách 2: Tắt bằng 1 lệnh duy nhất (Dù chạy ngầm hay chạy nhiều cửa sổ)
Nếu bạn đã khởi chạy bằng `start-all.ps1`, đóng terminal hoặc service đang chạy ngầm, hãy mở terminal gõ:

```powershell
pnpm stop
# hoặc
npm run stop
# hoặc
.\scripts\stop-all.ps1
```
*(Hoặc click đúp chuột vào file [`scripts\stop-all.bat`](file:///D:/Git/dugate/du-rework/scripts/stop-all.bat))*

Script `stop-all` sẽ:
1. Quét các cổng `3000` (API), `3001` (Admin Shell), `8088` (Connector).
2. Dò tìm process Document-Core Worker.
3. Terminate an toàn các PID này và giải phóng cổng ngay lập tức.

---

## 📁 Danh mục các file công cụ trong `scripts/`

| File | Mục đích | Cách chạy |
|---|---|---|
| [`scripts/dev.cjs`](file:///D:/Git/dugate/du-rework/scripts/dev.cjs) | **Dev Runner All-in-One**: Chạy toàn bộ services trong 1 terminal, log màu, tắt bằng Ctrl+C | `pnpm dev` hoặc `node scripts/dev.cjs` |
| [`scripts/dev.ps1`](file:///D:/Git/dugate/du-rework/scripts/dev.ps1) | PowerShell wrapper cho Dev Runner | `.\scripts\dev.ps1` |
| [`scripts/dev.bat`](file:///D:/Git/dugate/du-rework/scripts/dev.bat) | Batch file click đúp chuột chạy Dev Runner | Click đúp chuột |
| [`scripts/stop-all.cjs`](file:///D:/Git/dugate/du-rework/scripts/stop-all.cjs) | **Stop All Services**: Dừng sạch sẽ Orchestrator, Connector, Worker và giải phóng cổng | `pnpm stop` hoặc `node scripts/stop-all.cjs` |
| [`scripts/stop-all.ps1`](file:///D:/Git/dugate/du-rework/scripts/stop-all.ps1) | PowerShell wrapper dừng server | `.\scripts\stop-all.ps1` |
| [`scripts/stop-all.bat`](file:///D:/Git/dugate/du-rework/scripts/stop-all.bat) | Batch file click đúp chuột để dừng server | Click đúp chuột |
| [`scripts/start-all.ps1`](file:///D:/Git/dugate/du-rework/scripts/start-all.ps1) | Mở 3 cửa sổ terminal riêng biệt cho 3 service (chế độ truyền thống) | `powershell -File scripts/start-all.ps1` |
| [`scripts/build-all.cjs`](file:///D:/Git/dugate/du-rework/scripts/build-all.cjs) | Build toàn bộ monorepo theo đúng thứ tự phụ thuộc | `pnpm run build:all` |
| [`scripts/migrate-local.cjs`](file:///D:/Git/dugate/du-rework/scripts/migrate-local.cjs) | Chạy các migrations database cho Orchestrator | `pnpm run migrate:local` |

---

## 🌐 Các cổng & Endpoint sau khi khởi chạy

* **Orchestrator Admin UI**: [http://localhost:3001/admin/login](http://localhost:3001/admin/login)
  - Default Admin: Username `admin` / Password `Admin@123456`
* **Orchestrator Public API**: [http://localhost:3000](http://localhost:3000)
  - Health check: [http://localhost:3000/health](http://localhost:3000/health)
* **Connector Service**: [http://localhost:8088](http://localhost:8088)
  - Readiness check: [http://localhost:8088/health/ready](http://localhost:8088/health/ready)
* **Worker Service**: Lắng nghe hàng đợi Redis BullMQ (`127.0.0.1:6380`)
