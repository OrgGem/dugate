# Docs pointer sync — 11-admin-ux trỏ rollout semantics mới (2026-10-04)

**Packet:** docs-ux-pointer · **Lane:** cc_1 · **Dispatch:** 2026-10-04T16:01+07:00.
**Trạng thái:** DONE. Chỉ `du-rework/docs/11-admin-ux.md` + receipt. Không code, không `tasks/**`, không chạm file dirty của lane khác (ngoài file được packet chỉ định). Không commit.

## 1. Mtime guard

| Mốc | Giá trị |
|---|---|
| Check lúc 14:33 (AWEB-08-docs) | mtime `2026-10-04 10:50:05` |
| Re-check lúc 16:02 (packet này) | mtime **vẫn `2026-10-04 10:50:05`** — không ai chạm trong ~5h12m |
| `git status` | ` M du-rework/docs/11-admin-ux.md` (nội dung uncommitted của lane docs — packet chỉ định rõ được phép vá sau re-check) |

→ Guard pass, tiến hành vá.

## 2. Đã thêm (file:line + verbatim)

**`docs/11-admin-ux.md` dòng 4-5** (nối tiếp blockquote đầu trang, giữ văn phong hiện có):

```markdown
>
> Rollout Admin Web (React) đi theo **từng route**: bật bằng `DU_ADMIN_WEB` + allow-list `DU_ADMIN_WEB_ROUTES` (fail-closed, route ngoài allow-list trả 404 nhất quán; legacy `/admin/*` không đổi) — semantics/rollback đầy đủ ở [Deployment Guide §3.1](12b-deployment-guide.md).
```

2 dòng, không chép lại nội dung — chỉ trỏ `docs/12b-deployment-guide.md` (§3.1) và gián tiếp contract qua câu trước đó (`admin-ui-development-contract.md` đã được link ở dòng 3 của cùng blockquote).

## 3. Rà tuyên bố cũ trong `docs/**.md` — danh sách + quyết định

Pattern quét: `một cờ duy nhất|mount toàn bộ|một công tắc|cờ duy nhất|DU_ADMIN_WEB|bật/tắt bằng` trên toàn bộ `docs/**/*.md`.

| Kết quả | Ghi nhận |
|---|---|
| Claim kiểu “Admin Web mount toàn bộ / một cờ duy nhất / không per-route” | **0 dòng** — không có tuyên bố cũ nào cần sửa |
| `DU_ADMIN_WEB*` xuất hiện | chỉ ở `12b-deployment-guide.md` (dòng 124-126 bảng env, 130-148 §3.1, 207 rollback — canonical mới) và dòng 5 vừa thêm ở `11-admin-ux.md` |
| `admin-ui-development-contract.md:12` | “Chuyển từng route bằng cờ bật phía server… route chưa chuyển tiếp tục dùng renderer hiện tại” — **đã nhất quán** với per-route flag, không cần sửa |
| `admin-ui-development-contract.md` / file untracked khác | thuộc lane docs (untracked, chưa qua review) — **không sửa**, chỉ liệt kê |

→ Không cần dùng quota “1 file docs sạch khác”: quét sạch, không file nào cần sửa 1 dòng.

## 4. File đã chạm

| File | Thay đổi |
|---|---|
| `docs/11-admin-ux.md` | +2 dòng (4-5) pointer tới Deployment Guide §3.1 |
| `coordination/reports/aweb08-docs-ux-pointer-2026-10-04.md` | receipt này |

`git status -- docs` sau khi vá: nhóm modified sẵn có của lane khác không đổi (00/03/21 + contract untracked); `11-admin-ux.md` vẫn ` M` (nội dung cũ + 2 dòng mới) — không file mới nào bị chạm ngoài danh sách trên.

## Verdict

**ACCEPTED**: pointer 2 dòng đúng chỗ (blockquote intro 11-admin-ux), guard re-check pass (mtime không đổi 5h), sweep `docs/**` **không còn tuyên bố cũ** về single-flag/mount-toàn-bộ; contract vốn đã nhất quán. Không sửa file thứ hai, không commit.
