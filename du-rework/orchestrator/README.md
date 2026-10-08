# Orchestrator (du-rework/orchestrator)

Promoted platform boundary: Orchestrator Backend, Orchestrator Portal
(`apps/admin-web`), Connector, and the canonical platform packages.
Business workers live in `../businesses/` (document-core, lc-checker,
example-review).

Use Node 24.21.0 and pnpm 10.18.3. All commands run from the parent
`du-rework/` workspace root (this directory is not a standalone workspace;
the pnpm workspace, lockfile, Dockerfile, and `tsconfig.base.json` live at
the root):

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
node scripts/build-all.cjs
node orchestrator/scripts/verify-isolation.cjs
docker build --target orchestrator -t du-orchestrator .
docker build --target connector -t du-connector .
```

Layout:

```
orchestrator/
  apps/admin-web        # Orchestrator Portal (built into the orchestrator image)
  packages/             # contracts, connector-client, document-kit, egress,
                        # observability, worker-sdk
  services/
    orchestrator/       # Orchestrator Backend (public 3000, internal 3002)
    connector/          # Connector service (8080)
  scripts/
    verify-isolation.cjs  # check worker imports; allow shared test harness/OpenAPI
  patches/ vendor/      # canonical security fixes (referenced by root
                        # pnpm-workspace.yaml patchedDependencies/overrides)
```

The boundary check permits explicit workspace test harness imports and the
Portal import of `../docs/21-openapi.json`. It checks relative `from` imports;
it does not prove a standalone repository build.

Build order is defined in `../scripts/build-all.cjs` (packages, then
connector, orchestrator, admin-web, then the three businesses) and runtime
images in `../scripts/docker/build-runtime.cjs`. `patches/` and `vendor/`
preserve the canonical security fixes.

Runtime artifact grants require a trusted worker-reachable origin. Configure
`ORCHESTRATOR_INTERNAL_BASE_URL=http://orchestrator:3002` for the Compose topology;
use the actual internal HTTP(S) origin for other deployments. This is deployment
configuration, never the request Host header or the public port 3000. PostgreSQL
storage grants target authenticated internal Runtime routes; presigned S3 URLs
remain unchanged. Internal 3002 and Connector 8080 need no default host mapping.

## Hướng dẫn local từng bước

**Tất cả lệnh chạy tại `du-rework/`, không phải `du-rework/orchestrator/` hoặc Git root cũ.** Backend, Portal và Connector nằm trong `orchestrator/`; workers nằm tại `businesses/`. Workspace và lockfile vẫn ở `du-rework/`.

### 1. Chuẩn bị và cài dependency

Cần Node **24.21.0**, pnpm **10.18.3**, Docker Engine đang chạy và Compose v2.

```sh
cd du-rework
node --version
corepack enable
corepack prepare pnpm@10.18.3 --activate
pnpm --version
pnpm exec node --version
docker compose version
pnpm install --frozen-lockfile --ignore-scripts
```

Hai lệnh kiểm tra Node phải trả `v24.21.0`. Trên Windows, shim pnpm cũ có thể gọi Node 22 dù `node --version` trả 24: chuyển Node mặc định bằng trình quản lý Node đang dùng, mở terminal mới và kiểm tra lại trước khi build. Không bỏ qua engine warning. Nếu dùng nvm-windows và đã cài phiên bản này: `nvm use 24.21.0`.

### 2. Tạo profile dev riêng

```sh
node scripts/init-orchestrator-local.cjs
```

Lệnh tạo **`.env.orchestrator.local`**, sinh token/key/password ngẫu nhiên và không in secret. Chạy lại giữ nguyên file đã có. File được Git ignore; không commit hoặc chia sẻ file này.

Profile dùng **dữ liệu giả lập **: `DU_DATA_MODE=synthetic` kèm acknowledgement rõ ràng, PostgreSQL artifact storage và không cần Vault/S3 để kiểm tra startup. Không dùng dữ liệu nhạy cảm thật trong profile này. Với dữ liệu thật, áp dụng [chính sách mã hóa](../docs/41-persistence-encryption-policy.md) và [deployment guide](../docs/12b-deployment-guide.md).

