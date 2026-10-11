# Dispatch Spec: MDB-POLICY-01 — Connector Preparation Policy

- Date: 2026-10-10
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Qwen-B (`term_bd1937f8-0134-4d02-b511-353625e8a3ae`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng live DB/Redis/S3)
- Canonical plan: `du-rework/coordination/PLAN-OPEN-2026-10-09.md` §9.2 / §9.3 (hạng 5) + `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7
- Status: DISPATCHED
- Lease:
  - `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (phần `prepareConnector`)
  - `orchestrator/services/orchestrator/tests/mdb-policy-01-connector.test.cjs` (test offline mới)
  - `du-rework/coordination/reports/receipt-mdb-policy-01-connector-2026-10-10.md` (receipt)

---

## 1. Bối cảnh và Nhiệm vụ

`ldba-context-provider.cjs` hiện ném `CONTEXT_POLICY_REQUIRED` ở callback `prepareConnector`.
Trong khi đó, logic chuyển đổi chuẩn của connector đã được kiểm thử và nghiệm thu trong module LDBA-05:
`orchestrator/services/connector/src/db/legacy-connector-adapter.ts` (hàm `projectLegacyExternalApiConnection`).

LDBA-03 backfill (`ldba-03-backfill.cjs:479-540`) yêu cầu `prepareConnector(row, request)` trả về cấu trúc:
```json
{
  "revision": {
    "connector_id": "<text>",
    "revision": 1,
    "adapter": "json-http | multipart-http",
    "config": { ... },
    "credential_ref": "<text>",
    "state": "ACTIVE | RETIRED",
    "credential_source": { "kind": "legacy-db", "credentialRef": "<text>" },
    "tenant_id": "",
    "createdAt": "<utc>"
  },
  "secret": {
    "id": "<text>",
    "credential_ref": "<text>",
    "encrypted_value": "<Buffer/Uint8Array>"
  }
}
```

Ràng buộc bảo mật của backfill (`:515-533`):
1. `revision.config` TUYỆT ĐỐI không chứa plaintext `authSecret`.
2. `secret.encrypted_value` không được bằng plaintext bytes (phải là ciphertext).
3. `revision.tenant_id` phải là chuỗi rỗng `""` (unbound theo migration 008).
4. `revision.credential_source.kind` phải là `legacy-db`.

## 2. Công việc cần làm cho Qwen-B

1. Kết nối hàm `prepareConnector(row, request)` trong `ldba-context-provider.cjs` thực hiện mapping cho `ExternalApiConnection` tuân thủ đầy đủ schema và ràng buộc bảo mật của `ldba-03-backfill.cjs:479-540`.
2. Nếu không có encryption key hợp lệ, phải fail-closed hoặc dừng dòng một cách an toàn.
3. Viết test offline đầy đủ trong `tests/mdb-policy-01-connector.test.cjs`:
   - Happy path: `ExternalApiConnection` hợp lệ → trả đúng shape `{ revision, secret }`, `revision.revision === 1`, `tenant_id === ""`, secret đã mã hóa, config không chứa plaintext secret.
   - Negative controls: thiếu secret hoặc cipher lỗi → dừng dòng an toàn.
4. Chạy test offline pass và typecheck pass.
5. Nộp receipt tại `du-rework/coordination/reports/receipt-mdb-policy-01-connector-2026-10-10.md`.

## 3. Ràng buộc

- KHÔNG git add, commit, push.
- KHÔNG dùng ký tự nháy kép trong prompt hoặc khi gửi lệnh.
- KHÔNG mở cửa sổ live DB/Redis.
