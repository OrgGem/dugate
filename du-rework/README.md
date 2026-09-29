# DU Rework — đặc tả và implementation đang phát triển

Trạng thái ngày 2026-09-29: **đã có các slice implementation chạy được, chưa hoàn tất end-to-end/release**. Xem [roadmap và các release gate đang mở](tasks/README.md) để biết trạng thái hiện tại; [implementation status](coordination/IMPLEMENTATION-STATUS.md) và [checkpoint bàn giao](coordination/CHECKPOINT-2026-09-21.md) là các mốc lịch sử, không phải xác nhận production-ready.

Xây dựng mới trong `du-rework/`. Repository DUGate bên ngoài thư mục này chỉ là tài liệu tham khảo hành vi; không import source, dùng database, chạy migration hoặc sửa cấu hình của hệ thống cũ.

## Mục tiêu đã thống nhất

- Ba loại service: **Orchestrator**, **Business Worker**, **Connector**.
- Orchestrator gồm public API, Admin, Business Registry, profile và điều phối operation nền; không có Coordinator service độc lập.
- `document-core` là business đầu tiên, sở hữu cả 6 action ingest/extract/analyze/transform/generate/compare.
- Xử lý document nội bộ là thư viện `document-kit`, được chạy trong Business Worker.
- Mỗi business mới có worker deployment/queue/version riêng; đăng ký manifest để xuất hiện trong Admin và được gán vào profile.
- Thêm business theo contract hiện hữu không yêu cầu build lại Orchestrator/Connector. Provider protocol mới hoặc loại UI mới có thể cần mở rộng platform.
- Workspace hiện có package manifests, TypeScript source, migrations, container test infra và Jest suites cho contracts, SDK, Connector, Orchestrator, document-kit và document-core. Phạm vi đã chạy vẫn là các package/local slice; chưa suy ra multi-service hoặc production readiness.

## Bắt đầu từ source

Chạy lệnh tại thư mục `du-rework/`, **không phải** root DUGate cũ. Cần Node.js 20+, pnpm 9+ (qua Corepack hoặc cài riêng), Docker Engine + Compose v2 nếu dùng container, và PostgreSQL/Redis cho integration hoặc chạy service. Workspace dùng các package nội bộ `@du/*` qua pnpm; build image/worker từ source phải mang theo các workspace dependency, không cần publish SDK lên registry.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm lint
```

`pnpm build` build các package/service/business trong workspace; `pnpm lint` hiện chạy các script lint của từng package (chủ yếu là TypeScript typecheck). Cấu hình mẫu ở [`.env.example`](.env.example); copy thành `.env` rồi thay toàn bộ token, mật khẩu và khóa mẫu trước khi chạy. Không commit `.env` hoặc dùng secret mẫu ngoài môi trường test. `RUNTIME_TOKEN` dành cho worker/runtime, `ADMIN_TOKEN` dành cho admin; **external client chỉ dùng `x-api-key`** đã được cấp.

### Chạy phụ thuộc local và service

Compose test infra bên dưới cung cấp PostgreSQL trên `127.0.0.1:5433` và Redis trên `127.0.0.1:6380`, tách khỏi DUGate cũ. Trước khi start Orchestrator từ source, đặt `DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test`, `REDIS_URL=redis://127.0.0.1:6380`, `RUNTIME_TOKEN`, `ADMIN_TOKEN`, rồi chạy migration trên **database rework riêng** và start process:

```sh
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm --filter @du/orchestrator run migrate:status
pnpm --filter @du/orchestrator run migrate
pnpm --filter @du/orchestrator start
```

Lệnh `migrate` **ghi vào DB**: chỉ chạy khi đã xác nhận đúng URL, có backup/window phù hợp; `AUTO_MIGRATE=false` mặc định khiến startup kiểm tra migration thay vì tự áp dụng. Để xử lý operation end-to-end, còn cần Connector, worker `document-core`, business version/profile và API key đang active được provision; chỉ start Orchestrator không tự tạo các thành phần đó. Xem [deployment guide](docs/12b-deployment-guide.md), [registry](docs/05-business-registry.md) và [runbooks](docs/17-operational-runbooks.md). Cấu hình `ARTIFACT_STORAGE_BACKEND=postgres` chỉ dành cho pilot/test; production yêu cầu private S3, mã hóa tầng ứng dụng/Vault và các gate DATA/ENC/SEC chưa được nghiệm thu.

