# .env.example sync — Admin Web flags (đóng doc-note aweb08-docs)

**Packet:** env-example-sync · **Lane:** cc_1 · **Dispatch:** 2026-10-04T14:51+07:00.
**Trạng thái:** DONE. Chỉ 2 file được ghi: `du-rework/.env.example` + receipt này. Không sửa `.env.live`/file khác. Không commit.

## Mtime guard (trước khi vá)

| File | mtime | git status | Quyết định |
|---|---|---|---|
| `du-rework/.env.example` | **2026-09-28 08:32:13** (1.051 bytes) | clean (không có trong `git status -- du-rework/.env.example`) | **VÁ** |

## Diff (verbatim)

```diff
@@ -21,6 +21,11 @@ ARTIFACT_STORAGE_BACKEND=postgres
 # ARTIFACT_S3_REGION=ap-southeast-1
 # ARTIFACT_S3_ENDPOINT=
 
+# Admin Web React (AWEB-08) — xem docs/12b-deployment-guide.md §3.1
+# DU_ADMIN_WEB=1                              # bật mount /admin/web (mặc định tắt; legacy /admin/* nguyên trạng)
+# DU_ADMIN_WEB_ROUTES=overview                # allow-list route SPA (fail-closed; mặc định = toàn bộ)
+# DU_ADMIN_WEB_DIST=/abs/apps/admin-web/dist  # tùy chọn override bundle
+
 # Connector
 CONNECTOR_PORT=8080
 CONNECTOR_REDIS_PREFIX=du:connector:
```

- Vị trí: **dòng 24-27** của `du-rework/.env.example` (giữa block S3 của Orchestrator và section `# Connector`) — cùng convention comment-out `#` mà file đang dùng cho nhóm optional (block S3).
- Không đổi bất kỳ biến/dòng nào khác (`git diff --stat` = 1 file, +5/-0).

## Kiểm tra trùng biến

- `Select-String 'DU_ADMIN_WEB'` sau khi vá = **3 dòng** = đúng 3 dòng comment mới (`DU_ADMIN_WEB`, `DU_ADMIN_WEB_ROUTES`, `DU_ADMIN_WEB_DIST`) — mỗi tên xuất hiện **một lần**, không trùng với biến nào có sẵn (trước khi vá grep = 0 dòng).
- Đối chiếu semantics với `docs/12b-deployment-guide.md` §3 bảng env + §3.1 (vừa cập nhật ở AWEB-08-docs): khớp (mặc định tắt; allow-list fail-closed; biến không áp dụng khi cờ chính tắt).

## Ghi chú

- Git hiển thị cảnh báo LF→CRLF chuẩn của repo khi diff file này (autocrlf), không phải thay đổi line-ending do packet — nội dung dòng không đổi.
- Doc-note của `aweb08-docs` (§3 “Doc-note”) nay đã đóng cho `.env.example`; các doc-note còn lại (11-admin-ux dirty, docs-site không có trong du-rework) không thuộc packet này.

## Verdict

**ACCEPTED**: 3 flag Admin Web vào `.env.example` đúng format hiện có, không trùng, không đổi gì khác; mtime guard pass (file sạch 28/09). Không sửa `.env.live`, không commit.
