# INGRESS-AUDIT-907 — 2026-10-05

## Kết luận

PM-M02 ingress fence **chưa được triển khai trong working tree hiện tại**. Orchestrator gom health, public API, admin JSON API và runtime API vào cùng route dispatcher và cùng HTTP listener trên port 3000; các route handler phân quyền bằng API key/bearer ở tầng ứng dụng nhưng không phân biệt request đến từ public ingress hay internal ingress. Không có route family `/api/internal/*` và không có kiểm tra listener/interface/peer để giới hạn internal API theo ingress. Compose mặc định còn publish host port Connector `8080` trên loopback; chỉ `BIND_ADDRESS` override mới đổi địa chỉ bind host.

PM-M03 tenant-scoped Connector readiness có fence trong route hiện tại: API key được kiểm tra, sau đó binding tenant/connector được xác minh trước khi gọi probe có network I/O. Đây là kiểm soát ứng dụng cho probe cụ thể, không khép khoảng trống ingress PM-M02. Kết luận này dựa trên source/config hiện có; chưa xác minh deployment đang chạy.

## Phạm vi và cách kiểm tra

Đây là audit tĩnh, chỉ đọc source, Compose fragments, deployment guide và migration-plan. Không sửa source/test/config, không chạy test/typecheck, không khởi động hoặc truy vấn deployment, không commit, stage, tick hay push. Các tham chiếu dưới đây là working-tree content.

`docker-compose.yml:3-9` import đủ sáu fragment `compose/infra.yml`, `orchestrator.yml`, `connector.yml`, `document-core.yml`, `lc-checker.yml`, `example-review.yml`. Các giá trị effective dưới đây là giá trị mặc định trong repo khi không có biến override; deployment environment thực tế có thể thay đổi chúng.

## Listener và dispatch hiện tại

- `services/orchestrator/src/server.ts:268-327` xử lý health trước, rồi gọi lần lượt `handleRuntimeRoutes`, `handlePublicRoutes`, `handleAdminRoutes`; route không khớp trả 404. Đây là phân nhóm handler, không phải phân nhóm ingress/listener.
- `services/orchestrator/src/app/bootstrap/create-app.ts:695-796` chuyển method/path/header cùng dependency context vào route dispatcher. `:838-840` tạo một `node:http` server; `:875-876` gọi `server.listen(config.port)` cho listener API.
- `services/orchestrator/src/main.ts:311-350` khởi tạo app và chỉ gọi `app.listen()` cho API trên `ORCHESTRATOR_PORT` (mặc định 3000). Orchestrator service được gắn cả `du-platform-net` lẫn `du-worker-net` (`compose/orchestrator.yml:77`), do đó cùng listener phục vụ request đi vào từ hai network đó.
- `services/orchestrator/src/http/route-context.ts:40-98` không có remote address, socket, ingress/listener identity hay trường trusted audience. Request context chỉ mang method/path, headers, body, host và các service.
- Admin shell là listener riêng: `services/orchestrator/src/app/admin/shell-server.ts:799,874-894`. Đây là web shell/session surface, không phải listener riêng cho các route JSON `/api/v1/admin/*`. Compose đặt `ADMIN_SHELL_HOST=0.0.0.0` (`compose/orchestrator.yml:34-35`) và publish port 3001.

Không tìm thấy route path `/api/internal`, ingress allow/deny selector, hay mã kiểm tra peer/interface trong Orchestrator HTTP dispatcher. Chuỗi `internal` còn xuất hiện trong tên error/comment nhưng không phải route fence.

## Effective Compose mặc định

