# Admin Durework: đầy đủ DUGate và chuyên biệt cho điều hành hệ thống

**Yêu cầu người dùng ngày 2026-10-05:** quản trị trên Durework phải có đầy đủ chức năng quản trị đang hoạt động trong DUGate ở root, nhiều khả năng hơn và UI tối ưu cho quản lý hệ thống, điều hành services.

**Trạng thái: SPECIFIED; đối chiếu source, chưa xác nhận runtime hoặc nghiệm thu sản phẩm.** Phạm vi lần này là review và bổ sung plan. Không sửa source sản phẩm, dispatch, active ledger, checkbox cũ hoặc triển khai production. Snapshot là working tree ngày 2026-10-05; source đang được nhiều lane phát triển. Evidence lịch sử chỉ có hiệu lực đúng slice/build được ghi trong receipt.

## 1. Kết luận và quan hệ với plan hiện hành

[CFGADM-00..11](ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md) đã có inventory chức năng root và mapping đủ 17 settings; không lập lại backlog parity. [ACUI](ADMIN-CONTROL-PLANE-UI-2026-10-02.md) có cấu hình phiên bản hóa, quyền và rollout; [AWEB](ADMIN-WEB-DELIVERY-2026-10-04.md) có React/BFF; [ADM-UX](ADMIN-OPS-UX-2026-09-24.md) và [COST](../docs/admin-ops-monitoring-cost.md) có triage, phân trang, token/cost/budget. [P8-07 dashboard/alerts](../docs/ops/p8-07-dashboards-alerts.md) đã mô tả tín hiệu vận hành. Phần thiếu là ghép các khả năng đó thành UI điều hành xuyên service, với telemetry thật và hành trình xử lý sự cố có thể nghiệm thu.

Phạm vi bắt buộc gồm **parity + cải tiến vận hành trong plan này**. Không tự chuyển tính năng cũ hoặc cải tiến dưới đây sang optional/post-cutover; thay đổi scope cần quyết định riêng của người dùng. Các ID `AOPS-*` là sub-packet acceptance của parent hiện hữu, không phải release gate mới và không cộng trùng coverage/tiến độ của parent. `G-ADMIN-OPS` nhận parity/UX/ops journeys; `P8-07` nhận telemetry/alerts/runbooks; `P8-08/G6` nhận cả hai cùng gates hiện hữu. `G-COMP` tiếp tục sở hữu external API compatibility, không chuyển thành gate cho mọi màn Admin.

### Các khoảng trống xác nhận từ source

| ID | Expected / actual tại snapshot | Neo source; owner / hành động |
|---|---|---|
| AOPS-M01 | Navigation toàn app theo tác vụ. Shell hiện chỉ có Overview, Bootstrap và Legacy shell; các link section đặt ở Overview. Router có nhiều route nhưng không có Services, Workers & Queues hoặc Incidents. | [shell](../apps/admin-web/src/app-shell/app-shell.tsx:12), [router](../apps/admin-web/src/router.tsx:35); AWEB/UI integrator → AOPS-01. |
| AOPS-M02 | Overview phục vụ ca trực với KPI và drilldown. Component hiện đọc session/audit, còn Usage/Operations rollup là placeholder `requires backend`. Không suy rằng backend Usage/Operations riêng chưa tồn tại từ comment này. | [overview](../apps/admin-web/src/features/overview/overview-screen.tsx:40), [placeholder](../apps/admin-web/src/features/overview/overview-screen.tsx:124); projection/BFF/UI → AOPS-02. |
| AOPS-M03 | Settings AI/prompts/S3 chỉnh và dùng được như root; desired/effective phải đọc từ service. Màn hiện là catalog tĩnh sáu dòng env, không có form parity hoặc observed revision; lời hướng dẫn reload không chứng minh config đã áp dụng. | [settings](../apps/admin-web/src/features/settings/settings-screen.tsx:18), [reload copy](../apps/admin-web/src/features/settings/settings-screen.tsx:87); CFGADM-01..04 + ACUI-09, không tạo CRUD settings thứ hai. |
| AOPS-M04 | Operator hoàn thành cancel/resume/recovery đúng quyền. Operations screen đang disable Cancel/Resume/Replay vì thiếu composition cho Admin; có public lifecycle route không thay Admin journey. | [operations](../apps/admin-web/src/features/operations/operations-screen.tsx:163); ADM-UX-05/CFGADM-10/BFF/runtime → AOPS-05. Replay chỉ mở sau contract an toàn. |
| AOPS-M05 | Các số liệu worker/queue/outbox/provider phải có source, freshness, drilldown. Plan telemetry đã chỉ rõ thiếu exporter/dashboard đầy đủ; health process đơn lẻ chưa đủ. | [telemetry baseline](../docs/ops/p8-07-dashboards-alerts.md:7), [metrics](../docs/12-operations.md:32); P8-07/observability/runtime/Connector → AOPS-00/03/04/06. Đây là gap tích hợp/acceptance, không claim mọi metric đều chưa code. |
| AOPS-M06 | UI phục vụ quản trị. Shell hiện chứa nhãn server-session, AWEB/build/mount và tokens dành cho phát triển. | [shell status/footer](../apps/admin-web/src/app-shell/app-shell.tsx:52); AWEB/UI → AOPS-01, đưa diagnostics vào System information theo quyền. |

