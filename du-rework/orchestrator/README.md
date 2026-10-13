# Orchestrator (du-rework/orchestrator)

Promoted platform boundary: Orchestrator Backend, Orchestrator Portal
(`apps/admin-web`), Connector, and the canonical platform packages.
Business workers live in `../businesses/` (document-core, lc-checker,
example-review).

Use Node 24.21.0 and pnpm 10.18.3. Orchestrator can be operated as a **standalone workspace** directly inside `du-rework/orchestrator` (with its own `package.json`, `pnpm-workspace.yaml`, local `tsconfig.base.json`, and scripts):

```sh
cd du-rework/orchestrator
pnpm run docker:up  # Khởi chạy PostgreSQL (15433) và Redis (16380)
pnpm run dev        # Build, start services, and watch Admin Web/backend changes
```

Hoặc chạy từ parent `du-rework/` workspace:

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

Chạy Orchestrator và Document Core từ hai terminal, mỗi terminal trong thư mục package tương ứng. Cần Node.js `24.21.0`, pnpm `10.18.3`, Docker Engine và Compose v2. Cài dependency workspace một lần từ `du-rework/`; Document Core dùng các package workspace trong thư mục cha.

```sh
cd du-rework
pnpm install --frozen-lockfile --ignore-scripts
```

### Terminal Orchestrator

```sh
cd du-rework/orchestrator
pnpm install --frozen-lockfile
pnpm run docker:up
pnpm run dev
```

`docker:up` tạo `orchestrator/.env.local` nếu chưa có rồi dùng đúng file đó cho PostgreSQL (`127.0.0.1:15433`) và Redis (`127.0.0.1:16380`). Profile chứa credentials local được sinh ngẫu nhiên và danh sách token worker theo business; script không in secret. `dev` build các package/service, chạy migration, rồi start Orchestrator và Connector. Watch mode bật mặc định: Admin Web được Vite phục vụ trên cùng `http://127.0.0.1:3001/admin/` với React HMR; login, OIDC callback và `/admin/api` đi qua Admin Shell để giữ session, Host, cookie và CSRF checks. Thay đổi backend, Connector và shared package sẽ được build trước khi restart services. Nếu build lỗi, services dừng đến khi có lần build thành công sau thay đổi source tiếp theo. Dùng `pnpm run dev -- --no-watch` để build một lần và phục vụ bundle tĩnh. Dừng process bằng `Ctrl+C`; `pnpm run docker:down` dừng containers và giữ volume database. Nếu dev process đang chạy từ trước khi bật watch mode, hãy dừng và chạy lại một lần để dùng runner mới.

Khi chạy Orchestrator local, runner tự đặt `DU_CONNECTOR_BASE_URLS` thành route mặc định tĩnh tới `CONNECTOR_URL` nếu biến này chưa được đặt. Route ID cụ thể trong map cấu hình luôn được ưu tiên; nếu tự đặt map mà không có `"*"`, ID mới vẫn trả về `404`. `SERVICE_IDENTITY_SECRET` phải là Base64 của 32 byte và được dùng chung bởi Orchestrator với Connector; runner dừng với lỗi rõ ràng nếu thiếu.

Capability `test` của management UI đi cùng management route; để thực sự chạy provider test còn cần `INVOCATION_GRANT_SECRET` và metadata encryption hoạt động qua `DU_ENCRYPTION_METADATA_ENABLED=true`, `DU_VAULT_TRANSIT_OPTIONS`, cùng hai token Transit riêng `DU_VAULT_TRANSIT_ENC_TOKEN` và `DU_VAULT_TRANSIT_DEC_TOKEN`. Credential workflow chỉ bật khi cấu hình writer Vault KV v2 gồm `DU_VAULT_KV_OPTIONS` và `DU_VAULT_KV_TOKEN`; `DU_CONNECTOR_INITIAL_BINDINGS` là tùy chọn khi cần binding ban đầu. Connector cần `VAULT_ADDR`, `VAULT_APPROLE_ROLE_ID` và `VAULT_APPROLE_SECRET_ID` để đọc credential đã lưu trong Vault. Cấp cho mỗi identity đúng policy và KV path cần thiết trước khi bật luồng này.

### Terminal Document Core

```sh
cd du-rework/businesses/document-core
pnpm run dev:check
pnpm run dev
```

Worker dùng chung `orchestrator/.env.local` để worker token trong `DOCUMENT_CORE_RUNTIME_TOKEN` trùng với `document-core` trong `WORKER_IDENTITY_TOKENS_BY_BUSINESS`. Không tạo bản sao token riêng cho worker. Nếu profile cũ thiếu identity map, chạy một lần từ thư mục `orchestrator/`:

```sh
node scripts/init-local.cjs --ensure-worker-identities
```

Lệnh này chỉ bổ sung worker identity còn thiếu và giữ nguyên credentials hiện có. Khởi động lại Orchestrator để nạp profile mới trước khi start worker. `pnpm run dev:check` chỉ kiểm tra định dạng và sự khớp nhau của cấu hình; nó không kết nối database, Redis, Connector hoặc provider. `pnpm run dev` chỉ biên dịch source Document Core trong package rồi chạy worker; watch mode chỉ theo dõi source, `package.json` và `tsconfig.json` của package này. Runner không build hoặc theo dõi source của Orchestrator hay workspace packages. Các workspace dependencies (bao gồm SDK) cần có sẵn JavaScript và declaration artifacts trong `dist/`; nếu thiếu, runner báo package cần build. Khi sửa source của dependency, build dependency đó riêng từ `du-rework/` rồi khởi động lại worker. Dùng `pnpm run dev -- --no-watch` để build Document Core một lần. Có thể bỏ build này bằng `pnpm run dev -- --skip-build` nếu đã có build phù hợp.

| Thành phần | Địa chỉ local |
| --- | --- |
| PostgreSQL | `127.0.0.1:15433` |
| Redis | `redis://127.0.0.1:16380` |
| Public API | `http://127.0.0.1:3000` |
| Internal Runtime API | `http://127.0.0.1:3002` |
| Admin Portal | `http://127.0.0.1:3001/admin/` |
| Connector | `http://127.0.0.1:8088` |

Document Core không mở HTTP listener. Worker gọi Runtime trên internal port `3002`, Redis trên port `16380`, và Connector theo URL trong shared profile. Việc start service không tự provision business version, profile, API key hoặc provider binding; cần các cấu hình đó trước khi xử lý request end-to-end. Xem [Document Core local guide](../businesses/document-core/README-LOCAL.md), [runbook](../docs/17-operational-runbooks.md) và [deployment guide](../docs/12b-deployment-guide.md).
