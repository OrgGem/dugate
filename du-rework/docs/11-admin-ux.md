# Admin UX và cấu hình động

## Navigation v1

Overview; Businesses; Profiles; API Keys; Connectors; Operations; Usage; Audit. Không cần visual workflow designer để đạt mục tiêu plugin business.

| Screen | Nội dung | User actions | Empty/error states |
|---|---|---|---|
| Businesses | ID/version/digest/status/health/actions | Enable, drain, retire, inspect schema | Registered nhưng offline; unsupported contract |
| Profile editor | Business/version/action, parameters, locks, prompt, slots, limits | Publish revision; xem diff | Missing connector slot; retired version; stale edit |
| Connectors | Adapter, capability, endpoint redacted, state | Create revision, rotate secret, test, disable | Provider unavailable; credential invalid; quota exhausted |
| API Keys | Prefix, profile, status | Create/copy-once/revoke | Secret không được show lại |
| Operations | State, progress, business/version, duration | Filter, result, cancel, resume, replay | Waiting input; queued offline; unknown provider outcome |
| Operation detail | Steps/checkpoints, artifacts, invocation refs, usage | Download, human input, inspect error | Artifact expired; stale resume; pending usage |
| Usage | Measured/estimated/pending, client/business/provider | Filter/export bounded | Corrections hiển thị riêng |

## Dynamic profile form

UI đọc manifest schema từ Registry API. Widgets hữu hạn: input, textarea, number, checkbox, enum select, array editor, nested group, JSON editor. Unknown widget rơi về validated JSON editor; unsupported schema có message rõ, không render silently sai.

Locked parameter phải được enforce cả server, không chỉ disabled input. Default → profile override → allowed caller value; profile locked values thắng. Required business guard không editable nếu manifest không cho.

Connector binding chọn theo capability metadata. UI không cho nhập raw provider URL trong business form. Publish profile kiểm tra server-side revision tồn tại/enabled và required slots. Form phải giữ draft khi publish conflict; không overwrite revision mới vô tình.

## Human input

Render theo runtime-provided wait inputSchema/uiSchema, display waitId/stateVersion và context artifact được phép. Submit expectedStateVersion; duplicate click/reload không tạo continuation thứ hai. Chỉ action capability resume và actor được cấp quyền thấy nút.

## Verification

Browser tests cho registration→profile→operation; ảnh màn hình ở normal/empty/error/waiting states, desktop và mobile. Test keyboard/focus/labels, loading/disabled controls, secret masking, backend enforcement. Không tạo custom UI branch cho example-review để làm test extension pass.
