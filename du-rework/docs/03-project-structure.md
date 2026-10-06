# Project structures và ownership

Tài liệu này đóng băng target repo/service đã được user chốt ngày 2026-10-05, rồi đối chiếu với source và Compose workspace hiện có. `du-rework/` có pnpm workspace riêng nhưng vẫn nằm trong Git root của DUGate; không xem workspace/build target là repo đã tách hoặc production deployment. Xem thêm [bản đồ Orchestrator](../services/orchestrator/CODE-ARCHITECTURE.md), [cấu trúc subproject](../architecture/11-subprojects.md) và [topology decision](40-du-platform-architecture.md).

## Topology freeze ngày 2026-10-05

Theo [quyết định repo/service](40-du-platform-architecture.md), mặc định có hai **loại repo**. Một repo Orchestrator giữ Admin Portal, Platform API + Orchestration Runtime (cùng process), và Connector source; Connector vẫn có process/service/image/config/scale riêng. Mỗi business dùng một instance/repo được tạo từ cùng loại Worker template và có build/deploy/scale độc lập. Repo Connector riêng là loại repo thứ ba tùy chọn, chưa được chọn làm mặc định. Không đổi tên Orchestrator thành `platform-api`/App Portal, không tách Runtime thành service riêng, và không nhúng Connector vào API process.

| Đích đã chốt | Source hiện thấy trong workspace | Ranh giới build/runtime đích | Tình trạng chứng minh |
|---|---|---|---|
| Orchestrator repo — Portal | `apps/admin-web/` | UI bundle được đóng cùng image Orchestrator theo Docker build hiện có | Có source/build target; repo đích độc lập chưa được tạo |
| Orchestrator repo — API + Runtime | `services/orchestrator/` | Một process/service/image Orchestrator; API routes và durable runtime cùng backend | Có source/service target; không chứng minh đã cutover production |
| Orchestrator repo — Connector | `services/connector/` | Image/process/service Connector riêng, kết nối bằng service API và quyền riêng | Có source/service target trong cùng build workspace; không phải API process |
| Worker template — mỗi business | `businesses/document-core/`, `businesses/example-review/`, `businesses/lc-checker/` | Mỗi business repo/image/version độc lập; replicas cùng business/version consume queue tương ứng | Ba source folder có mặt trong workspace chung; chưa phải ba Git repo tự đủ |
| Connector repo tùy chọn | Chưa có path/repo được chọn | Có thể tách Connector source về loại repo thứ ba sau quyết định riêng; service/image boundary vẫn giữ | Chưa chọn/chưa triển khai |

**Hiện trạng repository:** `git rev-parse --show-toplevel` trả về `D:/Git/dugate`; `du-rework/` là workspace con trong cùng Git repository, không phải nested repository. Vì vậy các folder/image target ở trên không được đọc thành bằng chứng về repo tách rời hoặc topology production đã deploy. `docs/40` là quyết định topology; phần cấu trúc bên dưới và deployment guide mô tả source/build hiện có, không tự nâng trạng thái SPECIFIED thành IMPLEMENTED/VERIFIED/ACCEPTED.

## Cấu trúc source hiện tại

| Thành phần | Hiện trạng source | Giới hạn cần phân biệt |
|---|---|---|
| Workspace | Hai service, ba business độc lập, sáu shared package trong pnpm workspace | Đây là phân bố source; readiness theo task/gate riêng. |
| Orchestrator HTTP và Admin | `node:http`; `server.ts` giữ `ServerConfig`, `createApp` và route dispatcher; `http/routes/{public,runtime,admin}.ts` giữ handler; `app/bootstrap/create-app.ts` lắp dependency, timer và Admin shell từ `app/admin/` | `main.ts` đọc env, bật shell khi có secret/token và gọi `listen()`; không dùng số dòng cũ của `server.ts` làm vị trí wiring. |
| PostgreSQL | `pg` và SQL migration tại `services/orchestrator/migrations/`; boot mặc định kiểm schema, `autoMigrate` chỉ là opt-in | Production chạy migrate CLI riêng trước khi start; Drizzle chỉ còn trong thiết kế cũ. |
| Artifact storage | Có backend PostgreSQL và S3, S3 facade, multipart và đường mã hóa theo cấu hình | Source có adapter không tự chứng minh deployment S3 hoặc acceptance gate. |
| Connector | `composition.ts` lắp runtime, HTTP, DB và Redis; domain files chủ yếu ở `src/`, với `http/`, `adapters/`, `db/`, `vault/` | `SecretResolver` có module nhưng chưa được truyền vào runtime ở composition production. |
| Triển khai | Có Dockerfile và nhiều Compose profile/test topology | Kiểm config và chạy live theo deployment guide trước khi công bố full stack. |

Các khác biệt framework/DB so với đề xuất ban đầu được ghi rõ để không lẫn thiết kế mục tiêu với code đang chạy.

