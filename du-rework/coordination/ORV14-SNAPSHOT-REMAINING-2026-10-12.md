# ORV14 — bản tạm trên Git và các phần còn lại

Ngày: 2026-10-12. Phạm vi: `du-rework`, theo [plan triển khai](ORV14-FULL-ADMIN-EXECUTION-2026-10-11.md) và yêu cầu người dùng chốt nhanh một bản commit/push toàn bộ code, tài liệu trước khi tiếp tục.

Branch đích: **`codex/fix-workflow-builder`**, remote **`https://github.com/OrgGem/dugate.git`**. Đây là snapshot công việc đang triển khai, không phải bản đã nghiệm thu hoặc sẵn sàng chuyển production. Commit/push được người dùng yêu cầu trực tiếp trong lượt này; các hạn chế commit ở snapshot lịch sử không chặn yêu cầu mới.

## Phần chưa hoàn thiện

| Nhóm | Đã code / kiểm chứng theo phạm vi | Phần còn lại và bước tiếp theo | Nghiệm thu toàn nhóm |
| --- | --- | --- | --- |
| Deploy/rollback HA trên Docker Compose | Có adapter rollout, runtime identity/boot ACK, drain và journal; kiểm thử PG về claim/handoff và migration Connector 016 đã pass theo phạm vi. | **Chưa triển khai bộ Compose hai slot blue/green và ingress/runbook tương ứng.** Hiện topology cơ sở vẫn là một replica cho mỗi service. Hoàn thiện packet `ORV14-COMPOSE-HA-PACKAGING-01`, sau đó chứng minh cutover, drain, restart, rollback và Worker lease trên topology thật. | Chưa accept. |
| Build Admin và ranh giới web/Host | Có context Host độc lập, bỏ privileged maintenance runner khỏi web, giữ retention enqueue; preview và manifest readers được tách sang module thuần. Consumer `create-app.ts` đã sửa import, owner Orchestrator no-emit pass lúc 05:09:33Z trên Node 24.21 / TS 5.9; đây là owner check, không phải independent acceptance. | Hai lần build Vite a55/a56 còn lỗi import `ConnectorRecipeSchema` từ CommonJS contracts. Cấu hình `commonjsOptions.include` mới **chưa chạy lại build production**. Cần build bundle bình thường và kiểm tra browser boot trên source cuối. | Chưa accept. |
| Workflow, core API và provider consumers | Có nhiều test độc lập theo phạm vi cho legacy document, JSON/XML, HITL, AI defaults và TLS. Public operation giữ GET theo ID và download; thao tác quản trị về internal. | **Luồng Worker workflow vẫn còn ca thất bại chưa chốt nguyên nhân**: attempt 29 có grant hợp lệ nhưng operation FAILED trước Connector/provider/cost. Attempt 30 dừng ở fixture boot ACK trước khi chạy test body; fixture đã sửa, attempt 31 **chưa chạy**. Cần chạy WFA15 đã sửa, Core31 bị ảnh hưởng và các ca còn lại; kiểm chứng riêng Prompt Wizard/Test Endpoint với cả OpenAI và Gemini. | Chưa accept toàn bộ spec API trên bản hiện tại. |
| Migration và chuyển hẳn DB cũ sang bản mới | Có backfill/mapping/migration, identity reset và settings dispositions; đã có kiểm thử PG theo phạm vi. | **Chưa có rehearsal đầy đủ trên bản source cuối** cho Native19/A2: import/preflight/apply/replay/journal/readback, rồi tắt nguồn cũ và kiểm tra login, API keys, lịch sử operation, download, số lượng/hash dữ liệu. Đây là chuyển dữ liệu một lần rồi cutover, không yêu cầu đồng bộ liên tục hai hệ thống. | Chưa accept toàn bộ migration/cutover. |
| Backup/restore và Host executor | Đã code trusted adapter, crypto/generation readers, effect fences và probe; có test scoped về claim PG và Connector. | **Chưa chứng minh backup/restore mã hóa hai DB đầy đủ qua Host thật**, tất cả runtime fences, key families, artifact versions/sidecars và source-off recovery. Capability probe mới pass identity/mount/caps/netns; `nft --check` với rule reject thất bại, chưa áp dụng rule. Cần giải quyết executor isolation và chạy luồng thật; standalone Host factory/boot/close chưa có acceptance đầy đủ. | Chưa accept. |
| Admin UX, vận hành và chi phí | Đã bổ sung retry cùng request/key, tenant isolation và guided overrides; owner no-emit và 7/7 focused checks pass. Cost UI độc lập a54 pass accessibility, keyboard, overflow ở 8 tổ hợp viewport/theme. | **Chưa chạy đầy đủ CFGADM/AOPS/J01..07 trên bundle cuối**, bao gồm lost-response retry tạo đúng một operation/provider/reservation, tenant switch chậm, settings test/apply/rollback, profile locks/reset, connector lifecycle/credentials, identity/session revoke, operations query/detail/results, incidents recovery CAS, durable maintenance UNKNOWN, usage/export và budget toàn phạm vi. Cần independent UI review lại các bản sửa; verdict prefinal hiện là CHANGES_REQUIRED. | Chưa accept full Admin. |
| Tài liệu nghiệm thu | Có các owner/verifier reports và raw receipts, giữ nguyên các kết quả RED/PARTIAL và giới hạn của từng PASS. | Sau khi các luồng trên xanh, hợp nhất traceability/test inventory/acceptance baseline (`docs/19`, `docs/28`, `docs/35`) và final review đúng source/build. Không dùng scoped PASS hoặc test exit 0 để đánh dấu toàn plan hoàn tất. | Chưa có final acceptance. |

