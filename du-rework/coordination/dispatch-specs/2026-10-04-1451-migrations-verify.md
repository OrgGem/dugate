# Dispatch spec — verify migrations 0026/0027 (read-only, scratch schema) (2026-10-04 14:51 +07)

## Mục tiêu

Xác minh độc lập hai migration Phase 1 của Claude (`0026_profile_policy.sql`, `0027_profile_active_pointer.sql`) ở tầng DB thật — không sửa source/test/plan; chỉ receipt + script tạm (xoá sau).

## Cách ly an toàn (bắt buộc)

- Dùng **schema scratch riêng** trong PG test (5433), vd `CREATE SCHEMA migv27_<rand> AUTHORIZATION ...; SET search_path` — **DROP SCHEMA ... CASCADE khi xong**, không chạm schema/DB mà lane khác dùng. Ghi log SQL đã chạy.
- Kiểm hash 2 file trước/sau lượt verify (đảm bảo không đổi giữa chừng — ghi vào receipt).

## Việc cần làm

1. **Schema introspection**: liệt kê bảng/cột/type/nullable/PK/FK/unique/checks do 0026+0027 tạo; đối chiếu plan Phần 3 Nhóm A: policy fields (`enabled`, `parameters` slots, `jobPriority`, `allowedFileExtensions` CSV, `file_url_auth_cipher` **text** dạng `iv:tag:ct` hex — không JSON envelope, `connections_override`), `connector_prompt_overrides` unique **key-4**: `(connection_id uuid, api_key_id uuid, endpoint_slug text, step_id text default '_default')`.
2. **Idempotency**: chạy lại từng file lần 2 → không lỗi, không nhân đôi constraint/index (so `pg_constraint`/`pg_indexes` trước-sau).
3. **T-DB-02 semantics**: seed 3 revision cho 1 profile → 0027 backfill pointer = **MAX(revision)=3**; kiểm cấu trúc pointer (append-only): insert pointer mới revision cũ hơn (rollback) → **không sửa row lịch sử**, pointer row mới được thêm.
4. **Negative nhẹ**: insert trùng key-4 → unique violation; insert `connection_id` non-uuid → type error (nếu cột uuid).
5. Ghi literal output + mọi deviation so plan (kèm `file:line` trong migration).

## Verdict

- `VERIFIED` / `CHANGES_REQUIRED` + finding `file:line`; nêu rõ phần không đo được.

## Deliverable

- Receipt: `coordination/reports/migrations-0026-0027-verify-2026-10-04.md`.

## Lane

- **cc_2** — `term_5f7e42da-6790-4449-8539-746626c5d078`. Dispatch 2026-10-04 14:51.
