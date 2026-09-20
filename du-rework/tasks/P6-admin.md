# P6 — Admin quản trị business/profile/connector/operation

Owner: UI agent. Depends: P2/P3 API contracts và implemented endpoints; có thể chuẩn bị UI fixtures sau G1. Write: `services/orchestrator/src/app/` UI, UI components và browser tests; không sửa runtime module khi chưa coordinate platform owner.

Read: docs 05–08, 11, 13. Sequence: UX states → view models/interfaces → form functions → browser cases → implementation.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P6-01 | [ ] Navigation/layout/auth guards/view model interfaces và screen state fixtures | P2-02 | Admin/operator/viewer views, loading/empty/error |
| P6-02 | [ ] Business registry/version/health UI | P6-01 | Enable/drain/retire state khác heartbeat |
| P6-03 | [ ] Dynamic schema profile editor, slots/prompts/locks/revisions | P6-02; P3 capabilities | UI-01, PRF-01..03; unknown widgets validated fallback |
| P6-04 | [ ] Connector config revision, secret rotation, test result UI | P6-01; P3 management | UI-02 secret write-only, test action explicit |
| P6-05 | [ ] API key create/copy-once/revoke và assignment | P6-03 | Raw key không đọc lại, audit visible |
| P6-06 | [ ] Operation detail/result/artifacts/cancel/resume/replay | P6-01; P2-06/08 | Waiting input schema form, stale CAS conflict giữ input |
| P6-07 | [ ] Usage/audit/operational overview + browser/accessibility verification | P6-02..06 | G4 UI, desktop/mobile screenshots |

## Functions

buildProfileFormModel, validateProfileDraft, mapSchemaToWidget, diffRevision, formatOperationView, renderHumanWaitForm. Pure view functions không quyết định authorization cuối; server enforce. Không hardcode document-core actions hoặc example-review fields trong form.

## Test evidence

Business chưa có worker, profile thiếu slot, publish stale revision, connector unavailable, invalid credential, empty history, wait input validation, terminal operation, usage pending và artifact expired. Screenshot artifacts chứa synthetic data, không secret.