## Snapshot và trạng thái thực thi

- Các owner/verifier đã xác nhận freeze; không tiếp tục tính năng, chạy test dài hoặc tạo tài nguyên trong lúc chốt Git. Chỉ Backend được giao consumer import cleanup/no-emit ngắn và làm sole Git executor; Host đã hoàn tất shared pure readers và freeze lại.
- Snapshot bao gồm code, tests, migration, cấu hình mẫu, plan, tài liệu và evidence đã làm sạch trong working tree; không force-add các file vốn được ignore.
- Giữ cục bộ, **không đưa lên Git** archive runtime riêng tư `coordination/reports/raw/orv14-verification/private-admin-finance-a44/trace.zip`, vì có session/network trace. Đây không phải source hoặc tài liệu chức năng.
- Executor kiểm tra branch/remote, scan credentials trong các file sắp stage, commit Conventional Commit, push rõ `origin HEAD:refs/heads/codex/fix-workflow-builder` và đối chiếu SHA remote. Không force-push hoặc reset/stash code dùng chung.
- Receipt Git đặt ngoài worktree; SHA commit/push được báo ở handoff sau khi lệnh hoàn tất, không ghi một SHA dự đoán vào tài liệu này.
- Production deployment, migration và cutover: **NOT_PERFORMED**. Scheduler runtime: **UNVERIFIED**. Không thay parent checkbox/release gate từ snapshot này.

## Thứ tự tiếp tục để hoàn thành nhanh

1. Chốt build production Admin và lỗi workflow Worker đang đỏ trước khi thêm test hoặc tính năng mới.
2. Hoàn thiện package Compose hai slot và chứng minh Host backup/restore/rollout trên môi trường cô lập.
3. Chạy migration source-off rehearsal và các luồng API/Admin còn thiếu trên một bản source/build đã cố định; chỉ chạy lại phạm vi bị ảnh hưởng khi có thay đổi.
4. Independent review và hợp nhất tài liệu nghiệm thu; chỉ đóng toàn plan khi đủ bằng chứng thực tế.

Đây là danh sách thiếu sót của phạm vi ORV14 hiện tại dựa trên source handoff và receipt mới nhất, không phải một cuộc audit mới toàn bộ backlog lịch sử của repository.
