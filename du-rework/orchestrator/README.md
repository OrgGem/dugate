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
```

For deployment, the standalone Orchestrator and Connector images use the
`orchestrator/` workspace as their Docker build context. The separate
`docker-compose.deploy.yml` manifest connects to existing PostgreSQL and
Redis/Valkey services; it never creates those services or a Connector
database. `pnpm run docker:up` remains the local dependency convenience for
the workspace's PostgreSQL and Valkey services. Copy
`.env.docker.deploy.example` to `.env.docker.deploy`, set the external URLs
and stable runtime credentials, and provision separate
Orchestrator and Connector databases before starting the stack. PostgreSQL
metadata and public-upload encryption work without Vault when the retained
`ENCRYPTION_KEY` is set. Connector credential encryption likewise requires a
retained `CONNECTOR_ENCRYPTION_KEY`. Optional Vault configuration is explicit;
Vault failures do not fall back to database encryption. Keep both keys through
restarts and upgrades; replacing either key requires a planned re-encryption.
Encrypted S3 artifact storage still requires its configured Vault Transit
options and identities.

The normal `up` path only verifies the recorded migration checksums before
starting each service. Review and back up each external database, then apply
numbered migrations explicitly before `up`. Build the release images from the
standalone Dockerfiles, publish them through the release process, and record
the immutable repository digests in the deployment file before the preflight
and migration steps:

```sh
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml build orchestrator connector
```

Set `DU_IMAGE_TAG` to the immutable release tag and set each runtime-control
image digest to the matching `repository@sha256:<64-hex-digest>` from the
release manifest. Then run the deployment preflight, review and back up both
databases, and apply their numbered migrations explicitly before `up`:

```sh
node scripts/docker/check-env.cjs .env.docker.deploy --deploy
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml --profile migration run --rm orchestrator-migrate migrate
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml --profile migration run --rm connector-migrate migrate
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml up -d orchestrator connector
```

Both migration jobs target their separately provisioned databases and are
opt-in; plain `up` does not apply migrations. Runtime-control identity fields
must refer to the exact release. A local image ID alone is not a valid
runtime-control digest; use the published repository digest, and never use
the `local-dev-not-an-image` marker in production. Internal Runtime
API port `3002` and Connector port `8080` remain on the worker/platform
networks; only Orchestrator API `3000` and Admin Portal BFF `3001` are
published. The Orchestrator image contains the built Admin Portal at
`/app/admin-web`.

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

Mock này chỉ phục vụ các adapter `DU_VAULT_*` của Orchestrator. Nó không cấu hình hoặc thay thế Connector `VAULT_ADDR`/AppRole. Connector typed credentials không bắt buộc Vault: khi chưa cấu hình Vault, Connector lưu ciphertext AES-GCM trong database, ràng buộc theo tenant, connector, revision và credential reference; giá trị gốc không được lưu trong config hay metadata. Chế độ này dùng `CONNECTOR_ENCRYPTION_KEY` (Base64 của 32 byte, bắt buộc khi khởi động). Giữ nguyên key qua các lần khởi động; thay key cần migration tái mã hóa. Connector store hiện không hỗ trợ keyring hoặc tự động xoay key. Khi Connector Vault AppRole được cấu hình đầy đủ (`VAULT_ADDR`, `VAULT_APPROLE_ROLE_ID`, `VAULT_APPROLE_SECRET_ID`), credential mới và các lần Keep/Rollback từ nguồn database được ghi vào KV v2 bằng version plan; revision chỉ lưu các Vault coordinates và version. Lỗi Vault trong chế độ này không chuyển sang database. Cấu hình AppRole thiếu một phần sẽ làm startup thất bại.

Trong `pnpm run dev`, nếu cả năm biến `CONNECTOR_RUNTIME_SLOT`, `CONNECTOR_RUNTIME_IDENTITY`, `CONNECTOR_REPLICA_ID`, `CONNECTOR_RUNTIME_REVISION` và `CONNECTOR_RUNTIME_IMAGE_DIGEST` đều chưa đặt, runner cấp identity local ổn định theo `CONNECTOR_PORT` để Connector sở hữu backup-effect fence. Digest có nhãn `local-dev-not-an-image` chỉ là marker cho development, không phải image provenance và không dùng để attest build/container. Production phải cấu hình tường minh cả năm biến cùng nhau; cấu hình thiếu một phần vẫn không hợp lệ.

Capability `test` của management UI đi cùng management route; để thực sự chạy provider test còn cần `INVOCATION_GRANT_SECRET` và metadata encryption. Capability `typedCredentialStorage` điều khiển Enter/Keep/Clear cho typed recipes và Secret Catalog import bằng encrypted database store, không bắt buộc Vault. `credentialWorkflow` cũ vẫn tách riêng và cần Vault KV v2 writer cùng binding đã provision; `DU_CONNECTOR_INITIAL_BINDINGS` là tùy chọn khi cần binding ban đầu. Startup không tự provision business version, profile, API key hoặc provider binding.

PostgreSQL deployments can run in real-data mode without Vault. With no `DU_VAULT_TRANSIT_OPTIONS` and no Transit identity tokens, Orchestrator derives a versioned local DEK-wrapping key from a retained `ENCRYPTION_KEY` (at least 32 UTF-8 bytes), or uses the explicit numeric `DU_LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION` / `DU_LOCAL_ENCRYPTION_KEYRING_JSON` ring. Explicit keyrings take priority; keep every version referenced by stored envelopes. Local metadata and PostgreSQL public-upload envelopes use the private refs `local-metadata-v1` and `local-public-upload-v1`. If Transit is configured, it remains the write provider; a Vault outage never downgrades new writes to local storage. Local envelopes can still be opened when the matching local keyring is retained. Old envelopes without a provider marker are treated as Vault Transit and require Vault to read. Encrypted S3 storage continues to require its configured Transit options and identities.

Managed Secret Catalog values remain AES-GCM ciphertext in PostgreSQL. An explicit `DU_SECRET_CATALOG_ACTIVE_KEY_VERSION` / `DU_SECRET_CATALOG_KEYRING_JSON` ring is preferred and takes priority; if absent, Orchestrator derives the version `encryption-key-v1` from `ENCRYPTION_KEY` (at least 32 UTF-8 bytes). Keep all older referenced versions. Existing local development rows keep the `local-dev-v1` derivation. A `vault_reference` Catalog entry stores only its Vault path and requires the configured Vault resolver; missing Vault or an outage fails the reference read without falling back to a managed database value. Connector credential-import retries keep an AES-GCM-sealed resolved payload in the append-only journal while pending; completion retains the immutable journal row and masked result for idempotent replay.

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

## Cách sử dụng Connector trên portal

Connector là một kết nối tới provider (URL, adapter/model và credential), không phải một business worker. Luồng xử lý bình thường: client gọi endpoint với API key/Profile, Orchestrator giao queue cho worker, worker dùng binding trong Profile để gọi Connector, và Connector gọi provider.

1. Trong Connectors → Recipe & provider test, chọn provider preset, URL/model và nhập credential hoặc chọn managed Secret Catalog ID. Save tạo một revision PENDING.
2. Chọn Profile/API key kiểm thử và binding slot do business khai báo để chạy provider test. Đây là request thật, có thể phát sinh chi phí provider. Khi test thành công, Activate exact revision bằng CAS.
3. Trong Profiles, chọn business/version/endpoint rồi gắn revision ACTIVE của Connector vào slot tương ứng. Save/publish Profile theo khả năng deployment. Một Profile có thể có nhiều slot cho các nhu cầu khác nhau.
4. Client tiếp tục gọi API business với API key/Profile; không truyền provider credential mỗi request. Binding pin revision cụ thể, nên sửa Connector tạo revision mới và cần cập nhật Profile nếu muốn sử dụng revision đó.

Không có Vault: credential được mã hóa trong Connector DB bằng khóa được giữ ổn định. Có cấu hình Connector Vault đầy đủ: revision giữ coordinates/version; Connector đọc giá trị khi cần sử dụng. API key xác thực Gateway là loại riêng và vẫn lưu hash. Các bản `codex-db-check-20261014` dùng dữ liệu giả, còn PENDING và chưa gọi provider thật.
