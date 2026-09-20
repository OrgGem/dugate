# Reference mapping và compatibility policy

Repository cũ là read-only reference. Không copy `.env`, DB dumps, uploads, private document fixtures, generated worker.js hay node_modules. Không import `../../../../lib` từ implementation mới.

## Source pointers

| Reference | Tham khảo | Thiết kế mới |
|---|---|---|
| [registry](../../lib/endpoints/registry.ts) | Six actions, 28 subcases, workflow names | Business manifest/versioned schemas |
| [runner](../../lib/endpoints/runner.ts) | Public facade, multipart normalization | Thin adapter → generic submission |
| [profile resolver](../../lib/endpoints/profile-resolver.ts) | Defaults/locks | Separate ProfileRevision + key binding |
| [submit](../../lib/pipelines/submit.ts) | Async/sync/idempotency | Transactional operation+outbox |
| [pipeline engine](../../lib/pipelines/engine.ts) | Step chaining/session/usage | document-core + SDK/full checkpoint |
| [workflow engine](../../lib/pipelines/workflow-engine.ts) | Child tasks and human wait | Business-owned workflow + generic runtime persistence |
| [external processor](../../lib/pipelines/processors/external-api.ts) | Request/response mapping | Connector adapters; native parsing tách document-kit |
| [storage](../../lib/storage/index.ts) | Local/S3 adapter pattern | Object refs+scoped access, no cross-container local paths |
| [schema builder types](../../lib/workflow-builder/types.ts) | DSL/node families | Future schema-workflow business, no DSL interpreter in platform |

## Compatibility dispositions

| Feature | Release đầu | Release sau / ghi chú |
|---|---|---|
| Six `/api/v1/docs/*` action routes | Giữ path qua facade | Response canonical mới; legacy exact response có matrix riêng |
| JSON/multipart, single/multi/source/target files | Hỗ trợ input normalization | Exact accepted fields P0 inventory |
| sync=true | Bounded wait → 200/202 | Không blocking business execution tại API |
| Profile routing/locked parameters | Bắt buộc | Prompt policy mới minh bạch, không raw `_prompt` |
| Operations polling/cancel/resume | Canonical API | Legacy response fields chỉ thêm khi có consumer requirement |
| file_urls | Worker download theo allowlist và secret ref | Không mặc định chuyển arbitrary URLs đến provider |
| `/docs/workflows` disbursement/lc-checker/doc-compare | Không nằm trong document-core | Các business deployment riêng ở P9 |
| `/docs/workflows/schema`, workflow visual builder | Không thuộc release đầu | schema-workflow business + UI extension riêng nếu cần |
| Billing balance/usage legacy | Usage projection/Admin v1 | Public legacy billing endpoints P9 inventory |
| Data/credential migration | Không làm | Project mới độc lập; migration plan riêng |

Không tuyên bố drop-in replacement trước khi consumer compatibility matrix có fixture request/response thực tế được cấp quyền. Đầu ra lỗi/shape cũ cần characterization tests trước khi quyết định giữ hay sửa.

## Known issues cần tránh mang sang

Pipeline catch lỗi nhưng BullMQ không thấy failure; checkpoint dùng preview 500 ký tự; parent workflow giữ slot khi chờ child; DB create/enqueue không atomic; child+parent cộng phí; local paths giữa containers; runtime config đổi giữa các attempts. Test catalog có RUN/OPS/USE cases tương ứng.