## Kiểm thử

Chạy unit/offline trước, không cần DB/S3 thật cho các suite được cô lập. Một số script `test` của package và `pnpm test` toàn workspace có thể chạy integration; không xem chúng là lệnh offline an toàn mặc định.

```sh
pnpm --filter @du/orchestrator test:unit
pnpm --filter @du/connector test:unit
pnpm --filter @du/document-core test
```

Khi cần kiểm thử DB/Redis, khởi động `infra/docker-compose.yml` như trên và chạy `pnpm test:integration`; script này build dependency rồi chạy package `@du/integration-tests`. Suite multi-container của `document-core` là lệnh riêng `pnpm --filter @du/document-core test:integration:full`. Chỉ chạy test live khi đã claim DB window theo [quy tắc repository](AGENTS.md), trỏ đúng test DB và đọc [test strategy](docs/13-test-strategy.md); không dùng DB của DUGate cũ hoặc production. `pnpm test` là toàn workspace, phù hợp sau khi đã chuẩn bị đầy đủ môi trường. Dừng infra bằng `docker compose -f infra/docker-compose.yml down` (giữ dữ liệu test); không thêm `-v` nếu muốn giữ volume.

## Docker

Kiểm tra và chạy **infra test độc lập**:

```sh
docker compose -f infra/docker-compose.yml config --quiet
docker compose -f infra/docker-compose.yml up -d postgres redis
docker compose -f infra/docker-compose.yml ps
```

Muốn thử riêng Connector với DB/Redis test: `docker compose -f infra/docker-compose.yml --profile connector up -d --build connector`. Profile này là fixture single-replica, **không** phải deployment production; container có thể áp dụng migration vào test DB. Xem [infra README](infra/README.md).

**MISMATCH Docker (kiểm tra 2026-09-29):** root [`docker-compose.yml`](docker-compose.yml) mô tả `docker compose up -d --build` cho full stack, nhưng `docker compose --env-file .env.example config --quiet` hiện lỗi `services.postgres conflicts with imported resource` do các file `include` cùng khai báo `postgres`/`valkey`. Vì vậy **chưa có lệnh Compose full-stack đã xác nhận chạy được**; không dùng lệnh ở comment/guide cũ như một hướng dẫn deploy cho đến khi topology được sửa và build/test lại. Các Dockerfile nằm tại `services/orchestrator/`, `services/connector/` và `businesses/document-core/`; chỉ có `infra/docker-compose.yml` được xác nhận hợp lệ về Compose config ở lượt cập nhật README này. Xem thêm [deployment guide](docs/12b-deployment-guide.md) và [release readiness](tasks/P8-release-readiness.md).

## Tích hợp qua Public API

Base URL của Orchestrator local là `http://localhost:3000/api/v1` khi process đã chạy. Client ngoài gửi `x-api-key` của tenant, không gửi `RUNTIME_TOKEN`/`ADMIN_TOKEN`. Key phải active và được gắn profile/business version cho action muốn gọi; Compose không tự cấp key public dùng được. Các endpoint đang có trong source: `POST /businesses/{id}/actions/{action}`, `GET /operations`, `GET /operations/{id}`, `GET /operations/{id}/result`, `GET /artifacts/{id}/download` và upload API. Sáu action của `document-core` là `ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`; `input` tùy schema của action/version.

Ví dụ PowerShell cho `ingest` văn bản (cần Orchestrator + worker + profile/key đã cấu hình):

```powershell
$baseUrl = 'http://localhost:3000/api/v1'
$apiKey = '<api-key-duoc-cap>'
$headers = @{ 'x-api-key' = $apiKey; 'idempotency-key' = '<uuid-moi-cho-request>' }
$body = @{ input = @{ mode = 'parse'; text = 'Van ban can xu ly'; outputFormat = 'json' } } | ConvertTo-Json -Depth 8
$submitted = Invoke-RestMethod -Method Post -Uri "$baseUrl/businesses/document-core/actions/ingest" -Headers $headers -ContentType 'application/json' -Body $body
$operationId = $submitted.operationId
Invoke-RestMethod -Uri "$baseUrl/operations/$operationId" -Headers @{ 'x-api-key' = $apiKey }
Invoke-RestMethod -Uri "$baseUrl/operations/$operationId/result" -Headers @{ 'x-api-key' = $apiKey }
```

