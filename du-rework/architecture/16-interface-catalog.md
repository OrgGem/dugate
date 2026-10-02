# 16 — Catalog giao tiếp giữa các thành phần

**Phạm vi:** nhóm route đang hiện diện trong code ngày 2026-10-02, không phải bản sao đầy đủ của OpenAPI hoặc cam kết legacy parity. Wire schema, status/error chi tiết nằm ở `@du/contracts`, [Public API spec](../docs/06-public-api.md), [runtime/admin spec](../docs/07-internal-api.md), [Connector API spec](../docs/08-connector-api.md) và [legacy parity contract](../docs/39-legacy-parity-contract.md).

Ví dụ request/response theo router hiện tại: [Public API](17-public-api-examples.md) và [Runtime/Admin/Connector](18-internal-api-examples.md).

## 1. Client ↔ Orchestrator Public API

Base path `/api/v1`; client dùng `x-api-key` của tenant. Những nhóm sau có trong [router](../services/orchestrator/src/server.ts):

| Nhóm | Các route/khả năng chính | Module owner |
|---|---|---|
| Submit | `POST /businesses/{id}/actions/{action}`; response trả operation để poll. | `modules/operations/submission.ts`, registry/profiles |
| Operation | `GET /operations`, `GET /operations/{id}`, `GET /operations/{id}/result`, `POST /operations/{id}/cancel`, `POST /operations/{id}/resume`. | operations facade, runtime/lifecycle |
| Artifact | `GET /artifacts/{id}/download`; public `/uploads` và content/part/complete/abort tùy storage/encryption config. | artifacts, public-api, encryption |
| Usage | `/usage`, `/usage/summary`, `/usage/events` với auth/filter theo route. | usage |
| Connector test | `/connectors/{id}/test` qua proxy. | connectors |
| Legacy compatibility | `/docs/{action}` và một số operation/artifact wire cũ qua `compat/legacy-http-mount.ts`. | compat + host adapter |
| Health | `/api/v1/health` và `/health`. | server |

Điểm quan trọng: URL hiện diện trong router chỉ xác nhận có handler. Path có thể phụ thuộc feature config, business/profile/key và storage backend. Với legacy facade, contract cần so method/path/query/form/status/header/body trên fixture cũ; `handleLegacyRoute` có mặt chưa chứng minh toàn bộ parity.

## 2. Worker ↔ Orchestrator Runtime API

Base path `/api/runtime/v1`; identity worker được ràng theo business, không dùng public API key. [Runtime service](../services/orchestrator/src/modules/runtime/runtime.ts) và [worker SDK](../packages/worker-sdk/src/) giữ contract consumer.

| Nhóm | Route điển hình | Mục đích |
|---|---|---|
| Registration | `PUT /businesses/{id}/versions/{version}`, `PUT /workers/{instanceId}/heartbeat` | Công bố manifest/version và worker liveness/capacity. |
| Task lease | `POST /tasks/{id}/claim`, `POST /tasks/{id}/heartbeat` | Nhận task và duy trì lease epoch. |
| Step/progress | `PUT /tasks/{id}/steps/{stepKey}`, `POST /tasks/{id}/progress` | Checkpoint idempotent và tiến độ. |
| Completion | `POST /tasks/{id}/complete`, `POST /tasks/{id}/fail` | Chuyển terminal hoặc retry theo runtime policy. |
| Continuation | `POST /tasks/{id}/children`, `POST /tasks/{id}/wait-input` | Fan-out/join và human input wait. |
| Artifact | Task artifact create, multipart, blob upload, finalize/access. | Grant theo task/lease, pin bytes và reference. |
| Connector | `POST /tasks/{id}/invocation-grants` | Signed grant giới hạn task/slot/revision. |
| Usage ingress | `POST /usage-events` | Connector gửi event bằng token usage chuyên biệt. |

Tên/path chính xác cho từng nhánh multipart và schema request phải lấy từ router/contracts khi viết client mới.

**`GET /tasks/{id}/context` không tồn tại trong router.** Route này xuất hiện trong một số spec cũ ([docs/07](../docs/07-internal-api.md), OpenAPI artifact) nhưng `server.ts` không có matcher nào cho nó; bảng matcher runtime ở trên là danh sách đầy đủ. Không phải chờ config — đây là route chưa từng được cài. Client không được phụ thuộc vào nó.

Ngoài các nhóm trên, router còn phục vụ `GET /tasks/{id}/children` (join visibility) và `GET /workspace-reference?workspacePath=<dir>&tenantId=<uuid>`; route thứ hai là integration phía writer duy nhất mà worker cần theo mô tả trong source.