## 2. Ma trận parity bắt buộc và cải tiến tương ứng

Source dưới đây là code quản trị DUGate tại root, không phải bằng chứng hệ thống cũ đã chạy live. Chi tiết field/17 settings giữ nguyên tại CFGADM; mỗi hàng cần receipt và verdict đúng build trước acceptance.

| Chức năng DUGate / source | Màn hình và tác vụ phải có trên Durework | Cải tiến bắt buộc; parent giữ ownership |
|---|---|---|
| Dashboard: 24h/7d/30d, hour/day, requests/success/token/cost, profile/pipeline breakdown — [DashboardView](../../components/DashboardView.tsx), [analytics](../../app/api/internal/analytics/route.ts) | Overview + Usage: đủ bộ lọc/metrics cũ, drilldown xuống operation/invocation. | Thêm queue age, UNKNOWN, usage lag, service health, budget và freshness; dữ liệu thiếu là unknown. CFGADM-10/COST/ADM-UX; AOPS-02. |
| History: search/state/cancel/delete — [ConversionHistory](../../components/ConversionHistory.tsx) | Operations: search toàn tập, filter/sort/cursor, cancel và delete theo retention. | Root fetch tối đa 100 rồi lọc client; mới phải tìm được record ngoài trang đầu và giữ URL/back navigation. CFGADM-10/ADM-UX-02..05; AOPS-05. |
| Detail: text/JSON/steps/usage/download/HITL — [operation detail](../../app/operations/[id]/page.tsx) | Operation detail: timeline, result previews, download, input/resume, lỗi có thể xử lý. | Liên kết task → worker → invocation → Connector → artifact → audit, revision pin, lease/deadline và usage pending. CFGADM-10/COMP/ENC; AOPS-05. |
| Stalled status/recovery — [recover-stalled](../../app/api/internal/recover-stalled/route.ts) | Maintenance: preview danh sách, xác nhận, theo dõi job và kết quả. | Root đánh FAILED sau ngưỡng thời gian; mới cần lease fencing, reconciliation và outcome evidence. Không retry UNKNOWN hoặc kết thúc task còn lease hợp lệ. CFGADM-10/runtime; AOPS-07. |
| AI Gemini/OpenAI-compatible/custom model/base URL/test — [SettingsForm](../../components/SettingsForm.tsx), [test](../../app/api/settings/test/route.ts) | Settings → AI defaults; credential, model, test, save/publish/use/rollback. | Validate capability, credential write-only, revision/binding pin và provider request evidence. CFGADM-01/ACUI-04/06. Anthropic “sắp hỗ trợ” không là parity blocker. |
| Năm prompts + preset EN/VI/template — [settings](../../lib/settings.ts), SettingsForm | Settings → Prompt defaults; edit/preset/diff/validate/publish/rollback. | Provenance default/override/locked, placeholders validation và consumer từng loại file/compare/generate. CFGADM-02/PLAN04-02. |
| S3 endpoint/bucket/access/secret/region/TTL/test/stats/cleanup — [settings API](../../app/api/settings/route.ts:54), [cache](../../app/api/settings/cache/route.ts), [S3 test](../../app/api/settings/s3-test/route.ts) | Settings → Storage & retention, stats và cleanup. | Storage generation, test trước apply, artifact cũ đọc được; dry-run/reference protection và rollback. CFGADM-03/04/DATA/ENC; AOPS-07/08. |
| Key issue/name/note/rotate/delete guard Global — [apikeys](../../app/api/internal/apikeys/route.ts) | API Keys liên kết Profiles/Identity; đủ lifecycle và assignment. | Copy-once, grants, revoke, last-used/expiry nếu contract hỗ trợ; test dùng delegated principal, không lấy raw key đã lưu. CFGADM-05/ACUI-05. |
| Profile endpoint/subcase/enabled/bulk/parameters/locks/priority/extensions/URL auth/steps/session/prompts/reset — [Profiles](../../app/profiles/page.tsx), [profile endpoints](../../app/api/internal/profile-endpoints/route.ts), [overrides](../../app/api/internal/ext-overrides/route.ts) | Profiles: list → detail → endpoint matrix → schema form/step editor, test và publish. | Form phổ biến không bắt nhập raw JSON; effective preview/diff/CAS; bulk báo lỗi từng endpoint; immutable pin được worker dùng thật. CFGADM-05/ORCH-PAR-12/13/PLAN04-01/02. |
| Prompt Wizard + Test Endpoint files/URLs/params/result/usage/cURL — [wizard](../../app/api/internal/prompt-wizard/route.ts), [endpoint test](../../app/api/internal/test-profile-endpoint/route.ts) | Profile workbench + API Docs/Test workbench cho sáu core actions. | Wizard chỉ đề xuất draft; test qua admission thật với giới hạn, audit và result/download; cURL placeholder và redaction. CFGADM-06/11/ACUI-04/06. |
| Connections CRUD/import cURL/auth/POST-PUT/multipart/headers/response & session path/timeout/test files — [Connections](../../app/api-connections/page.tsx), [API](../../app/api/internal/ext-connections/route.ts) | Connectors & Accounts: import preview → edit → test → activate/rollback; bindings. | Credential Vault write-only, pinned revision, provider health/quota/429/latency, in-flight/outcome và affected Profiles trước disable. CFGADM-07/ACUI-06; AOPS-06. |
| Users/password/roles/OIDC metadata/user↔key — [Users](../../app/settings/users/page.tsx), [users API](../../app/api/users/route.ts), [assignments](../../app/api/internal/user-profiles/route.ts) | Identity: local/federated users, role/tenant/profile grants, reset/disable/session revoke. | Permission preview, last-admin guard; legacy USER giữ self-service theo assignment, không nâng thành tenant operator. CFGADM-08/LOCAL/ACUI-02/03. |
| Workflow import JSON/XML/search/detail/mapping/node overrides/run/HITL — [Workflow UI](../../app/workflow-builder/page.tsx), [schemas](../../app/api/internal/workflow-schemas/route.ts) | Workflows discoverable, đủ import/validate/publish/mapping/test/run. | Diff/revisions, dependencies và running/waiting executions. Graph kéo thả là enhancement chưa bắt buộc. CFGADM-09/P9/ACUI-07; quyết định route Δ-DEV-03 hiện hữu giữ nguyên. |
| Docs/navigation/theme/login/logout — [ServiceTestClient](../../components/ServiceTestClient.tsx), [HeaderNav](../../components/HeaderNav.tsx) | API Docs/Test workbench + nav toàn app + light/dark + session lifecycle. | Same-origin session, global scope/time context, keyboard/320px, deep links; served spec lấy từ COMP, không fork OpenAPI. CFGADM-11/AWEB; AOPS-01/09. |

