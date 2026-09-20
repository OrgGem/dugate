# Manifest và protocol đăng ký business

## BusinessManifest v1

Các field dưới đây là contract dự kiến, phải chuyển thành runtime JSON Schema ở P1.

| Field | Type | Quy tắc |
|---|---|---|
| contractVersion | string | `1`; unsupported major bị từ chối |
| businessId | string | Stable lowercase slug, thuộc publisher identity |
| version | string | Exact semver, immutable |
| displayName / description | string | Plain text, escape khi render |
| actions | ActionManifest[] | Ít nhất một; action name unique |
| capabilities | object | cancel/resume/parallel boolean |
| runtime | object | Required SDK/wire range, handler kinds |
| imageDigest | string | Image được deploy; khai báo provenance |

ActionManifest: `name`, `displayName`, `inputSchema`, `outputSchema`, `profileSchema`, `uiSchema`, `connectorSlots`, `artifactPolicy`, `capabilities`, `defaultLimits`.

ConnectorSlot: `name`, `required`, `acceptedCapabilities`, `allowedModelOptions`, `promptConfigSchema`. Business dùng tên logical như `ocr`, `reasoning`; deployment profile ánh xạ sang connector revision thật. Không nhúng endpoint/secret vào manifest.

Input/output dùng JSON Schema draft 2020-12; v1 giới hạn schema size/depth và không resolve `$ref` qua mạng. UI v1 hỗ trợ object, string, enum, number/integer, boolean, array và nested object đơn giản. Schema hợp lệ nhưng widget chưa hỗ trợ hiển thị JSON editor có validation. Không thực thi JS/HTML từ manifest.

```json
{
  "contractVersion": "1",
  "businessId": "example-review",
  "version": "1.0.0",
  "displayName": "Example Review",
  "imageDigest": "sha256:placeholder",
  "runtime": { "wireVersion": "1", "handlerKinds": ["root", "review-item"] },
  "capabilities": { "cancel": true, "resume": true, "parallel": true },
  "actions": [{
    "name": "review",
    "displayName": "Review documents",
    "inputSchema": { "type": "object", "properties": { "requireApproval": { "type": "boolean" } }, "additionalProperties": false },
    "outputSchema": { "type": "object", "properties": { "approved": { "type": "boolean" } }, "required": ["approved"] },
    "profileSchema": { "type": "object", "properties": {} },
    "uiSchema": {},
    "connectorSlots": [],
    "artifactPolicy": { "minFiles": 1, "maxFiles": 10 },
    "capabilities": { "cancel": true, "resume": true },
    "defaultLimits": { "maxParallelTasks": 2 }
  }]
}
```

Ví dụ chỉ minh họa contract; digest/schema business thật phải qua validation và contract tests.

## Registration lifecycle

1. Provision publisher/worker identity giới hạn business ID. Không cho worker tự mint quyền đăng ký business bất kỳ.
2. Publisher hoặc startup command PUT manifest đến Orchestrator.
3. Runtime canonicalize+hash manifest. Cùng version+cùng hash → 200 replay; cùng version+khác hash → 409.
4. Orchestrator tạo REGISTERED_DISABLED và cấp queue chính xác `du-business-{businessId}-{version}`. Queue name do platform sinh; không nhận arbitrary queue từ client/manifest.
5. Admin enable; profile phải cấp business/version/action riêng. Manifest mới không tự cấp quyền.
6. Worker heartbeat và claim theo identity+image/version. Registration vẫn tồn tại khi heartbeat hết hạn.

Health = HEALTHY/DEGRADED/OFFLINE; business status = REGISTERED_DISABLED/ENABLED/DRAINING/RETIRED. DRAINING chặn submit mới, cho operation cũ chạy. RETIRED chỉ khi không còn operation/wait/resume phụ thuộc hoặc có quy trình xử lý rõ.

## Versioning

- Profile pin exact version, operation pin profile revision + manifest digest + prompt revisions + connector revisions.
- SDK tương thích wire v1 có thể chạy khác minor version. Breaking DTO phải tăng contract major và hỗ trợ rollout song song.
- Queue version riêng giữ worker cũ xử lý backlog. Không đẩy job v1 vào worker v2 vì chỉ cùng businessId.
- Rollback profile chỉ tác động request mới; không tự biến đổi checkpoint operation cũ.
- Disable connector khẩn cấp/revoke credential có hiệu lực dù snapshot pin cấu hình; không giữ credential bị thu hồi chỉ để replay.

## Điều kiện no-platform-code-change

Acceptance: build platform một lần → ghi image digests → deploy example-review → register → gán profile → execute/resume → digest platform giữ nguyên. Cho phép thêm config, identity, queue ACL và deployment worker; không sửa registry hardcoded, routes, platform package imports hoặc build platform.