## 3. Operator ↔ Orchestrator Admin

Admin JSON chủ yếu ở `/api/v1/admin/*`; rendered shell ở `/admin/*` khi cấu hình được cấp. API hiện có nhóm business/version, profile binding, connector management, API key listing, audit, crypto config, operations/deadline sweep và action dispatcher. Source tương ứng là [router](../services/orchestrator/src/server.ts), [admin shell](../services/orchestrator/src/app/admin/) và [admin actions](../services/orchestrator/src/modules/admin-actions/). Một số thao tác có UI/route nhưng còn phụ thuộc composition/config hoặc gate browser/security; xem [task board](../tasks/README.md).

**Connector mutation đi qua action dispatcher, không phải route `/admin/connectors`.** Router chỉ có `POST|GET /api/v1/admin/connectors/{id}/credentials` và `GET /api/v1/admin/connectors/{id}/revisions/{rev}`; các thao tác xoay vòng/thu hồi/kiểm credential chạy qua `POST /api/v1/admin/actions` với action `connectors.rotate_credential`, `connectors.revoke_credential`, `connectors.test_credential`. Trái với điều đó, admin shell hiện vẫn hướng dẫn operator gọi `POST /api/v1/admin/connector-bindings` — route này không có trong router; xem [CODE-FIX-01](../tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md) để quyết định sửa hướng dẫn hay bổ sung route.

`docs/07-internal-api.md` có bảng mục tiêu `/api/internal/v1`; source hiện tại dùng nhiều route `/api/v1/admin/*`. Khi xây client/Admin automation, chọn path từ code/contract hiện hành thay vì suy `/api/internal/v1` đã được mount.

## 4. Orchestrator/worker ↔ Connector

[Connector HTTP router](../services/connector/src/http/server.ts) có health, capabilities, management `/connectors*` (revision, activation/retire, credential rotation/disable/test) và runtime `/invocations*` (invoke/get/cancel). Health liveness/readiness công khai; phần còn lại yêu cầu service identity khi verifier được cấu hình. Invocation cần signed grant, tenant/revision binding và quota. Response có `completed`, `pending`, `unknown`, `failed`, `cancelled`; consumer phải xử lý state theo contract, không tự retry `unknown` như request chưa gửi.

Router còn có các route đọc revision mà catalog trước đây bỏ sót: `GET /connectors/{id}/revisions/current` và `GET /connectors/{id}/revisions/{n}` — đây là nơi đọc revision `ACTIVE` mà invariant binding của §4 dựa vào. Quan trọng hơn, `POST /connectors/{id}/revisions/bootstrap` là đường **duy nhất** tạo được revision 1 của một bound chain; đường `POST /connectors/{id}/revisions` thông thường không mở được chuỗi đã bound. Đọc router trước khi kết luận không có đường chuyển từ legacy sang bound.

**Chưa có route nhận webhook của provider.** `services/connector/src/webhook.ts` export `verifyWebhookSignature`/`parseWebhookPayload` và được re-export qua `index.ts`, có test riêng, nhưng `http/server.ts` không đăng ký route nào dùng tới nó — helper xác thị callback đã có và được kiểm thử, đường nhận chưa được mount.

## 5. Không gian version và compatibility

- **Business version** quyết định manifest, queue và handler được pin cho operation.
- **Connector revision** quyết định adapter/config/credential source được grant pin khi gọi provider.
- **Contract/schema version** quyết định DTO và error semantics giữa client/service/worker.
- **Legacy compatibility** là lớp adapter cho wire DUGate cũ, không thay thế generic API hay quyền tenant. Kế hoạch/gate chi tiết ở [COMP tasks](../tasks/API-COMPAT-DUGATE-2026-09-28.md).

Mỗi thay đổi wire cần kiểm cả producer và consumer: API router ↔ `@du/contracts` ↔ SDK/business/client, hoặc Orchestrator grant ↔ Connector verifier. Nếu spec và source bất đồng, ghi mismatch rõ thay vì âm thầm chọn một bên.

**MISMATCH đang thấy khi viết ví dụ:** `OperationViewSchema` yêu cầu `tenantId`, trong khi `toOperationView()` của public `GET /operations/{id}` hiện trả `name` và không trả `tenantId`. Xem [ví dụ poll và phân tích chênh lệch](17-public-api-examples.md#3-poll-trạng-thái-và-phân-trang). Đây là việc cần consumer contract test/owner quyết định, không nên tự sửa tài liệu cho một phía rồi coi như đã giải quyết.