| Fragment / service | Host-published ports mặc định | Network / ghi chú |
|---|---|---|
| `compose/infra.yml:1-36` — Postgres, Valkey | Không có `ports`/`expose` | Postgres ở `du-platform-net`; Valkey ở cả platform và worker net. Hai network declarations `:31-33` không đặt `internal: true`. |
| `compose/orchestrator.yml:17-86` — Orchestrator | `127.0.0.1:${ORCHESTRATOR_PORT:-3000}:3000` và `127.0.0.1:${ADMIN_SHELL_PORT:-3001}:3001` theo default `BIND_ADDRESS` | Orchestrator ở cả `du-platform-net` và `du-worker-net`; API 3000 và JSON public/admin/runtime cùng listener. Admin shell 3001 là listener riêng. |
| `compose/connector.yml:1-38` — Connector | **Có publish mặc định:** `127.0.0.1:${CONNECTOR_PORT:-8080}:8080` (`:22-23`), không bị profile hay cờ opt-in giới hạn | Connector ở cả hai network; trong container `HOST=0.0.0.0`, `PORT=8080` (`:8-10`). |
| `compose/document-core.yml:1-28` — Document Core | Không có `ports`/`expose` | Chỉ `du-worker-net`. Runtime URL mặc định trỏ Orchestrator `:3000` (`:9-10`). |
| `compose/lc-checker.yml:1-29` — LC Checker | Không có `ports`/`expose` | Chỉ `du-worker-net`; Connector URL mặc định `connector:8080` (`:16-17`). |
| `compose/example-review.yml:1-24` — Example Review | Không có `ports`/`expose` | Chỉ `du-worker-net`; Runtime URL mặc định trỏ Orchestrator `:3000` (`:9-10`). |

`docs/12b-deployment-guide.md:73-80` ghi `BIND_ADDRESS` mặc định là `127.0.0.1`; `.env.docker.example:8-11` đặt loopback và các host port 3000/3001/8080. Vì vậy Connector port được publish trên **host loopback** mặc định, không phải trực tiếp trên mọi interface của host. Nếu override `BIND_ADDRESS=0.0.0.0` thì cả các mapping dùng biến này có thể được publish trên mọi interface; cần firewall/front-door policy của deployment.

Compose hiện không có network `internal: true`; Orchestrator và Connector đều nối vào hai network. Bỏ host mapping Connector sẽ loại đường publish từ host nhưng tự nó **không** phân tách các route giữa worker, Connector và Orchestrator trên những network chúng cùng tham gia.

## HTTP allowed/denied matrix hiện tại

| Surface | Path tiêu biểu | Ai được handler cho qua | Kết quả về ingress |
|---|---|---|---|
| Health Orchestrator | `GET /health`, `GET /api/v1/health` | Không yêu cầu auth; đọc DB/Redis/lease health (`server.ts:278-314`) | Cùng port 3000; mọi peer tới được listener đều có thể gọi. Không có ingress deny. |
| Public API | `/api/v1/*`, gồm submit, operations, uploads, artifacts, usage | Thường cần `x-api-key` ACTIVE (`http/routes/api-key-auth.ts:10-22`); một số read route hỗ trợ Admin bearer thay thế theo route (`public.ts:170-200,394-420`) | Cùng port 3000, khả dụng từ host-published port và cả hai Compose networks. Thiếu/sai key bị handler trả 401; tenant/scope sai bị 403/404. Không bị chặn theo network audience. |
| Public Connector readiness probe | `GET /api/v1/connectors/:id/test` | `x-api-key` ACTIVE, tenant phải sở hữu enabled binding cho connector trên active profile; xem PM-M03 dưới đây | Cùng port 3000; caller có thể tới endpoint, quyết định cho phép/deny ở handler. Unauthorized bị 401/403 trước outbound fetch. |
| Admin JSON API | `/api/v1/admin/*`, gồm `GET /api/v1/admin/connectors/capabilities` | Platform Admin bearer qua `assertAdminAuth` (`admin.ts:44-55,532-541`); một số route áp thêm principal/tenant/role/session policy | Cùng port 3000. Sai/thiếu Admin bearer bị 401; scope/role sai bị 403. Không có ingress-only admin listener. |
| Runtime/worker API | `/api/runtime/v1/*` | Runtime bearer hoặc worker token đã map theo business; task/artifact endpoints xác minh thêm quyền trên business/task (`runtime.ts:21-42`). `POST /api/runtime/v1/usage-events` dùng `USAGE_TOKEN` riêng (`:172-181`). | Cùng port 3000, cũng được publish ở host 3000 và có mặt trên platform lẫn worker network. Handler trả 401/403 nếu credential/scope sai; không bị network ingress fence. |
| Internal API | `/api/internal/*` | Không có route family/endpoint khai báo trong source hiện tại | Request tới listener vẫn được nhận; path không khớp dispatcher trả 404 (`server.ts:327`). Đây là 404 cho route không tồn tại, không phải internal-ingress policy. Runtime endpoints không được biến thành internal-only chỉ nhờ tên/token. |
| Admin web shell | Listener riêng, port 3001 | Shell cookie/session/auth policy; route mutations có CSRF/session controls | Port host-published loopback mặc định. Không tách các JSON Admin route khỏi 3000. |
| Connector service | Port 8080, ví dụ `/health/live`, `/health/ready`, `/connectors/*` | Production entrypoint yêu cầu `SERVICE_IDENTITY_SECRET` và cài identity verifier (`services/connector/src/entrypoint.ts:9-18`); Connector HTTP server bỏ qua identity cho `/health/live` và `/health/ready` (`services/connector/src/http/server.ts:131-161`) | Service ở hai network và host port loopback-published mặc định. Hai health path không yêu cầu service identity; endpoint khác được auth bởi service identity khi verifier wired. Không có ingress fence cho host port. |

