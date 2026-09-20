# Project structures và ownership

Các thư mục dưới đây là **cấu trúc implementation dự kiến**. Hiện chỉ có README/spec/task Markdown. Dùng npm workspaces độc lập trong `du-rework`; không sửa root package.json/lockfile của DUGate.

```text
du-rework/
  docs/                         # normative specifications
  tasks/                        # phase packets, dependencies, DoD
  services/
    orchestrator/
      src/server/               # long-running server, background lifecycle
      src/app/                  # Next routes + Admin pages
      src/modules/
        auth/ registry/ profiles/ operations/ runtime/
        artifacts/ outbox/ usage/ webhooks/ audit/
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
  packages/
    contracts/                  # JSON schemas, DTOs, errors, API descriptions
    worker-sdk/                 # queue/runtime lifecycle, task/step facade
    connector-client/           # typed invocation + replay/poll client
    document-kit/               # parse, conversion, archive, file helpers
    observability/              # logger, trace IDs, metrics interfaces
  infra/                        # compose, deployment, environment/runbooks
  tests/                        # black-box contract/e2e/fault/load suites
```

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
