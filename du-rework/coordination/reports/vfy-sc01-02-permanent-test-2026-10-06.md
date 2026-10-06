# F-VFYSC1-02 — Permanent regression test cho SC-04-M02 (BFF secrets method dispatch)

- Task: F-VFYSC1-02 (carry-forward LOW từ Claude audit r4 §10.6/§10.7; coordinator dispatch 2026-10-06)
- Owner: OpenCode 3 (`oc_3` / `term_8a432ae3-63b7-41fd-929e-0797860c7426`)
- CWD: `D:\Git\dugate\du-rework`; HEAD hiện tại `4308cc5` (commit của lane khác — thay đổi packet này vẫn uncommitted)
- Constraints honored: **không commit, không push**; packet này chỉ **thêm mới một test file**, không sửa source
- Status: **IMPLEMENTED + offline-verified**; chưa có independent VFY/Claude review cho riêng packet test này. Không tick.

## 0. TL;DR

- Fix SC-04-M02 (`secrets.ts` SHA `E843A771…`, đã được oc_2 recheck xác nhận §10.6) trước đây chỉ có probe transient; nay có **test vĩnh viễn** `services/orchestrator/tests/bff-secrets-method-dispatch.test.ts`.
- Suite phủ đúng 4 nhóm được yêu cầu: list GET, create POST + tenant scope, 405 cho PUT/DELETE/PATCH không gọi upstream, method gating cho `rotate/disable/test` (POST-only + validation).
- Kết quả: **13/13 ×3, exit 0**; cụm BFF regression **9 suites / 141 tests, exit 0**; `git diff --check` exit 0. Không sửa dòng source nào (secrets.ts hash không đổi).

## 1. Bối cảnh

- Audit r4 §10.6: fix dispatch (`list+GET→list`, `list+POST→create`, còn lại 405) đã được oc_2 xác nhận độc lập; **permanent test vẫn thiếu** → F-VFYSC1-02.
- §11.2: upstream `/api/v1/admin/secrets*` (SC-04-M01) được **descope** sang phase sau → test này kiểm chứng đúng phần BFF dispatch với upstream injectable (`runtime.fetchImpl`), không phụ thuộc backend thật.
- Test cũ `tests/admin-shell-router.test.ts` không phủ `/admin/api/secrets` (grep 0 hit) nên lỗ hổng regression là thật.

## 2. Deliverable: `services/orchestrator/tests/bff-secrets-method-dispatch.test.ts` (new)

Offline by construction: mock `resolveBffContext` (platform-admin + CSRF ok), `runtime.fetchImpl` capture request, không network/DB/Redis.

| # | Case | Pin |
|---|---|---|
| 1 | `GET /secrets` | upstream `GET /api/v1/admin/secrets`; query allowlist (`limit/cursor/state`) + `tenantId` scope; param ngoài allowlist (`evil`) không tới upstream; không body |
| 2 | `POST /secrets` | **không 405**; upstream `POST /api/v1/admin/secrets`; body có `tenantId` = session scope, `provider.kind=managed_value`, literal write-only; `Idempotency-Key` forward |
| 2b | `POST /secrets` body `tenantId` khác scope | 422 `INVALID_SCHEMA`, **0 upstream call** (tenant fence) |
| 3 | `PUT/DELETE/PATCH /secrets` | 405 `METHOD_NOT_ALLOWED`, 0 upstream call, `resolveBffContext` **không được gọi** (method gate trước auth) |
| 4a | `POST /secrets/:id/rotate` | body hợp lệ → upstream `POST .../{id}/rotate`, `secretId` + `expectedRevision` đúng |
| 4b | `POST /secrets/:id/disable` | body hợp lệ → upstream `POST .../{id}/disable`, `reason` đúng |
| 4c | `POST /secrets/:id/test` | upstream `POST .../{id}/test`, body `{}` |
| 4d | `GET /secrets/:id/{rotate,disable,test}` | 405, 0 upstream call, không resolve context |
| 4e | `POST /secrets/:id/rotate` body sai | 422 `INVALID_SCHEMA`, 0 upstream call |

## 3. File + hash

| File | SHA-256 |
|---|---|
| `services/orchestrator/tests/bff-secrets-method-dispatch.test.ts` (new) | `54F13F72C004873990F55877285576B0D3C85775776C9D3E650BADC63BA54344` |
| `services/orchestrator/src/app/admin/bff/secrets.ts` (không sửa trong packet này) | `E843A77165F4725EF1A489320F95E996D4A6D86037CDEC5D341B8AD30D42801D` (khớp hash oc_2 audit §10.6) |

## 4. Evidence (offline; literal)

| Command (cwd `services/orchestrator`) | Kết quả |
|---|---|
| `npx jest tests/bff-secrets-method-dispatch.test.ts --runInBand` ×3 | mỗi lần **1 suite / 13 tests passed**, exit **0** |
| `npx jest tests/bff-secrets-method-dispatch.test.ts tests/admin-shell-router.test.ts tests/bff-settings-identity.test.ts tests/bff-connectors-actions.test.ts tests/aweb02-bff-foundation.test.ts tests/aweb04-bff-profiles.test.ts tests/aweb05-bff-reads.test.ts tests/aweb06-bff-operations.test.ts tests/aweb07-bff-security.test.ts --runInBand --silent` | **9 suites / 141 tests passed**, exit **0** |
| `git diff --check -- services/orchestrator/tests/bff-secrets-method-dispatch.test.ts` | exit **0** |

Ghi chú môi trường: log warning `admin web mount enabled but bundle is missing` / `settings read did not match the settings DTO` là các warning có sẵn của suite khác trong cụm, không phải failure.

## 5. Acceptance mapping

| Yêu cầu dispatch | Trạng thái |
|---|---|
| 1) GET /secrets → upstream list | PASS (case 1) |
| 2) POST /secrets → upstream create scope body | PASS (case 2 + tenant fence 2b) |
| 3) PUT/DELETE/PATCH → 405, không gọi upstream | PASS (case 3) |
| 4) POST rotate/disable/test → method gating tương ứng | PASS (case 4a-4e) |
| Chạy suite, xác nhận exit 0 | PASS (×3 + regression cụm BFF) |

## 6. Notes / open items

- Không sửa `secrets.ts`; fix đang ở trạng thái oc_2 đã verify (hash khớp). Test này là regression guard vĩnh viễn cho đúng hành vi đó.
- Upstream catalog backend (SC-04-M01) vẫn descope (§11.2): khi backend land, bổ sung test integration riêng; suite này chủ đích chỉ chốt dispatch + tenant fence + method gating.
- F-VFYSC1-02 (LOW) theo §10.7 nay có bằng chứng test vĩnh viễn; việc đóng/acceptance thuộc coordinator + reviewer.
- Không commit/push; không tick task/gate.