`api_secret_key` là key API/store cũ chưa tìm thấy control/runtime consumer trong khảo sát CFGADM; giữ mapping retire/migrate explicit, không tạo thêm mật khẩu Admin. Không sao chép hành vi đọc lại secret hoặc GET mutation không an toàn để đạt parity.

## 3. UI dành cho quản trị và ca trực

### Navigation và bố cục

Đây là **screen architecture**, không freeze URL/API mới. Đường route cụ thể đi qua AWEB rollout/allow-list; Workflows route riêng hay Business tab vẫn theo Δ-DEV-03, nhưng tác vụ phải tìm được từ navigation.

| Nhóm sidebar | Màn hình | Câu hỏi người quản trị cần giải quyết |
|---|---|---|
| Điều hành | Overview; Services; Workers & Queues; Operations; Incidents | Hệ thống đang phục vụ được không; kẹt ở đâu; ai xử lý; hành động tiếp theo? |
| Cấu hình dịch vụ | Businesses; Workflows; Profiles; Connectors & Accounts | Phiên bản nào đang chạy; dependency nào ảnh hưởng; đổi cấu hình thế nào? |
| Truy cập và bảo mật | API Keys; Identity; Security; Audit | Ai được làm gì; credential nào đang dùng; ai vừa thay đổi? |
| Dữ liệu và chi phí | Usage & Cost; Storage & Maintenance | Tốn bao nhiêu; còn bao nhiêu; lưu/xóa/khôi phục dữ liệu thế nào? |
| Hệ thống và hỗ trợ | Settings; Deployments; API Docs/Test workbench; System information | Desired/effective có lệch không; test và rollback ra sao? |