Trong source không có route nào bị từ chối vì request đến sai listener/interface/network. Hiện chỉ có từ chối ở tầng route/auth (401/403), hoặc 404 do không có route.

## PM-M03 — readiness tenant fence trước network

**Có fence trong route hiện tại, tại tầng ứng dụng.** `services/orchestrator/src/http/routes/public.ts:208-214` thực hiện tuần tự `resolveApiKey` → `authorizeConnectorProbe` → `ctx.connectors.testConnector`. `api-key-auth.ts:10-22` chỉ resolve key có trạng thái ACTIVE. `modules/connectors/probe-authorization.ts:22-29` JOIN `profile_active_revisions`, `profile_bindings`, `api_keys`; ràng buộc `p.api_key_id`, `p.tenant_id`, `p.enabled=true`, `k.status='ACTIVE'`; `:31-43` xác minh lại tenant/key/bật binding, parse `connector_bindings`, và yêu cầu connector ID xuất hiện trong binding. Không có binding hợp lệ thì trả 403; binding lỗi thì trả 503; cả hai nhánh dừng trước `testConnector`.

`modules/connectors/connectors.ts:49-61` xác nhận network call là fetch tới base URL lấy từ platform config và path `/health/ready`, không forward caller headers. Direct Connector `/health/ready` là process/dependency health endpoint riêng: `services/connector/src/http/server.ts:131-161` miễn service identity cho health/live và gọi `dependencies.ready()`. Compose healthcheck cũng gọi local `127.0.0.1:8080/health/ready` (`compose/connector.yml:30-35`). Endpoint này không phải tenant-scoped outbound probe; nó vẫn truy cập được qua host loopback mapping.

Phần trên là xác nhận thứ tự trong source hiện tại, không phải test HTTP mới hay bằng chứng live/deployed.

## Đề xuất để đóng PM-M02 (không triển khai trong task này)

1. **Route/Orchestrator edit:** khai báo audience allowlist rõ cho từng ingress; source public không dispatch `/api/runtime/v1/*` hay internal-only route; runtime/internal listener chỉ nhận allowlisted worker/runtime paths. Audience phải đến từ listener riêng hoặc proxy/network metadata được tin cậy, không lấy từ `Host` hay header caller tự gửi. Nếu giữ chung một socket/route dispatcher, cần ingress proxy có policy riêng trước app và test chứng minh request bị từ chối trước handler.
2. **Compose edit:** bỏ `ports` Connector khỏi cấu hình mặc định (`compose/connector.yml:22-23`); nếu local debugging cần host access thì chuyển sang override/profile opt-in rõ ràng. Tiếp đó triển khai listener/proxy/network topology khớp audience matrix; tránh chỉ thêm `internal: true` vào network dùng chung mà chưa kiểm tra nhu cầu outbound của workers/connectors. Orchestrator và Connector hiện cùng nhiều network nên port mapping removal đơn lẻ không tạo segmentation.
3. **Acceptance:** sau khi code và Compose được ghép, kiểm tra effective config bằng env deployment đã sanitized; từ host/public ingress chứng minh runtime/internal bị từ chối trước route side-effect; từ worker ingress chứng minh runtime được phép với token đúng; thử sai bearer/sai tenant; xác minh Admin/public surface không đổi; chạy probe unauthorized với spy/trace chứng minh zero outbound fetch.

