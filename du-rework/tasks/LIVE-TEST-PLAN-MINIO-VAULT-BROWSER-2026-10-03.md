# Kế hoạch Kiểm thử Live: MinIO S3 + HashiCorp Vault + Functional API + Playwright / Browser-Use UI

> **Hold và acceptance bổ sung 2026-10-04:** [PLAN04-03](PLAN-COMPLETION-2026-10-04.md#4-đối-soát-và-bổ-sung-live-evidence) đối soát từng gate với raw evidence. GO trong report live ngày 03/04 chưa đủ acceptance: `liv05b-vault-scope-2026-10-04.md` ghi Transit deny; Vault root-token roundtrip là smoke; browser hiện chỉ token login/navigation; E2E inline-text bật migration window không chứng minh encrypted file/output chain. Bổ sung các ca dưới đây rồi independent verify/review, không tick từ plan.

> **Đối chiếu Admin Web 2026-10-04:** [AWEB-00..08](ADMIN-WEB-DELIVERY-2026-10-04.md) là plan xây giao diện mới. `LIV-07..10` là kịch bản smoke/live trên route và build ghi trong receipt, có thể là renderer cũ hoặc React theo cờ rollout; không tự chứng minh toàn bộ `ACUI-10`, `ADM-UX-07` hoặc đóng `G-ADMIN-OPS`. Các credential/cookie/URL ví dụ bên dưới phải lấy từ môi trường test thật, không coi là contract production.

> **For Agents:** REQUIRED WORKFLOW: Sử dụng kế hoạch này để triển khai và thực thi kiểm thử tích hợp trên hạ tầng thật (Live Infrastructure). Toàn bộ bằng chứng (executable receipts, logs, screenshots) là điều kiện tiên quyết để đóng các Release Gate đang mở: `G-DATA`, `G-SEC`, `G-ENC`, `G-ADMIN-OPS` và tiến tới `G6`.

**Goal:** Xây dựng môi trường kiểm thử Live hoàn chỉnh với MinIO (S3 tương thích kèm Object Versioning) và HashiCorp Vault (KV v2 + Transit KMS), vận hành toàn bộ chu trình 3 services (Orchestrator, Connector, Document-Core Worker), và tổ chức các bộ test chức năng backend API kết hợp kiểm thử UI tự động (Playwright / Browser-Use) trên Admin Web UI thật.

**Architecture:**
- **Infrastructure Layer (Docker Compose)**: PostgreSQL 16 (`:5433`), Redis 7 (`:6380`), MinIO S3 (`:9003` API, `:9004` Console, bucket `du-artifacts-live` bật Versioning), HashiCorp Vault (`:8200` dev server với KV v2 và Transit engine).
- **Service Layer (Node.js 20+ / pnpm monorepo)**: Orchestrator API (`:3000`), Admin Shell (`:3001`), Connector (`:8091`), Document-Core Worker (kết nối Redis queue `du:queue:document-core`).
- **Functional API Test Layer**: Jest / ts-jest suites chạy với cờ `DU_LIVE_INFRA=1`, kiểm thử S3 upload/streaming/version-pinning và Vault AppRole writer/reader/CAS/rotation.
- **UI Test Layer**: Playwright test suite (`tests/browser`) và AI Browser-Use agent tương tác trực tiếp trên trình duyệt Chromium thật với Admin Shell sống (Authentication, API Key issuance, Connector config to Vault, Live operations triage).

**Tech Stack:** Docker Compose v2, MinIO, HashiCorp Vault, PostgreSQL 16, Redis 7 (BullMQ), Node.js / TypeScript, Playwright, Jest, `@aws-sdk/client-s3`.

---

## 1. Ma trận phân công Agent & File-Lease

Để đảm bảo các Agent có thể thực thi song song mà không xung đột file hoặc race condition trên database/queue:

| Phân hệ / Task ID | Agent Role đề xuất | Phạm vi file / Lease độc quyền | Mục tiêu nghiệm thu |
|---|---|---|---|
| **LIV-01..02** | **Infra Agent** | `du-rework/infra/docker-compose.live.yml`, `du-rework/infra/scripts/*` | Docker stack khởi động sạch 4 container: PG, Redis, MinIO, Vault. Script init chạy thành công. |
| **LIV-03** | **Platform Runner Agent** | `du-rework/.env.live`, script khởi động service | Khởi chạy 3 services (Orchestrator, Connector, Worker) trỏ vào `.env.live`. Health checks 200 OK. |
| **LIV-04** | **Storage Test Agent** | `du-rework/services/orchestrator/tests/data-02-04-live-s3.test.ts` | Test S3 live pass 100%: Single PUT, Multipart chunked, Version pinning, Delete versioning. |
| **LIV-05** | **Security/KMS Test Agent** | `du-rework/services/orchestrator/tests/vault-live.test.ts`, `services/connector/tests/*` | Test Vault live pass: AppRole write/read KV v2, Transit encrypt/decrypt, tenant isolation, CAS rotation. |
| **LIV-06** | **Pipeline E2E Test Agent** | `du-rework/tests/e2e/live-pipeline-e2e.test.ts` | End-to-End: Ingest document → Worker streaming MinIO → Connector Vault credentials → Result output. |
| **LIV-07..10** | **UI / Browser-Use Agent** | `du-rework/tests/browser/tests/live-admin-e2e.spec.ts`, screenshots | Browser automation: Login, Tạo API Key, Cấu hình Connector vào Vault, Triage operations live. |
| **LIV-11** | **Reviewer / Coordinator** | `du-rework/coordination/reports/*`, `du-rework/tasks/README.md` | Đối chiếu test receipts, thẩm định log/screen, đánh giá chuyển đổi trạng thái Release Gates. |

---

## 2. Chi tiết các bước thực hiện (Bite-Sized Implementation Tasks)

### Giai đoạn 1: Dựng Hạ tầng Live (MinIO + Vault + PG + Redis)

#### Task LIV-01: Tạo file cấu hình Docker Compose Live (`docker-compose.live.yml`)
**Files:**
- Create: `du-rework/infra/docker-compose.live.yml`

**Chi tiết cấu hình:**
- PostgreSQL: Port `127.0.0.1:5433`, DB `du_orchestrator_test`, user `du`, password `du-test-only`.
- Redis: Port `127.0.0.1:6380`.
- MinIO: Image `minio/minio:latest`, Ports `127.0.0.1:9003:9000` (API) và `127.0.0.1:9004:9001` (Web Console), Root User: `minioadmin`, Root Password: `minioadmin_secret`.
- HashiCorp Vault: Image `hashicorp/vault:latest`, Port `127.0.0.1:8200:8200`, Dev Mode với token `root-dev-token`.

**Lệnh kiểm tra:**
```bash
docker compose -f du-rework/infra/docker-compose.live.yml config --quiet
docker compose -f du-rework/infra/docker-compose.live.yml up -d
docker compose -f du-rework/infra/docker-compose.live.yml ps
```
*Kỳ vọng:* Cả 4 container (`postgres`, `redis`, `minio`, `vault`) đều ở trạng thái `running / healthy`.

---

#### Task LIV-02: Tạo Script Bootstrap & Khởi tạo MinIO Bucket + Vault Engines
**Files:**
- Create: `du-rework/infra/scripts/init-live-infra.ps1` (và bản `init-live-infra.sh` cho Linux/macOS)

**Nội dung script cần thực hiện:**
1. **Khởi tạo MinIO**:
   - Sử dụng MinIO Client (`mc` qua container hoặc REST API) tạo bucket `du-artifacts-live`.
   - **Bắt buộc**: Bật **Object Versioning** trên bucket:
     ```bash
     mc alias set local http://127.0.0.1:9003 minioadmin minioadmin_secret
     mc mb --ignore-existing local/du-artifacts-live
     mc version enable local/du-artifacts-live
     ```
2. **Khởi tạo HashiCorp Vault**:
   - Enable KV version 2 tại mount point `secret`:
     ```bash
     vault secrets enable -version=2 -path=secret kv
     ```
   - Enable Transit Secrets Engine tại mount point `transit`:
     ```bash
     vault secrets enable -path=transit transit
     vault write -f transit/keys/du-app-encryption-key type=aes256-gcm96
     ```
   - Nạp các policies từ `du-rework/infra/vault/policies/`:
     - `orchestrator-writer.hcl`: Quyền ghi KV v2 `secret/data/du/connector/*` và encrypt/decrypt transit.
     - `connector-reader.hcl`: Quyền đọc KV v2 `secret/data/du/connector/*` (không có quyền ghi).
   - Khởi tạo AppRole hoặc token riêng cho Orchestrator (`vault-token-orch`) và Connector (`vault-token-conn`).

**Lệnh thực thi & Kiểm tra:**
```powershell
powershell -ExecutionPolicy Bypass -File du-rework/infra/scripts/init-live-infra.ps1
```
*Kỳ vọng:* Exit code 0, in ra thông báo MinIO bucket `du-artifacts-live` đã enabled versioning, Vault KV v2 và Transit engine đã sẵn sàng.

---

### Giai đoạn 2: Khởi chạy Core Services trên Môi trường Live

#### Task LIV-03: Thiết lập `.env.live` và Khởi động Orchestrator, Connector, Worker
**Files:**
- Create: `du-rework/.env.live`
- Create / Update: `du-rework/scripts/dev-live.ps1`

**Cấu hình `.env.live` bắt buộc:**
```ini
DU_LIVE_INFRA=1
DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test
REDIS_URL=redis://127.0.0.1:6380
AUTO_MIGRATE=true

# Storage: MinIO S3
ARTIFACT_STORAGE_BACKEND=s3
ARTIFACT_S3_ENDPOINT=http://127.0.0.1:9003
ARTIFACT_S3_BUCKET=du-artifacts-live
ARTIFACT_S3_REGION=us-east-1
ARTIFACT_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin_secret

# Security: HashiCorp Vault
VAULT_ADDR=http://127.0.0.1:8200
VAULT_TOKEN=root-dev-token
VAULT_TRANSIT_MOUNT=transit
VAULT_TRANSIT_KEY=du-app-encryption-key
VAULT_KV_MOUNT=secret
DU_ENCRYPTION_METADATA_ENABLED=true
DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED=true

# Service Endpoints & Tokens
PORT=3000
ADMIN_SHELL_PORT=3001
# DEVIATION NOTE: CONNECTOR_PORT changed to 8091 (8081 occupied by user's graphql-data-connector-agent-1)
CONNECTOR_PORT=8091
RUNTIME_TOKEN=du-live-runtime-token-secret-32b
ADMIN_TOKEN=du-live-admin-token-secret-32b
SERVICE_IDENTITY_SECRET=nCwZJJzd9E9/L5zkl7guuqIHLGm7GAFJpGnAWb5oxTo=
INVOCATION_GRANT_SECRET=4TVYzMa0A5lCNrYY00Hb2nMz7Zhjc+Q7IRguauSmngg=
CONNECTOR_ENCRYPTION_KEY=JkfxSXSNv9dy56bWh0w+CVfHU3EWaw+IA/5AcB8CVnc=
```

**Thực thi:**
```powershell
# Khởi động toàn bộ dịch vụ qua dev-live.ps1 (chạy nền hoặc terminal riêng)
.\scripts\dev-live.ps1
```
*Kỳ vọng:*
- `http://127.0.0.1:3000/health` → `200 OK`
- `http://127.0.0.1:3001/admin/login` → Trả về trang đăng nhập Admin Shell.
- `http://127.0.0.1:8091/health/ready` → `200 OK`.
- Worker `document-core` báo log đã kết nối hàng đợi Redis `du:queue:document-core`.

---

### Giai đoạn 3: Kiểm thử Chức năng Backend API (Functional / Integration)

#### Task LIV-04: Kiểm thử Live S3 Storage với MinIO (DATA-01..05 & RFX-03..06)
**Files:**
- Execute: `du-rework/services/orchestrator/tests/data-02-04-live-s3.test.ts`
- Execute: `du-rework/services/orchestrator/tests/crx02-rfx05res-s3-read-guard.test.ts`

**Các trường hợp kiểm thử (Test Cases):**
1. **Single PUT Upload**: Client gửi file qua app streaming encryption gateway → private MinIO chỉ nhận ciphertext → commit verify hash/size/tag/VersionId theo manifest. Presigned PUT chỉ cho ciphertext do app đã tạo trong path được chứng minh; không bypass bằng direct plaintext upload.
2. **Multipart Chunked Upload**: File lớn 65MB+ qua bounded gateway/authenticated chunking → storage multipart parts/complete theo contract → xác nhận checksum/manifest, abort orphan và memory budget; không chỉ kiểm MinIO gom hai part.
3. **S3 Version Pinning (RFX-05)**: Khi upload lại cùng object key, MinIO sinh `VersionId` mới. Verify rằng Orchestrator ghim đúng `VersionId` gốc vào artifact manifest, việc retry hoặc đọc lại không bị ghi đè nhầm bản mới.
4. **Delete Versioning**: Xóa artifact kèm `VersionId` cụ thể chỉ xóa version đó, không tạo delete marker gây rác storage.
5. **Fail-closed Plaintext Guard**: Khi bật mã hóa (`DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED=1`), artifact tải lên MinIO phải ở dạng ciphertext AES-256-GCM. Quét thô bytes trên MinIO không được chứa chuỗi nhạy cảm (plaintext sentinel scan).

**Lệnh chạy:**
```bash
cd du-rework
$env:DU_LIVE_INFRA="1"
pnpm --filter @du/orchestrator test -- tests/data-02-04-live-s3.test.ts tests/crx02-rfx05res-s3-read-guard.test.ts
```
*Kỳ vọng:* Tất cả các test cases PASS, exit code 0.

---

#### Task LIV-05: Kiểm thử Live HashiCorp Vault Integration (VAULT-01..06 & G-SEC)
**Files:**
- Create / Run: `du-rework/services/orchestrator/tests/vault-live.test.ts`

**Điều kiện acceptance:** owner sửa Transit policy/composition theo finding `liv05b` rồi test lại. Harness dùng writer/reader và encrypt/decrypt/rewrap identities theo deployed policy với AppRole/Kubernetes auth đã chọn; root token chỉ dùng provisioning namespace, không dùng thay machine identity trong assertion. Ghi role/capability mapping, auth mode và version vào receipt; wrong-role/tenant/account phải deny. Suite hiện có 3 test root-token không phủ đủ 5 trường hợp hoặc claim CAS nếu không gửi `options.cas` và kiểm conflict. Missing machine auth/policy giữ G-SEC/G-ENC hold.

**Các trường hợp kiểm thử (Test Cases):**
1. **Orchestrator Write-Only**: Admin API lưu provider key cho OpenAI/Anthropic → Orchestrator gọi Vault KV v2 ghi tại `secret/data/du/connector/{tenant}/{connector}/{account}` với CAS (Check-And-Set). Kiểm tra trong Postgres chỉ lưu metadata ref (`mount`, `path`, `key`, `version`), **không lưu raw secret**.
2. **Connector Read-Only**: Connector nhận grant từ Orchestrator → giải mã account binding → gọi Vault KV v2 đọc đúng version đã pin.
3. **Tenant Boundary Denial**: Connector của Tenant A cố tình đọc secret path của Tenant B → Vault policy hoặc Connector layer trả về `403 FORBIDDEN` ngay lập tức (fail-closed, không gọi upstream provider).
4. **Transit KMS DEK Wrapping**: Sinh Data Encryption Key (DEK) ngẫu nhiên 32-byte → gọi `vault transit encrypt` để bọc DEK → giải mã DEK qua `vault transit decrypt` → so sánh round-trip nguyên vẹn.
5. **Key Rotation & Revocation**: Xoay key version trong Vault → các request mới nhận version mới; thu hồi key (revoke) → các invocation tiếp theo bị từ chối 502/403 rõ ràng.

**Lệnh chạy:**
```bash
cd du-rework
$env:DU_LIVE_INFRA="1"
pnpm --filter @du/orchestrator test -- tests/vault-live.test.ts
```
*Kỳ vọng:* 100% tests PASS, zero raw secret leakage trong response hoặc database.

---

#### Task LIV-06: Kiểm thử Live End-to-End Pipeline (Ingest → Worker → MinIO → Vault → Result)
**Files:**
- Create / Run: `du-rework/tests/e2e/live-pipeline-e2e.test.ts`
- Runner wrapper: `du-rework/tests/integration/live-pipeline-e2e.integration.test.ts` import suite trên; Jest integration chỉ discover `*.integration.test.ts`. Kiểm `--listTests` trước chạy; rename/move phải cập nhật wrapper.

**Tách smoke và acceptance:** inline-text case hiện tại giữ làm smoke. Thêm file input/output và provider-mediated case theo PLAN04-03; acceptance boot tắt `ARTIFACT_STORAGE_MIGRATION_WINDOW` (giá trị `false`) và dùng machine identities thật. Không dùng direct plaintext presigned upload hoặc unsealed artifact read để đạt pass.

**Quy trình kiểm thử End-to-End thật:**
1. Tạo một tenant mới và cấp API key qua Admin API.
2. Cấu hình Connector provider sử dụng Mock Service hoặc offline stub có ghi secret vào Vault thật.
3. Client gọi Public API:
   `POST http://127.0.0.1:3000/api/v1/businesses/document-core/actions/ingest`
   File đi qua gateway mã hóa streaming của app trước private MinIO, pin VersionId/hash; thêm fixture variant thật sự gọi Connector tới mock provider quan sát request. Inline-text parse không chứng minh provider credential chain.
4. Orchestrator tạo Operation theo state contract đã freeze (`ACCEPTED` hoặc `PENDING_INGESTION` theo nguồn), ghi task/outbox atomically rồi dispatcher enqueue BullMQ; không hardcode state `PENDING` ngoài contract.
5. Worker `document-core` nhận job:
   - Tải file từ MinIO S3 bằng stream có giới hạn (bounded stream).
   - Giải mã payload bằng Transit DEK.
   - Variant cần provider gọi Connector; Connector resolve Vault credential đúng tenant/account/revision bằng reader identity, worker không nhận raw credential.
   - Tạo output đúng recipe/MIME, app mã hóa trước ghi bucket `du-artifacts-live`; kiểm bytes S3 không chứa plaintext sentinel và manifest/tag/VersionId đúng.
   - Báo cáo hoàn thành lên Orchestrator (`SUCCEEDED`).
6. Client poll `GET http://127.0.0.1:3000/api/v1/operations/{id}` đến khi đạt `SUCCEEDED`.
7. Client gọi `GET /api/v1/operations/{id}/result`, dùng artifact download link theo frozen result contract; không giả định `downloadUrl` field hoặc direct S3 plaintext. Xác nhận bytes/MIME/hash roundtrip; khi recipient encryption bật, external test client giải mã đủ envelope. Unsealed/corrupt-tag/wrong-key/Vault-outage phải fail closed.

**Lệnh chạy:**
```bash
cd du-rework
$env:DU_LIVE_INFRA="1"
pnpm test:integration
```
*Kỳ vọng:* Luồng kết thúc trong vòng < 15 giây, operation state `SUCCEEDED`, output artifact tải về có nội dung chính xác.

---

### Giai đoạn 4: Kiểm thử Giao diện Người dùng Live (Playwright & AI Browser-Use)

Kiểm thử giao diện người dùng trên Admin Shell thật (`http://127.0.0.1:3001`), không dùng synthetic in-memory stubs.

#### Task LIV-07: Chuẩn bị Live Playwright Harness
**Files:**
- Create: `du-rework/tests/browser/tests/live-admin-e2e.spec.ts`
- Cấu hình base URL: `http://127.0.0.1:3001`
- Đảm bảo Playwright Chromium đã được cài đặt: `npx playwright install chromium`.

---

#### Task LIV-08: Kịch bản UI 1 — Xác thực Admin & Quản lý Phiên (Authentication & Session)
**Quy trình tương tác trình duyệt:**
1. Mở trình duyệt truy cập: `http://127.0.0.1:3001/admin/login`.
2. Kiểm tra form theo `DU_ADMIN_AUTH_MODE` của môi trường test (`local`, `oidc` hoặc `both`); local form có username/password, OIDC điều hướng IdP. Ghi rõ mode được test và mode chưa test.
3. Dùng tài khoản test được seed và cấp qua biến môi trường/fixture bảo mật của harness; không hardcode mật khẩu trong plan hoặc log.
4. Click `Đăng nhập`.
5. **Kiểm chứng (Assertions)**:
   - URL chuyển hướng về `http://127.0.0.1:3001/admin/overview`.
   - Trình duyệt nhận cookie session đúng cấu hình hiện hành (opaque `du_session` nếu dùng local/OIDC), `HttpOnly`, `Secure` trên HTTPS và `SameSite` theo policy; ghi tên/cờ cookie quan sát được trong receipt.
   - Thẻ điều hướng hiển thị đúng principal/role của tài khoản test; không suy tên/role từ giá trị cố định.
   - Chụp ảnh màn hình lưu tại `tests/browser/artifacts/live-admin-overview.png`.

---

#### Task LIV-09: Kịch bản UI 2 — Cấp phát API Key & Cấu hình Vault Credentials
**Quy trình tương tác trình duyệt:**
1. **Tạo API Key cho Tenant**:
   - Từ thanh điều hướng, click menu **API Keys** (`/admin/api-keys`).
   - Click nút **Tạo API Key mới**.
   - Chọn Tenant ID: `tenant-default` (hoặc tenant test vừa tạo).
   - Click **Xác nhận tạo**.
   - **Kiểm chứng**: Modal popup xuất hiện hiển thị **Raw API Key một lần duy nhất** (`du_...`). Nút **Copy** hoạt động. Sau khi đóng modal, bảng danh sách xuất hiện hàng mới với prefix hiển thị và trạng thái `ACTIVE`.
2. **Cấu hình Connector & Lưu Secret vào HashiCorp Vault**:
   - Click menu **Connectors** (`/admin/connectors`).
   - Chọn connector `openai-vision-connector`.
   - Click **Cấu hình Credentials / Key mới**.
   - Điền Slot Name: `api-key`, Secret Value: `sk-test-live-vault-secret-123456`.
   - Click **Lưu vào Vault**.
   - **Kiểm chứng**:
     - Giao diện báo trạng thái ghi và version/metadata được phép hiển thị; không hiện Vault path nội bộ hoặc raw secret trong DOM/URL/log.
     - Sau lưu/reload, UI chỉ hiện trạng thái đã cấu hình hoặc ref an toàn, không hiện bất kỳ prefix/suffix nào của secret.
     - Click nút **Test Connection**: Hệ thống gọi action test và trả về trạng thái `CONNECTED (200 OK)`.
   - Chụp ảnh màn hình lưu tại `tests/browser/artifacts/live-connector-vault.png`.

---

#### Task LIV-10: Kịch bản UI 3 — Triage, Giám sát Operations & Tải Artifact từ MinIO
**Quy trình tương tác trình duyệt:**
1. Click menu **Operations** (`/admin/operations`).
2. **Kiểm chứng Danh sách Operations**:
   - Bảng hiển thị Operation ID từ đợt chạy của `LIV-06`.
   - Trạng thái hiển thị badge màu xanh: `SUCCEEDED`.
   - Action hiển thị: `document-core / ingest`.
3. **Kiểm tra Chi tiết Operation**:
   - Click vào dòng operation để xem chi tiết.
   - Drawer hoặc trang chi tiết mở ra, hiển thị:
     - Thời gian bắt đầu, thời gian hoàn thành (Duration).
     - Token usage & Chi phí ước tính (LLM Cost metrics).
     - Danh sách Artifacts sinh ra (kèm định dạng, kích thước bytes).
4. **Tải Artifact**:
   - Click nút **Tải xuống (Download)** tại artifact kết quả.
   - Trình duyệt nhận download theo result/artifact contract hiện hành; không giả định 302 presigned URL hay 200 proxy. Xác nhận file không rỗng và nội dung khớp với văn bản đã xử lý.
5. Chụp ảnh màn hình lưu tại `tests/browser/artifacts/live-operations-detail.png`.

---

### Giai đoạn 5: Tổng hợp Bằng chứng & Đóng Release Gates

#### Task LIV-11: Biên tập Báo cáo Nghiệm thu (Evidence Reconciliation Receipt)
**Files:**
- Create: `du-rework/coordination/reports/live-test-minio-vault-browser-receipt-2026-10-03.md`

**Nội dung bắt buộc trong Receipt:**
1. **Thông tin môi trường**: Commit SHA (`HEAD`) và working-tree/service/UI build digest khi cây dirty, ngày giờ, Node/Docker/MinIO/Vault versions, namespace DB/Redis/S3/Vault, auth mode/role identities và migration-window flag. Không ghi token/secret.
2. **Bảng tổng hợp kết quả (Pass/Fail/Skip)**:
   - MinIO S3 functional tests: số lượng tests pass.
   - HashiCorp Vault tests: số lượng tests pass.
   - End-to-end pipeline: thời gian xử lý, trạng thái operation.
   - Playwright Live UI tests: mỗi assertion/hành động và DB/Vault/audit side effect theo LIV-08..10, auth/tenant/role/CSRF/CAS matrix; screenshots kèm route/build. Navigation smoke và mutation/auth acceptance ghi riêng; chưa chạy là pending/skipped, không điền mặc định 3 pass.
3. **Kiểm tra rò rỉ bảo mật (Sink Sentinel Scan)**:
   - Quét operation/Profile snapshots, task/outbox/queue/claim/checkpoint, S3 bytes và logs theo PLAN04-01/03; secret sentinel/raw key chỉ được copy-once trong issue response theo policy, không tồn tại trong GET/reload/error/log. Báo counts và invariant, không in secret tìm thấy.
4. **Kiến nghị trạng thái Release Gates**:
   - Liệt kê phần bằng chứng mà `LIV-*` đóng góp cho từng gate `G-DATA`, `G-SEC`, `G-ADMIN-OPS`, `G-ENC`; liệt kê acceptance còn thiếu và test skipped/fail. Chỉ đề xuất **GO** khi toàn bộ điều kiện của gate tương ứng có bằng chứng trên build hiện hành; ba browser scenario của plan này một mình không đủ.
   - Map mỗi parent acceptance → fixture/test/raw output → build → verifier/reviewer; dẫn `liv05b` và mọi receipt đỏ mới hơn, ghi fix owner/rerun. DATA còn cần log pipeline/deploy/restore; ENC còn cần full encryption/recipient chain; SEC còn OIDC/Vault machine auth; Admin cần mutation/service/UI verdict. GO lịch sử không supersede failure mới.

---

## 3. Hướng dẫn dành cho AI Agents khi thực thi Plan

Khi một Agent nhận task trong kế hoạch này:
1. **Luôn tuân thủ quy tắc Worktree & Port**:
   - Làm việc hoàn toàn trong `D:\Git\dugate\du-rework\`.
   - Không chạm vào cổng của DUGate legacy (`5432`, `6379`, `2023`). Luôn dùng đúng cổng của rework: Postgres `:5433`, Redis `:6380`, MinIO `:9003`, Vault `:8200`, Orchestrator `:3000`, Admin `:3001`, Connector `:8091`.
2. **Quy tắc chạy Browser Test với Agent**:
   - Nếu agent có công cụ browser tương tác (như `/browser` hoặc `browser-use`): Sử dụng kịch bản click và selectors đã mô tả ở Task LIV-08..LIV-10 để ghi nhận kết quả và chụp screenshot.
   - Nếu chạy qua Playwright test runner: Chạy lệnh `pnpm --filter @du/browser-tests test -- live-admin-e2e.spec.ts` và đọc file output `artifacts/artifacts-summary.json`.
3. **Quy tắc ghi nhận kết quả (Receipts)**:
   - Tuyệt đối không tự ý tick `[x]` vào các file task gốc (`P8`, `SEC`, `DATA`) nếu chưa có file receipt với mã lệnh, exit code literal `0` và kết quả thực tế.
   - Khi hoàn thành task, ghi nhận receipt vào `du-rework/coordination/reports/` theo quy chuẩn của dự án.

---

## 4. Bổ sung 2026-10-05 — Live item MỚI (append-only; §§1–3 giữ nguyên byte-for-byte)

> **Nguồn:** các slice implemented/verified-offline trong cửa sổ 2026-10-05 00:30–01:4x (receipt dẫn từng item). Đây là **kịch bản live còn thiếu**, không thay acceptance offline đã settle và không tự đóng gate. Mọi item giữ nguyên quy tắc cũ: window riêng, namespace cô đập, no-secret-in-log, không tick từ plan.
>
> **Matrix nhanh:** `LIV-CW-01` credworkflow Vault chain · `LIV-EM-01` ENCMETA result_ref backfill window (ENC-09) · `LIV-CM-01` connector management round-trip · `LIV-SS-01` session provider-side · `LIV-PC-01` carrier observed provider request.

### LIV-CW-01 — credworkflow Vault chain (writer thật + compose + E2E)

**Nguồn:** [credworkflow-impl-2026-10-05](../coordination/reports/credworkflow-impl-2026-10-05.md) §5 (offline: 12 test ×3 + regression 89) · prep cùng ngày.

**Điều kiện tiên quyết:**
- Vault dev thật `:8200` (KV v2 mount `secret`, policy writer theo `infra/vault/policies/orchestrator-writer.hcl`), connector service thật `:8091`.
- `.env.live` thêm: `DU_VAULT_KV_OPTIONS` (JSON, bắt buộc `vaultAddress`; tùy chọn `kvMount`, `requestTimeoutMs`) + `DU_VAULT_KV_TOKEN` (machine identity — **không** root token trong assertion, xem LIV-05/liv05b) + tùy chọn `DU_CONNECTOR_INITIAL_BINDINGS`; `connectorBaseUrls` phải non-empty (thiếu ⇒ boot refuse typed).
- Boot semantics đã pin: env đủ ⇒ workflow defined; partial/hỏng ⇒ `CredentialWorkflowBootError` (refuse-boot, không degrade im lặng); vắng hết ⇒ `undefined` + capabilities `credentialWorkflow:false`.

**Cách chạy:**
1. Boot orchestrator với env trên (`.\scripts\dev-live.ps1`), kiểm `GET /health` 200 và `GET /api/v1/admin/connectors/capabilities` → `credentialWorkflow:true`.
2. Chuỗi thật qua dispatcher/routes: `connector.upsert(create)` → `connector.bootstrap` (nếu cần) → `connector.credential_rotate` (có `cas` và lần lặp CAS conflict) → `activate` → `test` → `disable`.
3. Chạy thêm `DU_LIVE_INFRA=1 pnpm --filter @du/orchestrator test -- tests/vault-live.test.ts` cho Transit/KV round-trip theo role matrix.

**Kỳ vọng:** rotate tạo version mới trong Vault KV v2 (metadata verify độc lập bằng CLI/API, chỉ ghi version number — không giá trị); CAS sai ⇒ `412→CAS_CONFLICT`, 403 ⇒ `CAPABILITY_DENIED`, Vault down ⇒ **503 + 0 request tới connector + 0 audit**; response/audit/SQL/log **không chứa sentinel secret** (kể cả base64); partial env boot ⇒ refuse-boot typed. **GAP còn lại:** connector-side reader thật (D5) — đọc lại secret qua connector là "later"; nếu chưa có thì ghi rõ live gap, không thay bằng đọc tay.

### LIV-EM-01 — ENCMETA result_ref backfill window (ENC-09)

**Nguồn:** [encmeta-resultref-impl-2026-10-05](../coordination/reports/encmeta-resultref-impl-2026-10-05.md) §4 (offline: 10 test ×3 + regression 61 + SDK 691).

**Điều kiện tiên quyết:**
- PG thật `:5433` với dữ liệu legacy thật: `tasks.result_ref` / `operations.result_ref` (text) còn plaintext; metadata crypto seam (APP key/`ENCRYPTION_KEY`) bật ở orchestrator; `ARTIFACT_STORAGE_MIGRATION_WINDOW` đúng quyết định window (acceptance ENC-09 dùng `false` cho ca fail-closed, window `true` cho ca backfill compat).
- Row cũ + tenant mix để kiểm cross-tenant; không seed secret thật — dùng sentinel.

**Cách chạy:**
1. Submit operation mới đi qua `completeTask` (writer) với seam bật → query PG **chỉ counts/marker** trên 2 cột (không in giá trị).
2. Mở lại qua **R1** `GET /api/v1/operations/{id}/result`, **R2** `getChildren`, **R3** `reconcileParentJoin` → round-trip đúng.
3. Ca legacy: window `true` → plaintext verbatim (đọc được); hạ window `false` (hoặc seam yêu cầu) → row plaintext phải fail-closed `NOT_SEALED` (không tự nhận plaintext).
4. Ca tamper/cross-slot: envelope sửa 1 ký tự ⇒ `AUTHENTICATION_FAILED`/`CONTEXT_MISMATCH`; `tasks↔operations` cross-slot và cross-tenant ⇒ deny.

**Kỳ vọng:** 2 cột chứa envelope `{version:1, algorithm:'aes-256-gcm'}` (JSON text convention như `input_ref`), sentinel **không tồn tại** trong cột/SQL/log; open round-trip khớp chuỗi gốc dưới đúng slot/refId; join-summary không bị nesting leak; legacy trong window vẫn đọc byte-identical. **Backfill thật (migrate legacy → sealed) là quyết định/window riêng — cập nhật docs ENC-09 khi bắt đầu, không nằm trong item này.**

### LIV-CM-01 — connector management round-trip (ledger thật + 5 action)

**Nguồn:** [connector-wire-a-2026-10-05](../coordination/reports/connector-wire-a-2026-10-05.md) §5 (offline: 23 test ×3 + regression 66; packet B BFF/UI chưa làm).

**Điều kiện tiên quyết:**
- Connector service thật `:8091` với management API; orchestrator compose store từ `connectorBaseUrls` (rỗng ⇒ seam `undefined`, fail-closed); tùy chọn `connectorManagementHeaders` cho service identity `connector:manage`.
- Window `DU_LIVE_INFRA=1` (chạy kèm `admin-base-routes` — suite window-gated pin shape placeholder).

**Cách chạy:**
1. `GET /api/v1/admin/connectors` (list) + `GET .../revisions/:rev` (`latest|current`/digits) — xác nhận ledger thật khi compose (không placeholder).
2. Chuỗi mutation qua `POST /api/v1/admin/actions`: `connector.upsert` (create) → `activate` (CAS; chạy 2 lần để ép conflict) → `connector.test` → `disable`/`retire`.
3. `DU_LIVE_INFRA=1 pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts` để chốt route shape trong window.

**Kỳ vọng:** list giữ redaction `[REDACTED]`; unknown connector ⇒ 404 (không open proxy); activate CAS thua ⇒ **409 STATE_CONFLICT, không audit**; thiếu store ⇒ **503 trước mọi side effect**; transport lỗi ⇒ 503 reconcile-safe; status lạ ⇒ 502 **không echo body**; `connector.test` narrow `{ok, errorCode?}` và không audit (probe); 4 mutation audit đúng principal fields; Idempotency-Key replay ⇒ 1 store call + 1 audit. **Đối chiếu credential rotate trong cùng chuyến với LIV-CW-01.**

### LIV-SS-01 — session provider-side (sessionRef tới provider thật)

**Nguồn:** [connector-session-leg-2026-10-05](../coordination/reports/connector-session-leg-2026-10-05.md) (offline 19 test ×3; forward đã có sẵn — thiếu bằng chứng non-null).

**Điều kiện tiên quyết:**
- Provider/mock provider thật **có xử lý `sessionRef`** (mock 0 hiện xử lý — phải nâng cấp mock hoặc dùng provider test nhận và echo lại); connector service `:8091` với cả 2 adapter (json + multipart); invoke với `sessionRef` **non-null** (mọi fixture cũ đều `null`).

**Cách chạy:**
1. Gọi connector invoke với `sessionRef` thật qua adapter json (body field) và multipart (form field); capture provider request.
2. Kiểm response-side: `NormalizedProviderResult.sessionRef` → wire response; chạy `canonical-hash-parity` với ref non-null (ref nằm trong canonical hash cả 2 phía).
3. Ma trận Δ: custom `requestMapping` thiếu `sessionRef` (json) — quan sát drop (Δ-1); so shape absent giữa 2 adapter (Δ-2).

**Kỳ vọng:** provider **thật sự nhận** `sessionRef` trên cả 2 adapter (captured request), hash parity giữ; Δ-1/Δ-2/Δ-3 ghi nhận làm **quyết định policy** (floor như `artifacts`? always-send vs always-omit? doc contract) trước khi coi là parity — chưa chốt thì ghi GAP, không tự sửa config semantics ngoài lease.

### LIV-PC-01 — carrier observed provider request (prompt pin tới provider)

**Nguồn:** [p745-carrier-impl-b2-2026-10-04](../coordination/reports/p745-carrier-impl-b2-2026-10-04.md) (§5–§9: adapter chokepoint + 6 action `promptStepId` đã wire, 17/17 ×3; carrier A/B/CAPFIX/B1 settled) + PLAN §13 `MISMATCH-CLEAR` rider.

**Điều kiện tiên quyết:**
- Carrier path đủ: Form A sealed envelope (hoặc NULL + markers khi không seam — adjudication 1c), claim cross-check, B2 adapter substitution (`apply ? prompt : assembledText`, không `promptStepId` ⇒ SKIP giữ nguyên), 6 action đã khai stepId, publish/rollback vận hành được.
- Provider có thể capture request (mock provider), worker document-core chạy trên queue thật; `DU_LIVE_INFRA=1`.

**Cách chạy:**
1. Publish profile revision **A** (prompt exact theo key-4) → submit operation → **capture provider request** và pre-scan không-secret.
2. Publish **B** (đổi nội dung prompt) khi operation đang chạy → retry/child/HITL-resume của operation cũ ⇒ provider request **vẫn A** (pin column, không đọc live table).
3. Vector `MISMATCH-CLEAR`: exact bị clear + `_default` có nội dung ⇒ xác nhận disposition đã chốt/được adjudicate tại packet B (cleared-exact **không hồi sinh `_default`** theo PC-5 — nếu carrier làm mất tombstone thì đây là ca đỏ cần chốt lại, không tự sửa Form A).
4. Ca precedence còn lại: Code > Profile(exact) > Profile(`_default`) > Connector default; connector default chỉ áp khi không override, không bịa (`apply:false` giữ assembled text byte-identical).

**Kỳ vọng:** provider observed request chứa đúng prompt theo precedence đã chốt cho cả 6 site/key-4 exact/_default/cleared/null; A giữ nguyên qua publish B + child/retry/HITL; carrier NULL (không seam) ⇒ không substitution (legacy byte-identical); **không raw prompt trong durable sinks** (snapshot/outbox/queue/checkpoint/log); observed request là bằng chứng bắt buộc — resolver test thuần **không** thay thế.