- Sidebar cố định/collapse trên desktop, drawer keyboard-safe trên mobile; breadcrumb/list → detail → back giữ filter/cursor. Thanh context chứa environment, tenant scope được server cấp, khoảng thời gian/timezone, refresh/auto-refresh và thời điểm dữ liệu cập nhật. Environment selector chỉ cho môi trường đã cấu hình quyền, không tùy ý nhập service URL.
- Overview ưu tiên sự cố ảnh hưởng phục vụ, queue bị kẹt, UNKNOWN, pending HITL/deadline và budget; session/audit không chiếm vị trí chính. KPI có link tới đúng tập dữ liệu lọc, phân biệt current gauge với count trong time window.
- List dùng tìm kiếm server-side, filter chips, presets có giới hạn, sort/cursor và column priority. Detail có summary/status/action ở đầu, tabs riêng cho timeline, dependencies, config diff, logs/audit, usage/artifacts; mở nội dung nặng khi cần. Không dồn mọi config vào một trang form dài.
- Secret control Keep/Replace/Clear, phân biệt test draft, save draft, publish và applied; revision/state conflict giữ draft. Hiển thị ngôn ngữ nghiệp vụ; build/digest/mount/auth wiring nằm trong diagnostics theo quyền.
- Auto-refresh có pause; không reset draft, focus, selection hoặc vị trí bảng. Telemetry lỗi/quá hạn hiện stale/unavailable cùng last successful sample; không đổi thành healthy/0. Tín hiệu khác thời điểm không được giả là snapshot đồng bộ.

### Screen spec tối thiểu cho service operations

| Màn | Thông tin/action bắt buộc | Phân biệt cần giữ |
|---|---|---|
| Services | Orchestrator, Connector, từng business worker và dependencies PG/Redis/S3/Vault; replica/version/digest, live/ready/heartbeat, last seen, active work, latency/errors, desired/observed revision; dependency drilldown và maintenance/rollout status. | Process live ≠ ready ≠ provider auth thành công; HTTP 200 + queueIntegrity SUSPECT vẫn degraded. Replica inventory lấy từ deployment/runtime, không dựng replica từ một health endpoint. |
| Workers & Queues | Queue/business/version, worker tương thích online/draining/offline, concurrency configured/observed, active leases, waiting/delayed/active/failed, oldest runnable age, throughput, retry/stalled; outbox/webhook/usage backlog riêng. | Waiting input/children khác runnable waiting; queue job failure khác operation failure; tenant chỉ thấy projection thuộc scope, không raw shared queue payload. |
| Incidents | Alert severity/first seen/last seen/source/scope, affected service/operation, owner, acknowledge/resolve, timeline, runbook và threshold revision. | Acknowledge không resolve; metric hồi phục + backlog/ledger đối soát mới resolve. Maintenance suppression có scope/TTL/reason và audit, không xóa alert history. |
| Connectors | Credential configured/revision/test status, quota/in-flight, 429/auth/timeout, latency, UNKNOWN, bindings và provider request refs đã redacted. | Không test mọi provider bằng polling health; controlled test có quota/audit. UNKNOWN cần evidence reconciliation, không retry mù. |
| Deployments | Desired/applied theo replica, pending changes/diff, impact/dependencies, validate→stage→rollout→health→rollback và job history. | Không lấy catalog env tĩnh làm observed state; apply partial/outage/restart phải nhìn thấy. |
| Maintenance | Retention/cache cleanup, orphan/storage reconciliation, stalled leases, failed outbox/webhook delivery, backup/restore drill status; dry-run→confirm→job→item results. | Không xóa active/referenced/pinned data, không purge Redis/S3 trực tiếp từ browser, không dùng TTL để xác nhận provider không chạy. |