```text
du-rework/
  docs/                         # normative specifications
  tasks/                        # phase packets, dependencies, DoD
  tools/
    openapi/                    # gen_openapi.py (code-derived docs/21 + path-loss guards), validate_openapi.py, probe_cases.js
  services/
    orchestrator/
      src/server.ts             # ServerConfig, createApp, health và route dispatcher
      src/http/routes/          # public, runtime, admin HTTP handlers
      src/app/bootstrap/        # dependency wiring, node:http, background lifecycle
      src/app/admin/            # Admin shell (renderers, view-models, shell-router, OIDC flow) via attachAdminShell
      src/modules/
        auth/ registry/ profiles/ operations/ runtime/
        artifacts/ queue/ usage/ webhooks/ audit/
        admin-read/             # Admin list queries và projections
        admin-actions/          # Admin action dispatcher
      src/db/                   # PG adapter và migration runner
      migrations/               # platform SQL migrations
      tests/
    connector/
      src/composition.ts        # HTTP/runtime/DB/Redis composition root
      src/*.ts                  # grants, quota, ledger, config domain files
      src/http/                 # internal invocation + management API
      src/adapters/             # multipart-http, json-http, mock
      src/db/                   # connector-owned schema/migrations
      tests/
  businesses/
    document-core/
      docs/                     # action BRDs, interfaces, case matrix
      src/manifest/ src/actions/ src/pipelines/ src/recipes/ src/validation/
      src/worker.ts
      tests/fixtures/ tests/unit/ tests/e2e/
    example-review/
      docs/ src/ tests/          # proof of registration + HITL + fanout
    lc-checker/
      src/ tests/ Dockerfile     # P9-02 trade-finance LC checker, own manifest + queue
  packages/
    contracts/                  # JSON schemas, DTOs, errors, API descriptions
    worker-sdk/                 # queue/runtime lifecycle, task/step facade
    connector-client/           # typed invocation + replay/poll client
    document-kit/               # parse, conversion, archive, file helpers
    egress/                     # DNS-rebinding-safe pinned fetch (PR-Q3-03/09): one resolution feeds policy and socket
    observability/              # logger, trace IDs, metrics interfaces
  infra/                        # compose, deployment, environment/runbooks
  tests/                        # black-box contract/e2e/fault/load suites
```

`pnpm-workspace.yaml` discover qua glob `packages/*`, `services/*`, `businesses/*`, `tests/*` — package thêm mới vào đúng một thư mục trong glob sẽ tự được workspace nhận, không cần sửa manifest root.

## Dependency rules

| Subproject | Được phụ thuộc | Không được phụ thuộc |
|---|---|---|
| contracts | Pure schemas/types | Next, DB, worker source, credentials |
| observability | Logger/telemetry libraries | Business/platform internals |
| orchestrator | contracts, observability, egress, worker-sdk (source-ingestion logic/types hiện tại) | Business packages, parser/provider SDK |
| connector | contracts, observability, egress, adapter libraries | Business source, platform DB schema |
| worker-sdk | contracts, observability, BullMQ, HTTP client | Orchestrator source/DB |
| connector-client | contracts, HTTP client | Connector source/DB |
| document-kit | contracts artifact types, parser libraries | Next, platform DB, connector config |
| egress | contracts | Business/service internals; chỉ là pinned fetch dùng chung, mọi egress HTTP của orchestrator/worker đi qua nó để policy và socket dùng chung một resolution |
| business | Shared packages | Other business internals, service internals |

Package exports public interfaces rõ ràng. Alias `@/` chỉ nội bộ một subproject; shared imports dùng `@du/contracts`, `@du/worker-sdk`... Runtime packages có version; deployed service không yêu cầu mọi business nâng SDK cùng lúc nếu wire contract còn tương thích.

## Build/deployment target và trạng thái hiện tại

Topology mục tiêu ở trên thay thế các giả định repo/service cũ. [Deployment guide](12b-deployment-guide.md) mô tả Docker/Compose stack trong workspace hiện tại; image target/source không chứng minh repo tự đủ hoặc production rollout.

- Orchestrator: một image app/API/runtime với Admin Web bundle; API và Runtime cùng process.
- Connector: image/service riêng dù source hiện ở cùng workspace/repo; không gọi trực tiếp DB nghiệp vụ của Orchestrator.
- Mỗi business: Worker template cùng loại, image/release/version và triển khai độc lập; replicas chỉ cùng consume queue của business/version đã đăng ký.
- Exact repository extraction, build context, image digest, deploy, rollback và live acceptance thuộc migration/rollout tasks riêng, không được kết luận từ Compose profile.
- PostgreSQL + BullMQ/Valkey và storage/Vault adapters hiện có được map theo deployment/contract owner; không giả định các external service đã được provision chỉ từ việc có adapter/config.
- Migrations do one-shot command riêng theo schema owner; không để tất cả replica tự migrate lúc boot.
- CI phát hiện changed workspace; kiểm tra contracts làm trigger consumer compatibility suites.

## File ownership khi giao agent

Contract owner sửa `packages/contracts` và docs 04–09. Platform owner sửa Orchestrator. Connector owner sửa Connector và connector-client. SDK owner sửa worker-sdk/document-kit. Business owner sửa business folder. QA owner sửa black-box tests. Infra owner sửa infra.

Root workspace config/lockfile chỉ một integration owner sửa trong một thời điểm. Agent không tự sửa contract đang freeze để làm test riêng pass; tạo change note rồi tích hợp qua owner.
