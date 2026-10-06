# Self-review Notes for Codex — Profiles Tab Parity Plan (2026-10-04)

Đối tượng: plan `C:\Users\Gem\.claude\plans\typed-discovering-wall.md` (đã approve bởi user), chờ codex review agent sửa cuối cùng. File này chứa **6 mismatch/rủi ro tôi tự phát hiện khi đối chiếu legacy dugate cũ** + đề xuất sửa, để codex áp dụng vào plan.

## Tham chiếu legacy đã verify trực tiếp

- `D:\Git\dugate\lib\crypto.ts` — AES-256-GCM format: `iv(hex):tag(hex):ciphertext(hex)` (3 phần `:`-separated, hex); IV=12B, TAG=16B; key derive từ `ENCRYPTION_KEY` hoặc `NEXTAUTH_SECRET` bằng SHA-256 → 32-byte key.
- `D:\Git\dugate\app\api\internal\profile-endpoints\route.ts` (dòng 80–173):
  - GET enrich: `enabled: dbRecord?.enabled ?? true`, `jobPriority: dbRecord?.jobPriority ?? 'MEDIUM'`, `allowedFileExtensions: dbRecord?.allowedFileExtensions ?? null`.
  - POST: `VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH']` (hardcode inline); `fileUrlAuthConfig` chỉ encrypt khi truthy (`encrypt(JSON.stringify(value))`); `allowedFileExtensions` chỉ `trim()` (không validate list).
  - Non-admin POST: chỉ được sửa `parameters` + `connectionsOverride` nếu endpoint đang `enabled` (else 403); admin sửa full-field.
  - Upsert: `onConflictDoUpdate` target `(apiKeyId, endpointSlug)`.

## 6 mismatch/rủi ro + đề xuất sửa plan

1. **AES-GCM format (T-PROF-04, T-DB-01):** plan ghi envelope JSON `{alg,iv,ct,tag}` — legacy dùng string `iv:tag:ct` (hex). Sửa: `file_url_auth_cipher text` lưu đúng string `iv:tag:ct` (không JSON envelope); key derive từ `ENCRYPTION_KEY` hoặc `NEXTAUTH_SECRET` (SHA-256 → 32B); IV=12B hex, TAG=16B hex.
2. **`connector_prompt_overrides` key-4 (T-DB-01):** plan nói "unique key-4" nhưng chưa ghi type. Legacy `ExternalApiConnection.id` là uuid. Sửa: `connection_id uuid NOT NULL`, `api_key_id uuid`, `endpoint_slug text`, `step_id text default '_default'`; unique `(connection_id, api_key_id, endpoint_slug, step_id)`.
3. **`allowedFileExtensions` validation (T-PROF-02):** plan nói "validate CSV" — legacy chỉ `trim()`. Sửa: parse CSV = `trim()` + split + bỏ empty; **không validate mimetype list** (legacy không check).
4. **Bulk save behavior (T-UI-04):** legacy UI gọi `Promise.allSettled` per endpoint (mỗi endpoint 1 POST riêng), không all-or-nothing. Plan đã đúng per-row; chỉ cần ghi rõ: "partial-failure report per-row, không rollback chung".
5. **Test Endpoint route name (T-UI-06):** plan nói "route test mới" chưa có tên. Sửa: `POST /api/v1/admin/profile-test-endpoint` (parity legacy `/api/internal/test-profile-endpoint`).
6. **ACUI-M07 scope (T-UI-05):** plan ghi "fix BFF role bypass" chung chung. Sửa: chỉ áp dụng cho profile routes (list/detail/upsert/publish/rollback), không đụng route khác (business/connector/audit) — đúng scope user đã chốt (chỉ scoped user, không full BFF re-auth).

## Ghi chú thêm

- Migration numbering: plan dùng `0026`/`0027` (latest hiện tại `0025`) — đúng, nhưng codex cần ghi chú serialize theo lane owner nếu có lane khác cùng viết migrations.
- Plan hiện chứa cả Phần 0 (phân tích) + Phần 1–7 (plan) trong 1 file plan-mode; codex có thể giữ nguyên cấu trúc hoặc tách theo ý mình.
- Tôi (Claude) tạm dừng code, không tự sửa plan — chờ codex cập nhật plan cuối cùng.