## 4. Backend ownership và thao tác điều hành

Luồng chuẩn: **Admin session → BFF principal/tenant + CSRF → owner service → DB/outbox/runtime/deployment adapter → status projection → UI/audit**. Orchestrator quản lý control plane; Connector giữ provider/quota/invocation/credential ledger; runtime/SDK giữ claim/lease; deployment adapter giữ process rollout. UI không trực tiếp gọi Vault/Redis/PG/provider hoặc chạy shell.

Telemetry contract AOPS-00 cần entity/scope/source, sample time, collection status, observed version/revision, state và bounded drilldown reference; schema runtime-validated và browser-safe. Platform health aggregate được phép cho platform admin; tenant operator xem tín hiệu ảnh hưởng tenant mình, không thấy danh tính/payload tenant khác. Metric labels hữu hạn theo P8-07; operation/task/invocation IDs dùng drilldown, không làm metric labels.

| Action | Quyền và precondition | Kết quả bền vững / điều kiện an toàn |
|---|---|---|
| Cancel / HITL resume | Operator chỉ trên operation được cấp; viewer read-only; state version và deadline hợp lệ. | Reuse runtime lifecycle; cancel-requested khác cancelled; stale resume 409/no-write, audit actor thật. |
| Pause admission / drain worker / resume | Platform admin hoặc grant vận hành explicit; impact preview, bounded target/scope. Shared queue pause là platform-only. | Desired command và observed ack theo replica; in-flight giữ lease, không mất checkpoint. Drain khác terminate/cancel; resume không nhân đôi dispatch. |
| Retry failed delivery/task | Capability và safe replay policy từ owner; CAS/idempotency, target IDs và maximum batch. | Chỉ outcome cho phép retry; giữ operation pin. UNKNOWN không retry; webhook replay không chạy lại business hoặc cộng usage. |
| Reconcile UNKNOWN | Grant explicit, invocation state/version và evidence từ owner Connector/provider. | Resolve bằng ledger/evidence có reason; không suy thành FAILED từ timeout hoặc cho người dùng bấm “success” tùy ý. Chưa có adapter thì capability chưa đạt acceptance. |
| Cleanup / apply / rollout / rollback | Admin theo scope, preview target/count/impact, dependency check và confirm; chưa có adapter phải ghi gap. | Maintenance command/job ID bền vững, retry idempotent, per-item result/partial failure/cancel khi an toàn; restart không mất trạng thái. Rollback config không tự hủy operations đang pin revision cũ. |

Command DTO cần target/scope, expectedRevision/state version, idempotency key, reason, actor và job/status reference theo owner. Audit ghi intent/result/partial failure an toàn; không raw secret/payload. API ownership/URL mới freeze trước code; reuse handlers/services hiện có, không viết một engine queue/recovery thứ hai trong BFF. Tenant role `operator` không tự có quyền platform restart/drain; legacy assigned USER giữ contract LOCAL/CFGADM-08.

## 5. Task register và thứ tự triển khai

Owner là **lane đề xuất**, coordinator hiện hành cấp named owner/lease trước implement. Các đường ghi dưới đây là write set dự kiến, không cấp quyền chiếm file đang có lease. Shared contracts, migrations, router/shell và OpenAPI tuần tự theo repo.

