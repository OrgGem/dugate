# ORV15 — kết quả implementation và unit-first

Base: `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`. Branch: `codex/fix-workflow-builder`. Phạm vi theo [execution packet](ORV15-UNIT-FIRST-EXECUTION-2026-10-12.md), tiếp tục [plan ORV14](ORV14-FULL-ADMIN-EXECUTION-2026-10-11.md). Người dùng yêu cầu unit test trước, không cần build image.

## Code đã bổ sung/sửa

- Package Compose blue/green với literal image/release pins, cấu hình secret theo SHA, ingress public/private, selector và [deployment guide](../docs/55-compose-two-slot-deployment.md). Template giữ sentinel để buộc cấu hình image/secret thực tế trước khi chạy.
- Ingress chỉ mount thư mục cấu hình riêng, không thấy secret/control tree. Artifact grant của Worker dùng địa chỉ private reachable `http://du-availability-ingress:8080` và đúng runtime route, không dùng loopback của container khác.
- Selector lấy shared lock trước khi đọc cả hai slot, tránh đảo ngược cutover của service còn lại; HUP/INT/TERM kết thúc rõ ràng sau cleanup. Nginx khai báo body limit 64 MiB, tương thích legacy upload; ứng dụng tiếp tục áp giới hạn Admin 16 MiB.
- Docs/Workflow/Connector Admin dùng tenant-scoped attempt registry và cache upload theo đúng File/tenant/API key. Request đã ACCEPTED không bị phản hồi cũ thay thế, chỉ gỡ khi có terminal evidence đúng operation. Giữ body/key/upload IDs cho retry không chắc chắn.
- Bổ sung unit tests qua các interface thực tế và cập nhật fixture cũ theo contract hiện tại, không đổi API spec để làm test xanh. Migration và workflow backend không có source omission được chứng minh trong unit, nên không sửa source theo giả định.

## Bằng chứng kiểm thử

| Phạm vi | Kết quả cuối | Report |
| --- | --- | --- |
| Orchestrator: 15 suite offline được chọn, bao gồm public operation ID/download, admin actions/query, idempotency, admission/budget/reservation và prompt producers | 341/341 | [Primary](reports/orv15-verification.md) |
| Worker SDK connector session / Document Core mapping / contracts budget / Global AI caller | 67/67 · 9/9 · 7/7 · 2/2; các nhóm riêng, không cộng rerun | [Primary](reports/orv15-verification.md) |
| Migration: CJS adapter/import/replay/integrity; schema backfill; identity/readiness | 56/56 · 7/7 · 12/12 | [Migration](reports/orv15-migration-unit.md) |
| Workflow: SDK wire; Document Core → SDK → real Connector runtime → cost/typed adapter → provider mock, root và branch | 2/2 · 2/2 | [Workflow](reports/orv15-workflow.md) |
| Host: fence/UNKNOWN replay/generation-sidecar/context | 12/12 độc lập | [Host](reports/orv15-vfy-host.md) |
| HA final R1/R2 | 18/18 độc lập trong một lần chạy, gồm 13 ca owner và 5 ca verifier; pre/post hashes khớp | [HA verification](reports/orv15-vfy-ha.md), [owner](reports/orv15-ha-owner.md) |
| Admin retry/editor/export focused owner | 15/15 và Admin no-emit pass | [Admin owner](reports/orv15-admin-owner.md) |

No-emit Orchestrator/Worker SDK/Connector/Admin có receipt theo phạm vi. Private-output Vite bundle và read-only Compose config đều pass; không ghi đè shared dist. Không build/pull/run image hoặc khởi động container/service/provider thật. HA process tests dùng helper copy chỉ thay external paths/UID/command ports bằng stub và file tạm; không phải native/privileged proof. Các lượt RED và fixture corrections được giữ trong reports/raw, không cộng rerun thành số test mới.

## Review và phần còn mở

[Standards](reports/orv15-review-standards.md): **APPROVED_OFFLINE**, không có hard breach/actionable smell. [Spec](reports/orv15-review-spec.md): **APPROVED_OFFLINE** trên source cuối, sau khi giữ và giải quyết hai finding HIGH/MEDIUM về stale selector và upload ceiling. Đây là verdict cho phạm vi offline, không phải UI_APPROVED hoặc nghiệm thu toàn plan.

Vẫn cần kiểm chứng thực tế:

1. Workflow attempt29 thất bại lịch sử chưa có normalized Connector response/error để xác định nguyên nhân; unit root/branch xanh không giải thích được lần live đó.
2. Native19/A2 và rehearsal chuyển đầy đủ dữ liệu, tắt nguồn cũ, kiểm tra login/history/API keys/download/count/hash. Historical `secret_versions` RED chưa được đóng bằng native rehearsal.
3. Backup/restore mã hóa hai DB, executor/kernel isolation, sáu replica, active Worker leases, fixed ingress cutover/drain/restart/rollback. DNAT source visibility qua port host loopback 18081 vẫn chưa được đo trên container thật.
4. Browser boot và toàn bộ CFGADM/AOPS/journeys, real Prompt Wizard/Test Endpoint cho cả provider. Vite có cảnh báo externalized `node:crypto` và bundle size; compile pass không chứng minh browser behavior.

Tài liệu traceability/test inventory/acceptance baseline được cập nhật theo [docs receipt](reports/orv15-docs.md), không tick parent ACCEPTED/release gate. Production deployment/migration/cutover: **NOT_PERFORMED**. Scheduler: **UNVERIFIED**; không tạo timer.

Commit/push checkpoint do sole Git executor thực hiện trên đúng branch sau khi tất cả writer freeze. Archive runtime riêng tư `reports/raw/orv14-verification/private-admin-finance-a44/trace.zip` được giữ cục bộ và loại khỏi index. SHA/push proof được báo sau khi lệnh hoàn tất; receipt Git đặt ngoài worktree.