## Ownership / serialize

`coordination/reports/plat-mig-00-topology-inventory-2026-10-05.md:68-70` chỉ định một integration/build owner cho root manifest/workspace/lockfile, và một deployment/security owner duy nhất cho `docker-compose.yml`, `compose/infra.yml`, service fragments cùng ingress/network wiring; report cấm các writer Compose song song. Vì vậy phần port/network/aggregate Compose phải serialize qua central deployment/security owner. Route edits cần lease Orchestrator riêng nhưng nên có một integration checkpoint trước khi claim matrix đóng. Không cần lockfile change cho thay đổi listener/port thuần; nếu thêm dependency thì `pnpm-lock.yaml` phải qua integration/build owner.

Tại snapshot trước khi ghi receipt, các file audit đã có working-tree changes: `docker-compose.yml`, `pnpm-lock.yaml`, `services/orchestrator/src/main.ts`, `server.ts`, `services/connector/src/entrypoint.ts` là modified; sáu fragment Compose và các route/context/bootstrap/probe files là untracked. Audit không sửa các file đó. Do đó các findings ràng buộc đúng working tree hiện tại; không nên coi chúng là đã commit hoặc deployed.

## Phạm vi chứng minh

**Offline-proven:** listener/route dispatch topology trong source; auth ordering trong route; các `ports`, service networks và defaults ghi trong Compose; không có `internal` route family/ingress selector trong phần HTTP được kiểm tra.

**Chỉ live/deployment mới xác nhận được:** giá trị env thực sự đang override `BIND_ADDRESS`/ports; config Compose đã render trên host triển khai; published socket và reverse-proxy/firewall behavior; peer reachability từ máy public, host, worker và service khác. Task này không đọc secret env, không gọi HTTP, không kiểm tra container/proxy đang chạy.

## Snapshot digests (SHA-256)

Các hash dưới đây được tính khi audit source/config, trước khi receipt được ghi; chúng nhận diện working-tree snapshot chưa commit được kiểm tra.

| File | SHA-256 |
|---|---|
| `services/orchestrator/src/server.ts` | `3f4d9759e5823e2617e92ca916342887fa8e7ec724fbebcd8b0d106a6875292f` |
| `services/orchestrator/src/app/bootstrap/create-app.ts` | `a3503f7c02f7888aaef0f00e74f970a613f09a09fffe84553dcea0ec827669ad` |
| `services/orchestrator/src/http/routes/public.ts` | `ef1f74714aa2f4b972ad6db0bb4aab62f6e0401fe9cff2c943043989a7eea97f` |
| `services/orchestrator/src/modules/connectors/probe-authorization.ts` | `cde6c9f1ab43cea5efdf266bddc719bc8c06a61e3d7270db2604b9fbae7fc332` |
| `docker-compose.yml` | `f6a4c0db936064490f193e6292804597d0c6240e1d64a16ba18818f87280b596` |
| `compose/infra.yml` | `0cd24e6f22ffbb1c72ede520fb49249b2d5d6eb89c4a28f4ecd692d49d318b63` |
| `compose/orchestrator.yml` | `759debef775e96f560f9cd10630b438507b6f10054dc53f84e19405e37c8924b` |
| `compose/connector.yml` | `ca5ec309e38dcc914ea21d84a6351b1ea8070312277a775885cd66e7c1342529` |
