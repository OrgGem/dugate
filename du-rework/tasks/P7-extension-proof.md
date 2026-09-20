# P7 — Chứng minh thêm business không đổi platform

Owner: independent business agent + integration reviewer. Depends: P5/P6 G4. Write: `businesses/example-review/`, extension tests và deployment overlay trong infra. **Không sửa Orchestrator/Connector source** trong packet proof; contract gap phải báo và quay về owner thay vì âm thầm patch.

## Business mẫu

`example-review/review`: nhận 1..10 artifact, chuẩn bị từng tài liệu, gọi reasoning slot nếu profile bật, chạy children song song có giới hạn, join kết quả, tùy `requireApproval` chờ human input, trả `{approved, reviewsRef}`. Đây là business kỹ thuật chứng minh extension, không phải nghiệp vụ giải ngân production.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P7-01 | [ ] BRD, manifest/input/output/profile/resume schema, function/test design | G4 | Chỉ public shared packages; không platform internals |
| P7-02 | [ ] Worker implementation/image độc lập, local unit/SDK contract tests | P7-01 | Build chỉ với documented SDK contracts |
| P7-03 | [ ] Freeze platform digests, provision identity/ACL, register worker | P7-02 | EXT-01 manifest mới hiện trên registry mà không rebuild |
| P7-04 | [ ] Assign profile bằng generic Admin, submit qua generic API | P7-03 | UI-01 không custom business UI branch |
| P7-05 | [ ] Fanout/HITL/cancel/restart + duplicate resume proof | P7-04 | RUN-05..07, concurrency=1 vẫn tiến triển |
| P7-06 | [ ] v1/v2 concurrent versions, drain và rollback profile | P7-05 | VER-01, v1 human waits resume được |
| P7-07 | [ ] Extension developer guide và immutable-digest evidence | P7-06 | G5, thêm business chỉ worker+config+registration |

## Acceptance evidence bắt buộc

Trước/sau image digest Orchestrator/Connector; git diff chỉ worker/infra test config; registry/profile screenshots; operation results; queue/version routing; actual old-version continuation. Một test thất bại do thiếu platform capability là finding, không được claim goal đạt bằng sửa platform trong cùng proof.

## Developer onboarding guide

Hướng dẫn tạo BRD, manifest, handlers, tests, package/image, provision identity, register disabled, enable/profile bind, smoke test, drain/retire. Mô tả các giới hạn: schema widgets hữu hạn, adapter protocol hữu hạn, không cross-business arbitrary DAG, provider UNKNOWN semantics.
