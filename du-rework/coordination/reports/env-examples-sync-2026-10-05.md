# ENV-EXAMPLES-SYNC — 3 env Vault mới vào .env.example — cc_2 — 2026-10-05

**Packet:** coordinator 02:39 (+07) (duyệt Δ-env-example của DOCS-CONNECTOR-WIRE). **Lane:** cc_2 (`term_ee7e9f33`).
**Mode:** doc-only; offline; no commit. Chỉ 1 file ghi: `du-rework/.env.example` + receipt này.

---

## 0. TL;DR

Thêm block **`# Vault credential workflow (CREDWORKFLOW-IMPL)`** (6 dòng: header + cảnh báo all-or-nothing/refuse-boot + 3 biến comment-out với ví dụ JSON hợp lệ) vào `.env.example` — đúng convention comment-out của file. `connectorManagementHeaders` **không phải env** (không có env parser — grep toàn repo xác nhận) → **không thêm vào template**; đã document là deployment config tại `docs/12b-deployment-guide.md §3.2`. Không có validator env-example chuyên dụng — dùng lại đúng phương pháp receipt sync trước (mtime guard + grep trùng + JSON hợp lệ + diff verbatim).

## 1. Mtime guard + attribution

| Thời điểm | sha16 | mtime | size | git |
|---|---|---|---|---|
| **PRE** | `16931D7BB6177681` | 2026-10-04 14:53:44 | 1436 | `M` |
| **POST** | `B4CBB1218E7AD621` | 2026-10-05 02:39:09 | 1936 | `M` |

- PRE `M` delta đã đối chiếu: **đúng nguyên văn block AWEB-08** của receipt [env-example-admin-web-2026-10-04](env-example-admin-web-2026-10-04.md) (delta chưa commit của packet đó) → **0 foreign writer**.
- Delta của packet này = **+6 dòng** (receipt trước +5; tổng diff hiện tại +11 do cộng AWEB block cũ).

## 2. Diff (verbatim — phần của packet này)

```diff
@@ sau CONNECTOR_ENCRYPTION_KEY=
+
+# Vault credential workflow (CREDWORKFLOW-IMPL) — xem docs/12b-deployment-guide.md §3.2
+# Toàn bộ hoặc không: đủ bộ ⇒ workflow bật; một phần / sai JSON ⇒ TỪ CHỐI BOOT (refuse-boot typed)
+# DU_VAULT_KV_OPTIONS={"vaultAddress":"http://vault:8200","kvMount":"secret","requestTimeoutMs":5000}
+# DU_VAULT_KV_TOKEN=change_me_vault_machine_identity_token
+# DU_CONNECTOR_INITIAL_BINDINGS={"openai":{"tenantId":"00000000-0000-4000-8000-000000000000","accountId":"acct-openai-1"}}
```

Vị trí: **dòng 36-41**, giữa block `# Connector` và `# Workers` (nhóm cấu hình credential thuộc Connector plane); comment-out `#` đúng convention nhóm optional (S3/AdminWeb).

## 3. Checks literal

```
grep trùng (mỗi tên phải = 1):
  DU_VAULT_KV_OPTIONS=1 | DU_VAULT_KV_TOKEN=1 | DU_CONNECTOR_INITIAL_BINDINGS=1
  (trước khi vá: cả 3 = 0)

node JSON.parse ví dụ trong comment:
  OPTIONS_OK true   (vaultAddress http(s) tuyệt đối; kvMount "secret"; requestTimeoutMs số nguyên dương
                     — khớp đúng validator compose.ts:44-69)
  BINDINGS_OK true  (openai.tenantId/accountId non-empty — khớp compose.ts:77-105)

git diff --stat: 1 file changed, 11 insertions(+), 0 deletions(–)
```
`script/` không có thay đổi; không đổi bất kỳ dòng cũ nào.

## 4. "Check thêm env mới khác"

| Ứng viên | Kết luận | Hành động |
|---|---|---|
| `connectorManagementHeaders` | **KHÔNG phải env** — grep toàn repo chỉ thấy: `server.ts:92` (ServerConfig field), `create-app.ts:431/449` (đọc config), tests + receipts/docs. Không có env parser ở `main.ts` hay nơi khác | **Không thêm template**; đã document tại `docs/12b-deployment-guide.md §3.2` là deployment config (kèm ghi chú "nếu thêm env wiring, ghi tên tại đây") |
| `connectorBaseUrls` | Tương tự — ServerConfig map, không env | như trên |
| Env khác của `main.ts` chưa có trong template (TENANT_ADMIN_TOKENS_BY_TENANT, WORKER_IDENTITY_TOKENS_BY_BUSINESS, USAGE_TOKEN, WEBHOOK_*, ADMIN_SHELL_*, SHUTDOWN_BUDGET_MS, ARTIFACT_STORAGE_MIGRATION_WINDOW…) | **Pre-existing gap** (không phải env mới của wave này; template vốn chỉ phủ subset compose) | **Không sửa** trong packet này — ghi nhận làm ứng viên cho một packet "full template sync" nếu coordinator muốn |

## 5. Notes

- Không có script validator `.env.example` chuyên dụng trong repo (không tìm thấy trong `coordination/scripts`/`scripts`); các check §3 thay thế, cùng phương pháp receipt sync trước.
- Git cảnh báo LF→CRLF chuẩn của repo khi diff file này (autocrlf) — không phải thay đổi line-ending do packet; nội dung dòng không đổi.
- Boundary: `.env.example` + receipt này. Không chạm `.env.live` (artifact live), `docs/` (khác packet), source/tests/ledger. No commit.