| ID / trạng thái | Parent / owner; dependency | Deliverable và acceptance cụ thể |
|---|---|---|
| AOPS-00 `[ ]` | ACUI-00/P8-07/ADM-UX-02; observability + runtime/Connector/contracts | Freeze entity/signal/action catalog theo §3/4 và gắn source/owner/scope/threshold/freshness/adapter. Mỗi metric có probe/event thật hoặc gap explicit; DTO/permissions/sample fixtures, không invent endpoint có sẵn. Threshold vận hành theo P0/P8-05; không hardcode SLO chưa duyệt. |
| AOPS-01 `[ ]` | AWEB-03/07, ADM-UX-01, CFGADM-11; UI integrator/component; AOPS-00 scope | `apps/admin-web/src/{app-shell,router,components/ui,styles}`: sidebar/context/breadcrumb/search/feedback, remove developer copy khỏi main flow; navigation mọi capability/role, 320px/keyboard/light-dark và direct URL. Workflow route decision hiện hữu không tự đóng. |
| AOPS-02 `[ ]` | CFGADM-10/COST/ADM-UX-03/04; projection + BFF/UI; AOPS-00/01 | Overview cockpit từ real projections; đủ metrics parity/timezone, service incidents/backlog/UNKNOWN/HITL/usage lag; từng KPI drilldown đúng query. So event/DB cùng time window, duplicates/late events không double-count; stale/outage không healthy/0. |
| AOPS-03 `[ ]` | ACUI-07/09/P2-09/P4/P8-07; registry/runtime/deployment + BFF/UI; AOPS-00/01 | Services inventory/detail và dependency view, heartbeat/freshness/version/desired-observed per replica; controlled drain/resume qua adapter. Hai replicas, replica mất heartbeat/restart/partial rollout phải hiện đúng; task đang chạy không lost/duplicate. |
| AOPS-04 `[ ]` | P2 queue/outbox/P4/P8-07/ADM-UX-02; runtime/queue + BFF/UI; AOPS-00/01 | Workers & Queues + delivery backlogs, compatibility/no-worker triage, lease/age/throughput; scoped pause/drain/retry theo §4. Test no matching worker, Redis outage/lost delivery, expired lease/stale completion, shared-queue role deny; DB state và queue không diverge silently. |
| AOPS-05 `[ ]` | CFGADM-10/ADM-UX-05/COMP lifecycle/ENC; Operations BFF/runtime/UI; AOPS-01 | Complete Admin operation list/detail/cancel/resume/delete/download, correlation links và pinned revisions. Reuse public lifecycle; cancel/provider race, stale HITL, retention/crypto, tenant fence và back navigation; replay chỉ sau safe contract. |
| AOPS-06 `[ ]` | CFGADM-07/ACUI-06/P3/VAULT/P8-07; Connector + BFF/UI; AOPS-00/01 và existing Connector wire | Connector ops panel + UNKNOWN reconciliation + Incidents linked runbook/owner/ack/resolve. Provider 429/auth/timeout/UNKNOWN fault thật; test draft khác active config, wrong revision/account deny; acknowledge/resolve/restart có state/audit thật. Reuse existing CRUD/import work, không implement lại CFGADM-07. |
| AOPS-07 `[ ]` | CFGADM-04/10/DATA/P2/P8-06/07; artifact/runtime/maintenance + BFF/UI; AOPS-00/01 | Maintenance jobs theo §4 cho cleanup/recovery/delivery reconciliation; preview→confirm→job→results, bounded batch/reference checks. Restart/partial failure/double-click/CAS/active reference negatives; restore drill status từ receipt/job thật. Không thao tác production cleanup/restore trong packet test. |
| AOPS-08 `[ ]` | CFGADM-01..04/ACUI-08/09/DEP/P8-06; config/deployment + UI; AOPS-00/01 | Complete legacy editable settings và deployments diff/test/apply/observed/rollback; không dừng ở static env table. Đổi S3 generation vẫn đọc old artifact, AI/prompt request cũ pin revision, new request dùng mới; rollout hai replica fail có rollback và trạng thái partial rõ. |
| AOPS-09 `[ ]` | AWEB-08/CFGADM-11/ACUI-10/ADM-UX-07/P8-07/08; Tester độc lập + docs + reviewers; các slices tương ứng | Verify journeys §6 trên mounted build/live namespaces; Antigravity UI_APPROVED đúng route/build, Claude APPROVED backend/acceptance theo repo. Update docs/19/28/35 qua shared-doc lease; không tick parent từ plan/static/source review. |

1. **Contract + parity implementation:** AOPS-00 khóa source/action/permission seams trong packet cụ thể; tiếp tục CFGADM đang chạy, ưu tiên Settings/Identity/lifecycle/Connector runtime-use gaps. Không khảo sát lại toàn repo hoặc chờ full inventory để triển khai slice độc lập đã freeze.
2. **Shell + read projections:** AOPS-01; AOPS-02/03/04 read side theo lease riêng. Fixture giúp review states; acceptance cần real BFF/service data.
3. **Safe mutations:** hoàn tất AOPS-05/06/07/08 sau contract tương ứng; test focused từng vertical slice, rồi independent live/browser. Services controls chỉ enable khi adapter/permission/audit đã có thật.
4. **AOPS-09 tổng hợp:** review đúng build và affected route, ghi remaining gaps theo từng parent. Không đợi parity xong mới bắt đầu read-side service cockpit; chưa đủ live/evidence giữ acceptance mở.