| Thành phần | Địa chỉ local |
| --- | --- |
| PostgreSQL dev riêng | `127.0.0.1:15433`, database `du_orchestrator_dev` |
| Redis dev riêng | `127.0.0.1:16380` |
| Public API | `http://127.0.0.1:3000` |
| Internal admin/runtime API | `http://127.0.0.1:3002` |
| Portal + BFF | `http://127.0.0.1:3001/admin/web/` |
| Connector | `http://127.0.0.1:8088` |

Runtime worker dùng `http://127.0.0.1:3002/api/runtime/v1`. Public port 3000 chặn admin/runtime. Connector host-dev port 8088 khác container port 8080.

### 3. Khởi chạy PostgreSQL và Redis

```sh
docker compose --env-file .env.orchestrator.local -f infra/docker-compose.orchestrator-local.yml up -d --wait
docker compose --env-file .env.orchestrator.local -f infra/docker-compose.orchestrator-local.yml ps
```

Hai service phải `healthy`. Stack `du-orchestrator-local` độc lập với các stack test/live khác. PostgreSQL dùng named volume để giữ dữ liệu khi stop/down. Nếu port bị chiếm, chọn port khác trong cả Compose và URL trong env; không dừng process của stack khác để lấy port.

### 4. Build và chạy smoke offline

```sh
node scripts/build-all.cjs
node scripts/test-orchestrator-local.cjs
node orchestrator/scripts/verify-isolation.cjs
```

Build chạy theo dependency order, gồm sáu packages, hai services, Portal và ba workers. Portal build bao gồm TypeScript typecheck và Vite bundle.

Smoke chạy toàn bộ Contracts, Connector unit, nhóm Orchestrator về read/write/retry callback, ingress, identity và mock Vault, sau đó Portal typecheck. Lệnh phải exit 0. Không cần DB/Redis cho smoke; test HTTP dùng listener/stub local. Đây là **smoke có phạm vi xác định**, không thay toàn bộ test Orchestrator, browser hoặc live end-to-end. Skipped không được tính là pass.

Checker isolation cho phép shared test harness/isolation tại workspace và import OpenAPI của Portal; kiểm tra không import worker sibling. Không suy ra thư mục này đã tự đủ để build như repo độc lập.

Test rộng hơn: xem [test strategy](../docs/13-test-strategy.md). SDK còn finding crypto fidelity/memory, example-review còn finding assertion logging; xem [receipt sau tái cấu trúc](../coordination/reports/orchestrator-restructure-local-verification-2026-10-07.md). Không dùng `pnpm test` toàn workspace để thay smoke vì một số suite truy cập DB/live infra.

### 5. Kiểm tra cấu hình và migrate DB dev

```sh
node scripts/dev.cjs --env-file=.env.orchestrator.local --workers=document-core --check
node scripts/migrate-local.cjs --env-file=.env.orchestrator.local
```

Preflight chỉ kiểm tra cấu hình/topology, chưa kết nối DB hoặc start process. Migrate **ghi vào DB**: profile ở bước 2 trỏ DB dev riêng port 15433. Nếu tự sửa `DATABASE_URL`, kiểm tra đúng DB trước khi chạy. Migration CLI phải exit 0 trước khi dùng `--skip-migrate`.

### 6. Chạy Backend, Portal, Connector và worker

```sh
node scripts/dev.cjs --env-file=.env.orchestrator.local --workers=document-core --skip-build --skip-migrate
```

Giữ terminal này mở. Runner start Backend/Portal và Connector, chờ readiness rồi start document-core. Log có prefix theo process. Không có lỗi occupied port, schema hoặc worker registration.

Biến môi trường đã export trong terminal ưu tiên hơn file env. Khi đổi profile, gỡ biến cũ như `DATABASE_URL`, `RUNTIME_URL`, token hoặc dùng terminal sạch để tránh chạy nhầm cấu hình.