Submit thường trả `202` với `operationId`, `state`, `stateVersion`, `replayed`, `correlationId`, `links`; replay cùng `idempotency-key` và body trả `200`, key trùng với body khác trả `409`. Poll `GET /operations/{id}` đến `SUCCEEDED` rồi mới gọi `/result` (`409` khi chưa xong; `410` khi hết hạn). Result plaintext có dạng `{schemaVersion,data,artifacts,usage,warnings}`; `data.resultRef` có thể là `artifact://...`, còn `artifacts[].download` là URL tương đối dùng cùng `x-api-key` để tải bytes. Nếu admin bật delivery encryption, `/result` trả envelope `{schemaVersion,encrypted:true,delivery}`; client **không** được chọn giải mã bằng query param. `sourceUrl` chỉ được nhận khi backend S3; backend khác trả `422 UNSUPPORTED_STORAGE_BACKEND`. Không gửi dữ liệu nhạy cảm, key hoặc token vào log.

**MISMATCH API cũ/mới:** các route facade `/api/v1/docs/{action}`, multipart legacy và `?sync=true` hiện nằm trong [spec public API](docs/06-public-api.md) nhưng **chưa có route tương ứng trong `services/orchestrator/src/server.ts`**. Client mới nên dùng generic API ở trên; không giả định wire/output đã tương thích DUGate cũ. Xem [kế hoạch compatibility](tasks/API-COMPAT-DUGATE-2026-09-28.md), [ResultEnvelope](docs/06-result-envelope.md) và [public API spec](docs/06-public-api.md) để biết contract dự kiến, phân biệt với code đang chạy.

## Đọc theo thứ tự

1. [Phạm vi sản phẩm và business requirements](docs/01-product-scope.md)
2. [Kiến trúc và quyết định thiết kế](docs/02-architecture.md)
3. [Cấu trúc subproject và dependency](docs/03-project-structure.md)
4. [Data model và state machine](docs/04-data-state.md)
5. [Manifest và đăng ký business](docs/05-business-registry.md)
6. [Public API](docs/06-public-api.md)
7. [Admin và Runtime API](docs/07-internal-api.md)
8. [Connector API](docs/08-connector-api.md)
9. [Queue, SDK và interface functions](docs/09-queue-sdk.md)
10. [Business document-core](docs/10-document-core.md)
11. [Admin UX](docs/11-admin-ux.md)
    - [Yêu cầu giám sát operation, token và chi phí LLM cho người trực](docs/admin-ops-monitoring-cost.md)
12. [Vận hành, bảo mật và capacity](docs/12-operations.md)
13. [Test catalog và acceptance gates](docs/13-test-strategy.md)
14. [Reference mapping và compatibility](docs/14-reference-compatibility.md)

## Roadmap và trạng thái thực hiện

- [Roadmap, task dependencies và cách giao việc](tasks/README.md)
- [Task packet dùng giao agent](tasks/AGENT-TASK-TEMPLATE.md)
- [Decision log và giả định cần xác nhận](docs/15-decisions.md)

Task checkbox chỉ được tick khi toàn bộ acceptance của row có bằng chứng executable hoặc gate. Row unchecked có thể đã có implementation một phần; xem cột gap trong [implementation status](coordination/IMPLEMENTATION-STATUS.md). Nội dung trong code fences của bộ docs vẫn là **spec/example** trừ khi tài liệu dẫn rõ package/test hoặc gate đã chạy.

## Definition of done tổng thể còn lại

1. Sáu action của document-core chạy qua connector mock, có profile/operation/artifact đầy đủ.
2. Deploy một business mẫu mới, đăng ký, gán profile và gọi được mà image digest Orchestrator/Connector không đổi.
3. Các thử nghiệm mất kết nối, duplicate delivery, restart giữa bước, cancel/resume và billing dedup đạt yêu cầu.
4. Có số liệu benchmark trên cấu hình ghi rõ; không tuyên bố khả năng chịu tải từ số replica đơn thuần.
5. Các thay đổi code/deploy chỉ diễn ra khi người dùng yêu cầu bước triển khai tiếp theo.
