# Project structures và ownership

Các thư mục dưới đây là cấu trúc mục tiêu. Workspace/package chính đã materialize và build; Admin shell đã mount trong orchestrator (`src/app/admin/`); artifact bytea và example-review có implementation partial. Dùng pnpm workspace độc lập trong `du-rework`; không sửa root package.json/lockfile của DUGate. Xem [review cấu trúc/code](../coordination/STRUCTURE-CODE-REVIEW-2026-09-21.md) cho các khác biệt cần xử lý.

## Cấu trúc thực tế sau FIX-07

| Mục tiêu | Hiện trạng | Quyết định/task còn mở |
|---|---|---|
| Hai services, ba business độc lập, sáu shared packages | Đã đúng ở cấp workspace | Giữ dependency ownership; thêm automated boundary checks |
| Orchestrator Next routes/Admin + server lifecycle | node:http trong `src/server.ts` (file lớn, `route(ctx)` + `createApp`); Admin shell **đã có** tại `src/app/admin/` (~30 file: api-key/audit/business/connector/crypto-config/operation/overview renderers, OIDC boot/flow, `shell-router.ts`) mount qua `attachAdminShell` trong `createApp` (`server.ts:714`, remount `:877`); `server.listen` chạy tại `server.ts:860`, start script `node dist/main.js` | Local/OIDC auth mode còn mở ở LOCAL-00..06; `LOCAL-R03` ghi `main.ts:105-129` chưa truyền `adminShellCookieSecret` |
| PostgreSQL + Drizzle, one-shot migrations | raw pg; migrations chạy trong createApp; SQL ở migrations/ | ADR DB approach; mở lại P2-01 |
| S3 artifact storage | PostgreSQL bytea tạm thời theo wave-05 | P2-03 hardening và P8 storage/deployment |
| Connector src/modules | Domain files ở src root, có http/adapters/db | Khác tên thư mục không phải lỗi nếu giữ layering |
| Full multi-service deployment | Compose mới có PG/Redis; một số worker/service có Dockerfile | P8-06 còn mở |

Các khác biệt framework/DB cần quyết định kiến trúc rõ ràng; bảng này ghi hiện trạng, không tự thay thế kiến trúc mục tiêu phía dưới.

```text
du-rework/
  docs/                         # normative specifications
  tasks/                        # phase packets, dependencies, DoD
  tools/
    openapi/                    # gen_openapi.py (code-derived docs/21 + path-loss guards), validate_openapi.py, probe_cases.js
  services/
    orchestrator/
      src/server.ts             # long-running node:http server, route(ctx), createApp, background lifecycle
      src/app/admin/            # Admin shell (renderers, view-models, shell-router, OIDC flow) via attachAdminShell
      src/modules/
        auth/ registry/ profiles/ operations/ runtime/
        artifacts/ outbox/ usage/ webhooks/ audit/
        admin-actions/          # Admin action dispatcher
      src/db/                   # platform schema and migrations
      tests/
    connector/
      src/http/                 # internal invocation + management API
      src/modules/              # grants, quota, ledger, config
      src/adapters/             # multipart-http, json-http, mock
      src/db/                   # connector-owned schema/migrations
      tests/
  businesses/
    document-core/
      docs/                     # action BRDs, interfaces, case matrix
      src/manifest/ src/actions/ src/pipelines/ src/prompts/
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
| orchestrator | contracts, observability | Business packages, parser/provider SDK |
| connector | contracts, observability, adapter libraries | Business source, platform DB schema |
| worker-sdk | contracts, observability, BullMQ, HTTP client | Orchestrator source/DB |
| connector-client | contracts, HTTP client | Connector source/DB |
| document-kit | contracts artifact types, parser libraries | Next, platform DB, connector config |
| egress | contracts | Business/service internals; chỉ là pinned fetch dùng chung, mọi egress HTTP của orchestrator/worker đi qua nó để policy và socket dùng chung một resolution |
| business | Shared packages | Other business internals, service internals |

Package exports public interfaces rõ ràng. Alias `@/` chỉ nội bộ một subproject; shared imports dùng `@du/contracts`, `@du/worker-sdk`... Runtime packages có version; deployed service không yêu cầu mọi business nâng SDK cùng lúc nếu wire contract còn tương thích.

## Build/deployment dự kiến

- Orchestrator: một image app+runtime; process lifecycle kiểm chứng ở P1.
- Connector: một image Node HTTP service; Hono là lựa chọn đề xuất để gọn.
- Mỗi business: một image, exact manifest version và image digest được đăng ký.
- Node active LTS, TypeScript strict, PostgreSQL + Drizzle, BullMQ + Redis, S3-compatible. Phiên bản cụ thể phải pin và kiểm tra tương thích tại P1; không kế thừa mù phiên bản project cũ.
- Migrations do one-shot command riêng theo schema owner; không để tất cả replica tự migrate lúc boot.
- CI phát hiện changed workspace; kiểm tra contracts làm trigger consumer compatibility suites.

## File ownership khi giao agent

Contract owner sửa `packages/contracts` và docs 04–09. Platform owner sửa Orchestrator. Connector owner sửa Connector và connector-client. SDK owner sửa worker-sdk/document-kit. Business owner sửa business folder. QA owner sửa black-box tests. Infra owner sửa infra.

Root workspace config/lockfile chỉ một integration owner sửa trong một thời điểm. Agent không tự sửa contract đang freeze để làm test riêng pass; tạo change note rồi tích hợp qua owner.