```sh
# Backend + Portal + Connector, không worker:
node scripts/dev.cjs --env-file=.env.orchestrator.local --workers=none --skip-build --skip-migrate
# Cả ba workers:
node scripts/dev.cjs --env-file=.env.orchestrator.local --workers=all --skip-build --skip-migrate
# Tự build và migrate mỗi lần start:
node scripts/dev.cjs --env-file=.env.orchestrator.local --workers=document-core
```

### 7. Kiểm tra từ terminal thứ hai

PowerShell:

```powershell
(Invoke-WebRequest http://127.0.0.1:3000/health).StatusCode
(Invoke-WebRequest http://127.0.0.1:3002/health).StatusCode
(Invoke-WebRequest http://127.0.0.1:8088/health/ready).StatusCode
(Invoke-WebRequest http://127.0.0.1:3001/admin/login).StatusCode
```

Cả bốn phải trả 200. Mở `http://127.0.0.1:3001/admin/login`; profile mặc định giữ login bearer-token tương thích, dùng `ADMIN_TOKEN` trong file private để đăng nhập. Không có tài khoản username/password được tự seed. Local-user/OIDC cần bootstrap identity và cấu hình auth mode riêng, không suy ra username/password mặc định từ form.

Startup/health thành công chưa chứng minh xử lý document: submit public request cần business version, profile, API key và provider bindings tương ứng. External client dùng `x-api-key`, không dùng admin/runtime token. Contract và ví dụ: [Public API](../docs/06-public-api.md); OpenAPI được build vào API Reference của Portal từ `../docs/21-openapi.json`.

Helper mới sinh signed `CONNECTOR_SERVICE_TOKEN` có hạn 24 giờ, token riêng cho từng business và khóa mã hóa invocation. Dùng `--local-identity` với local runner để ký token mới trong bộ nhớ mỗi lần chạy; production dùng identity issuer. Profile synthetic mặc định chưa bật mã hóa workflow. Full workflow dùng `--workflow` và Vault Transit đã provision; xem [hướng dẫn runtime](../scripts/README.md#workflow-runtime-configuration).

### 8. Dừng và chạy lại

Nhấn `Ctrl+C` trong terminal dev để dừng process do runner tạo. Sau đó:

```sh
docker compose --env-file .env.orchestrator.local -f infra/docker-compose.orchestrator-local.yml stop
# Lần sau khởi động infra bằng bước 3 rồi chạy lại bước 6.
```

Muốn bỏ containers nhưng giữ dữ liệu: dùng `down`. Chỉ dùng `down --volumes` khi chủ động muốn xóa DB dev. Không xóa file env rồi tái sinh password khi volume DB cũ còn tồn tại: PostgreSQL giữ password đã khởi tạo lần đầu.

### Xử lý lỗi thường gặp

| Lỗi | Cách xử lý |
| --- | --- |
| Node engine warning / pnpm chạy Node 22 | Kiểm tra cả `node --version` và `pnpm exec node --version`; sửa Node manager/shim và mở terminal mới. |
| `schema is not up-to-date` | Chạy bước 5 trên đúng DB dev, không chỉ rebuild. |
| `RUNTIME_URL points to Public ingress` | Dùng internal 3002; kiểm tra biến export ghi đè env file. |
| Port occupied | Stop session của chính mình hoặc đổi port và URL đồng bộ. |
| DB password sai sau tạo lại env | Giữ env gốc hoặc chủ động reset DB dev; `up` không thay password của volume cũ. |
| Portal/OpenAPI thiếu sau đổi source | Build lại bước 4; không dùng dist cũ hoặc migration-candidates. |
| Provider unavailable khi submit | Cấu hình provider/Connector/profile; smoke không tự tạo binding hay API key. |

Docker deployment khác host-process dev này; dùng [Dockerfile gốc](../Dockerfile) và [deployment guide](../docs/12b-deployment-guide.md). Chi tiết runner/watch: [scripts README](../scripts/README.md); `--watch` chỉ watch JavaScript đã build, không tự biên dịch TypeScript/Vite HMR.
