# Quy ước phát triển Orchestrator Admin UI

> Đề xuất tích hợp ngày 2026-10-04 cho các lane Profile, component chung và Admin shell. [Plan triển khai Admin Web](../tasks/ADMIN-WEB-DELIVERY-2026-10-04.md) chia các slice cụ thể; contract này không đánh dấu `ACUI-*` đã được triển khai, kiểm thử hoặc nghiệm thu. Hành vi nghiệp vụ và quyền vẫn theo [Admin control plane backlog](../tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md), [Profile/Connector field contract](../tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md) và [Admin UX](11-admin-ux.md).

## 1. Kiến trúc đích

- **Frontend:** React + TypeScript strict + Vite, React Router Data Mode. Build thành static assets; Orchestrator phục vụ UI cùng origin tại `/admin/*`. Khi tạo `orchestrator/apps/admin-web`, thêm `apps/*` vào `pnpm-workspace.yaml` trong một thay đổi có lease riêng.
- **Component nền:** dùng [shadcn/ui](https://ui.shadcn.com/docs) làm mã nguồn khởi đầu cho component React, với Tailwind CSS và CSS variables làm hệ style của app mới. shadcn/ui chép mã vào repo; nhóm sở hữu và review mã đó như source sản phẩm. Chọn một primitive base khi bootstrap (mặc định Base UI cho app mới) và không trộn Base UI/Radix/React Aria tùy màn. Đây không phải framework auth, router hay business form.
- **Ranh giới app:** `D:/Git/dugate/components/ui/` là component của Next.js legacy app ở thư mục gốc. Admin Web mới nằm trong `du-rework/orchestrator/apps/admin-web`; component legacy chỉ được port sau khi kiểm props, style, dependency và accessibility. Không import trực tiếp code qua hai app hoặc tính component legacy là deliverable đã ghép.
- **Backend for frontend (BFF):** Orchestrator sở hữu đăng nhập local/OIDC, session, quyền, tenant fence, CSRF, audit và adapter tới Admin API. Browser chỉ gọi `/admin/api/*` cùng origin bằng session cookie; không nhận `adminToken`, Vault token hoặc service credential. Giữ các route `/admin/*` hiện có trong quá trình chuyển từng màn hình.
- **Wire contract:** DTO request/response dùng chung ở `orchestrator/packages/contracts` hoặc một package browser-safe tương đương. Frontend không import `orchestrator/services/orchestrator/src/app/admin/*`, `pg`, Node API hoặc view-model HTML hiện tại. BFF kiểm tra dữ liệu đầu vào ở runtime; TypeScript type không thay validation.
- **Migration:** Chuyển từng route bằng cờ bật phía server, bắt đầu từ màn chỉ đọc. Route chưa chuyển tiếp tục dùng renderer hiện tại. Mỗi route mới phải có đường quay lại renderer cũ cho đến khi kiểm thử và review đạt yêu cầu. Không đổi auth và toàn bộ UI trong một lần.

```text
Browser (React) -- same-origin session + CSRF --> Orchestrator /admin/api/*
                                              --> principal/role/tenant policy
                                              --> typed Admin API/service
                                              --> DB, Connector, Vault, audit
```

## 2. Ranh giới sở hữu để làm song song

| Lane | Sở hữu | Bàn giao bắt buộc | Không sở hữu |
|---|---|---|---|
| Command Code coordinator | Đọc plan `AWEB/ACUI/PAR`, chia task theo dependency, giao agent và file lease, thu receipt, gọi review đúng mốc | Packet implementation/test/review có ID, owner, route, acceptance và build/evidence; theo dõi finding đến khi được sửa và review lại | Viết source trong vai trò điều phối hoặc tự cấp verdict UI |
| Antigravity: component chung | Chỉnh shadcn primitives, design tokens, layout, navigation, form controls, table, badge, dialog, toast, loading/empty/error/denied, responsive và keyboard behavior | Component TSX + Tailwind/tokens + prop contract + fixture/demo cho các variant; không gọi API trong component nền | Profile policy, auth, tenant, mutation |
| Admin UI integrator | Bootstrap Vite/shadcn/Tailwind, router, BFF client, session bootstrap; lập screen spec và triển khai Profile list/draft/validate/diff/publish/activate/rollback theo `ACUI-04`/`ORCH-PAR-02`; build/serve static assets và route rollout | DTO, action/role matrix, fixture đủ trạng thái, API contract, luồng browser → BFF → service, browser tests và rollback route | Component nền, style toàn app; tự đặt lại policy Profile ở frontend hoặc làm giả trạng thái áp dụng |
| Antigravity: reviewer UI | Review độc lập các màn và luồng UI do integrator ghép, từ screen spec đến browser evidence | Finding theo task ID, file:line hoặc URL/state, expected/actual và bằng chứng; verdict `UI_APPROVED` hoặc `CHANGES_REQUIRED` | Quyết định policy auth/tenant, nghiệm thu service/BFF hoặc tự duyệt source component mình viết |

File lease: Antigravity chỉ sửa `orchestrator/apps/admin-web/src/components/ui/`, `src/styles/` và fixture/demo của component; Admin UI integrator giữ `src/features/profiles/`, `src/app/`, `src/lib/api/`, `components.json`, BFF route và shared workspace config. Mọi sửa `shell-router.ts`, `server.ts`, `orchestrator/packages/contracts` hoặc `pnpm-workspace.yaml` cần một owner tại một thời điểm theo `AGENTS.md`. Integrator chạy shadcn CLI lúc bootstrap hoặc phối hợp lease với component owner khi thêm primitive; review diff trước khi ghép vì CLI có thể sửa dependency, alias, global CSS và mã component.

## 3. Hợp đồng component và màn hình

- `components/ui` nhận props dữ liệu và callback; không `fetch`, không đọc cookie, không biết URL Admin API, role hoặc tenant. `features/profiles` chuyển DTO sang props và xử lý state của màn.
- Một nguồn token CSS (`color`, `spacing`, `radius`, `typography`, `focus`, `status`) trong `src/styles/` và Tailwind utility/variant cho component mới. Ánh xạ token mới với biến đang có trong `shell-render.ts` khi hai UI cùng tồn tại; không tạo bộ màu/spacing thứ hai theo từng màn. Không thêm CSS toàn cục từ feature hoặc CSS Modules song song cho cùng một primitive.
- Dùng shadcn cho primitive như Button, Field, Input, Select, Dialog, Table và feedback. Table có phân trang/filter server-side, Profile editor và action flow vẫn là component của feature; không lấy block/demo của shadcn làm bằng chứng nghiệp vụ. Chỉ cài component thật sự dùng, không `add --all`; review accessibility, responsive và dependency của mã được thêm.
- State chuẩn cho mọi pane: `loading`, `ready`, `empty`, `error`, `denied`; mutation có thêm `submitting`, `conflict`, `success`. Component phải hiển thị rõ server validation, `401/403/409/422`, giữ draft khi `409`, và chỉ báo thành công sau khi đọc lại revision/effective state thật.
- Dùng semantic HTML, label và mô tả lỗi gắn với input, focus thấy được, điều khiển được bằng bàn phím, trạng thái disabled/loading rõ, reflow ở 320 CSS px. Component có fixture cho light/dark, dữ liệu dài và empty/error. Mỗi hành động nhạy cảm có tên thao tác, đối tượng và trạng thái xác nhận rõ.
- Profile form được tạo từ schema/manifest và policy server trả về. Unknown widget phải có fallback được xác thực và thông báo rõ; locked field chỉ là hiển thị ở UI, server vẫn từ chối mọi override bị khóa, kể cả client gửi lại cùng giá trị. `fileUrlAuthConfig` và secret thuộc Profile theo [plan Profile mới](../coordination/reports/profile-parity-analysis-2026-10-04.md) là write-only và mã hóa AES-256-GCM trong DB; Connector/provider credential vẫn theo Vault. Không đưa giá trị cũ vào form, HTML, log, draft storage hoặc fixture thật.

## 4. Hợp đồng BFF và an toàn

- `/admin/api/session` (đề xuất) trả principal hiển thị, role, phạm vi tenant và CSRF token cho session hiện tại; `Cache-Control: no-store`. BFF kiểm tra session, tenant và assignment Profile **trên mỗi request**. Không lấy tenant scope hoặc key assignment từ query/body; platform admin mới được chọn phạm vi theo policy. Scoped-user self-service chỉ mở sau `VFY-LOCAL` và contract ánh xạ role/assignment được chốt.
- Mọi mutation gửi `X-CSRF-Token`, `expectedRevision`/state version nếu có và idempotency key cho thao tác có thể lặp. BFF/dispatcher xử lý `401` (đăng nhập lại), `403` (không đủ quyền), `409` (xung đột revision), `422` (lỗi trường), `5xx` (không xác nhận thành công). Nút ẩn theo quyền không thay kiểm tra server.
- Không dùng `localStorage`/`sessionStorage` cho credential hoặc secret. Không đưa `adminToken` vào `VITE_*`, bundle, HTML hay JSON bootstrap. Authenticated responses và secret copy-once dùng `no-store`; secret copy-once không được khôi phục sau reload.
- Trước khi mở dữ liệu Profile/Connector thật cho operator, xử lý `ACUI-M07`: BFF hiện có dùng platform bearer cho một số read. Cần principal/tenant fence server-side và test operator tenant A không đọc được B. Các quyết định audit actor, CSRF/role ordering và Operations action đang mở trong [ACUI decision pack](../coordination/reports/codex-acui-decision-pack-2026-10-02.md); component không tự quyết định policy đó.

## 5. Review UI của Antigravity

- Command Code coordinator đọc plan, chia task và gọi Antigravity khi **một chức năng hoặc nhóm chức năng UI** đã được integrator ghép, build chạy được và có browser evidence cho các trạng thái chính. Coordinator có thể gom các route cùng một hành trình vào một packet review; `AWEB-00` inventory và việc thuần BFF chưa có UI để review thì không tạo verdict UI giả.
- Packet review nêu task ID, route và build/commit, screen spec, role/tenant và fixture, hành trình cần kiểm, trạng thái lỗi/conflict, lệnh/kết quả test, URL hoặc ảnh/video bằng chứng. Antigravity đối chiếu màn đã ghép với spec, kiểm tra thao tác, thông báo lỗi/thành công, loading/empty/denied/conflict, responsive 320px, keyboard/focus, accessibility, light/dark và tính nhất quán token/component. Review trên route/browser và diff source; screenshot hoặc demo component riêng lẻ không đủ để duyệt màn.
- Antigravity ghi verdict `UI_APPROVED` hoặc `CHANGES_REQUIRED` cho từng packet/route/build, kèm finding cụ thể và bằng chứng. Command Code coordinator giao finding cho đúng owner, thu bản sửa và gọi review lại trên build mới. Route chỉ được cutover sau `UI_APPROVED` và các kiểm thử/điều kiện service tương ứng đã đạt; verdict UI không thay kiểm thử auth, tenant, CSRF, audit hoặc acceptance tổng theo `AGENTS.md`.
- Antigravity đang viết component nền, nên Admin UI integrator review độc lập diff source của các component đó, props, dependency và fixture trước khi ghép. Antigravity review màn tích hợp do integrator viết; không tự duyệt patch component của mình. Nếu Antigravity cũng viết một màn feature, màn đó cần reviewer UI độc lập khác trước cutover.

## 6. Trình tự ghép và điều kiện nhận bàn giao

1. Admin UI integrator chốt wire DTO, role matrix, URL, error taxonomy và fixture chung trước khi viết Profile screen. Antigravity có thể xây component từ fixture song song; không phụ thuộc endpoint giả.
2. Tạo app shell và token/component nền; tích hợp một màn chỉ đọc qua BFF để kiểm tra session, route, reflow và lỗi. Giữ renderer cũ làm fallback.
3. Ghép Profile list/detail rồi draft/validate/diff; cuối cùng mới publish/activate/rollback. Không hiện nút action nếu endpoint, policy và audit chưa hoạt động thật.
4. Mỗi slice cần typecheck/build, component behavior test cho tương tác có rủi ro, API contract test, browser test theo role và hai tenant, reload/conflict/expired-session/keyboard/320px. Live mutation test phải chứng minh side effect và audit trên bản build đó. Khi chức năng/nhóm chức năng UI đạt mốc review, Command Code coordinator gửi packet cho Antigravity theo mục 5 và đưa verdict cùng bằng chứng vào quy trình nghiệm thu của repo, không tự nâng trạng thái `VERIFIED`/`ACCEPTED`.

**Điểm ghép tối thiểu:** Admin UI integrator cung cấp Profile DTO + fixture + action matrix; Antigravity cung cấp API props + demo đủ state; integrator tạo adapter từ DTO sang props. Không merge một màn Profile chỉ dựa vào screenshot, form hiển thị hoặc mock response.

## AWEB-UX-NAV-COMP-01 (2026-10-05)

Yêu cầu trực tiếp: React Admin Web dùng left navigator; header chứa logo, thời gian/timezone và account Profile/Logout. Business/Version ở Profiles và Docs dùng completion từ BFF; Connector lookup dùng completion từ management list; Usage dùng calendar UTC. Xem [audit và acceptance](../coordination/reports/admin-ui-navigation-completion-2026-10-05.md). Renderer legacy và route rollout flags không đổi.