## 6. Hành trình nghiệm thu và tiêu chí UI

| Journey | Kịch bản và bằng chứng bắt buộc |
|---|---|
| AOPS-J01 — thiết lập đủ như legacy | Local/OIDC login đúng mode → user/grants/key → AI/prompt/S3 → Connector import/test/activate → Profile endpoints/locks/steps/session/prompts → six-action Test Endpoint → result/download/usage → revoke; save/reload/restart/provider observed request và audit. Reuse CFGADM/COMP fixture IDs, không nhân đôi golden suite. |
| AOPS-J02 — vận hành bình thường | Overview phát hiện queue age → queue/no matching worker → service/version → drain/resume hoặc enable matching version theo quyền → operation timeline/result. Khởi đầu từ Overview, tới đối tượng lỗi trong tối đa 3 lần điều hướng; no lost/duplicate effects trên hai replicas. |
| AOPS-J03 — sự cố provider | Inject 429/auth/timeout/UNKNOWN → alert → Connector/invocation → assign/ack/runbook → bounded reconciliation theo evidence → resolve. UNKNOWN không có retry mù; dedup usage, audit và correct terminal outcome. |
| AOPS-J04 — triển khai cấu hình | Edit/diff/test/stage → rollout hai replicas → simulated failed apply → observed partial → rollback; read-after-write + acknowledgements đúng revision; old operation/HITL tiếp tục dùng pin cũ. |
| AOPS-J05 — bảo trì | Preview retention/expired lease/failed webhook → scoped confirm → restart giữa job → reload status/results. Data đang dùng không bị xóa, callback không double, stale completion bị chặn; per-item errors có retry policy. |
| AOPS-J06 — workflow và quyền | Import JSON/XML → mapping/override/validate/publish → schemaSlug submit → HITL/resume/result; assigned USER chỉ tác vụ được cấp, viewer read-only, tenant A không đọc/ghi B, tenant operator không platform drain/restart. |
| AOPS-J07 — điều hành chi phí | Time range/timezone/profile/provider/model filters → operation → invocation/event; cost measured/estimated/pending/unknown, budget alert và bounded export; sửa giá không viết lại ledger gốc. |

UI acceptance dùng desktop 1440×900, tablet 768px và mobile 390px/320px: không cuộn ngang toàn trang; bảng có vùng cuộn có nhãn khi cần; critical status/action của màn ca trực nằm trong viewport đầu desktop; keyboard/focus và axe critical/serious = 0. Dữ liệu dài và ≥1.000 operations/keys đa tenant phải tìm/filter/page được bằng server query; thao tác chính không cần tìm trong raw JSON. Filter/time/scope/deep link/back/reload nhất quán; loading/empty/error/denied/stale/conflict/partial-failure có browser evidence. Sessions hết hạn và telemetry outage không báo success, không làm mất draft không chứa secret. Mục tiêu “tối ưu” cần review hành trình này, không chỉ screenshot đẹp.

Receipt cần task/journey/fixture IDs, build digest + dirty-tree scope, command/cwd/time, namespace PG/Redis/S3/Vault/provider, pass/fail/skip/exit/raw paths, side-effect checks, screenshots và independent verdict. Seed/fault injection trên môi trường test cô lập; không DB reset hoặc namespace shared destructive nếu chưa lease. UI verdict page-level lịch sử không thay các journeys mutation/live mới. Chỉ link evidence đã có; chưa có receipt ghi GAP và giữ `[ ]`/`[~]` theo parent.

## 7. Verification của lần bổ sung plan

Đã đọc source root và Admin Web, CFGADM/ACUI/AWEB/ADM-UX/COST/P8 cùng task index và audit repo. Chỉ xác nhận inventory/source và nhất quán tài liệu. Không chạy unit/e2e/browser/live, không dùng secret, không sửa production code hoặc trạng thái nghiệm thu. Cần thực hiện AOPS-09 trên từng implementation/build trước khi kết luận Admin mới đầy đủ và ưu việt hơn hệ thống cũ.
