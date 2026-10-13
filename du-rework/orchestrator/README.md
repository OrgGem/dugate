# Orchestrator (du-rework/orchestrator)

Promoted platform boundary: Orchestrator Backend, Orchestrator Portal
(`apps/admin-web`), Connector, and the canonical platform packages.
Business workers live in `../businesses/` (document-core, lc-checker,
example-review).

Use Node 24.21.0 and pnpm 10.18.3. Orchestrator can be operated as a **standalone workspace** directly inside `du-rework/orchestrator` (with its own `package.json`, `pnpm-workspace.yaml`, local `tsconfig.base.json`, and scripts):

```sh
cd du-rework/orchestrator
pnpm install --frozen-lockfile
# Keep real database credentials out of tracked files.
cp .env.example .env.bootstrap.local
# Edit .env.bootstrap.local with your external PostgreSQL/Redis URLs.
pnpm run init:local -- --env-file=.env.bootstrap.local
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

The standalone workspace keeps its build inputs, shared TypeScript config,
patches, vendor packages, and Portal OpenAPI document inside `orchestrator/`.
`scripts/verify-isolation.cjs` checks relative imports; the standalone build
is verified separately by `pnpm run build`.

The standalone build order is defined in `scripts/build.cjs` (packages, then
Connector, Orchestrator, and Admin Web). The parent `du-rework/scripts/build-all.cjs`
is a separate monorepo build that also builds business workers and container
images; `pnpm run dev` does not call it. `patches/` and `vendor/` preserve the
canonical security fixes within this workspace.

Runtime artifact grants require a trusted worker-reachable origin. Configure
`ORCHESTRATOR_INTERNAL_BASE_URL=http://orchestrator:3002` for the Compose topology;
use the actual internal HTTP(S) origin for other deployments. This is deployment
configuration, never the request Host header or the public port 3000. PostgreSQL
storage grants target authenticated internal Runtime routes; presigned S3 URLs
remain unchanged. Internal 3002 and Connector 8080 need no default host mapping.

## Hướng dẫn local từng bước

Cần Node.js `24.21.0`, pnpm `10.18.3`, cùng PostgreSQL và Redis đã chạy riêng. Các lệnh bên dưới chạy từ workspace `orchestrator/`; chúng không khởi động, dừng hoặc cấu hình database/container.

### Terminal Orchestrator

```sh
cd du-rework/orchestrator
pnpm install --frozen-lockfile
```

Copy `.env.example` tới file local bị ignore, sửa `DATABASE_URL` và `REDIS_URL` để trỏ tới các dịch vụ external đang chạy, sau đó tạo profile riêng. Lệnh này sinh credentials cho app, giữ nguyên endpoint database/Redis bạn đã cung cấp và không tạo database password:

```sh
cp .env.example .env.bootstrap.local
# Edit .env.bootstrap.local with the external service URLs and credentials.
pnpm run init:local -- --env-file=.env.bootstrap.local
pnpm run dev
```

`pnpm run dev` kiểm tra kết nối TCP tới PostgreSQL và Redis, build packages/services bên trong workspace, chạy migration PostgreSQL rồi start Orchestrator và Connector. Nếu thiếu kết nối hoặc migration lỗi, startup dừng và nêu endpoint cần kiểm tra; runner không gợi ý chạy `docker:up`. Khi đã có `.env.local`, runner dùng file đó nguyên trạng và không sinh lại credentials.

Watch mode bật mặc định: Admin Web được Vite phục vụ trên cùng `http://127.0.0.1:3001/admin/` với React HMR; login, OIDC callback và `/admin/api` đi qua Admin Shell để giữ session, Host, cookie và CSRF checks. Thay đổi backend, Connector, shared package hoặc `orchestrator/tsconfig.base.json` sẽ được build trước khi restart services. Nếu build lỗi, services dừng đến lần build thành công tiếp theo. Dùng `pnpm run dev -- --no-watch` để build một lần và phục vụ bundle tĩnh. Dừng bằng `Ctrl+C`; runner chỉ dừng các tiến trình do phiên đó tạo.

Khi chạy Orchestrator local, runner tự đặt `DU_CONNECTOR_BASE_URLS` thành route mặc định tĩnh tới `CONNECTOR_URL` nếu biến này chưa được đặt. Route ID cụ thể trong map cấu hình luôn được ưu tiên; nếu tự đặt map mà không có `"*"`, ID mới vẫn trả về `404`. `SERVICE_IDENTITY_SECRET` phải là Base64 của 32 byte và được dùng chung bởi Orchestrator với Connector; runner dừng với lỗi rõ ràng nếu thiếu. Business workers vẫn là các project riêng: Orchestrator runner không build hoặc launch Document Core, LC Checker hay Example Review.

Profile mới tạo bằng `init:local` bật real-mode metadata/public-upload encryption và đặt `DU_VAULT_MOCK=true`. `pnpm run dev` sẽ khởi động mock Vault loopback cho Orchestrator KV v2 và Transit; cũng có thể bật tường minh với `pnpm run dev -- --mock-vault`. Khi `DU_VAULT_MOCK` không bật, các Vault Transit/KV options hiện có được giữ nguyên và dùng như đã cấu hình. Mock chỉ dành cho dev/test: dữ liệu KV seed và các lần ghi tồn tại trong bộ nhớ của tiến trình, vì vậy ghi mới mất khi mock dừng; Transit key material được tái tạo ổn định từ tên key và version nên ciphertext mock vẫn giải mã được sau restart nếu fixture/key reference không đổi.

Mock này chỉ phục vụ các adapter `DU_VAULT_*` của Orchestrator. Nó không cấu hình hoặc thay thế Connector `VAULT_ADDR`/AppRole. Để Connector đọc/ghi credential KV v2, cấu hình một Vault thật cùng `VAULT_ADDR`, `VAULT_APPROLE_ROLE_ID` và `VAULT_APPROLE_SECRET_ID`; nếu cả ba biến này không được đặt, Connector khởi động mà không có Vault credential resolver. Cấu hình thiếu một phần sẽ làm startup thất bại.

Capability `test` của management UI đi cùng management route; để thực sự chạy provider test còn cần `INVOCATION_GRANT_SECRET` và metadata encryption. Credential workflow cần writer Vault KV v2 hoạt động cùng binding đã provision; `DU_CONNECTOR_INITIAL_BINDINGS` là tùy chọn khi cần binding ban đầu. Startup không tự provision business version, profile, API key hoặc provider binding.

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
