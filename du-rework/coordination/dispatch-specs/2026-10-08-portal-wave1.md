# Portal Feature Plan — Wave 1 dispatch (2026-10-08)

> **Vai trò:** coordinator. File này là **dispatch packet**, KHÔNG phải task ledger.
> Nguồn yêu cầu: `tasks/ADMIN-PORTAL-OPS-UX-2026-10-08.md` (rows `OPU-*`, tác giả khác).
> **Không tick gate nào. Không sửa cột accept/deliverable của bất kỳ task file nào.**
> File này chỉ *phân lô các row đã có sẵn* thành lease không chồng để agent thực thi.

## 0. Vì sao chọn Wave 1 như vậy

Tiêu chí chọn: (a) file lease **rời nhau tuyệt đối** giữa 3 lane, (b) fail-first chạy được
offline không cần DB/Redis, (c) mỗi lane có 1 bằng chứng đo được, (d) không đụng
`docs/21-openapi.json`, (e) đóng được bằng typecheck + 1 lệnh test tất định.

| Row | Vấn đề người dùng gặp | Đã verify trên đĩa |
|---|---|---|
| `OPU-G1` | không có gì trên khung cửa sổ để biết hệ thống còn phục vụ không | `lib/api/client.ts` grep `health` = **0 hit**; `app-shell.tsx` chỉ có 1 `setInterval` (đồng hồ, `:30`) |
| `OPU-OPS-1/2` | ca trực phải F5 thủ công; artifact có URL nhưng không tải được | `features/operations/state.ts:57` đã parse `downloadUrl` nhưng **không có** chỗ render link |
| `OPU-REF-1` | không biết API Reference đang hiện spec build nào | `features/api-docs/api-docs-screen.tsx:2` import `?raw` lúc build, `:28` parse 1 lần ở module scope |

**Không đưa vào Wave 1 (có lý do):**
- `OPU-G5` / `AWEB-09` — row do agent tự thêm, còn chờ coordinator/user arbitration.
- `OPU-G2`, `OPU-G3`, `OPU-G4` — cần sửa `app-shell.tsx` + `client.ts` + `router` cùng lúc; **trùng lease với Lane A**. Giữ lại Wave 2 sau khi Lane A đóng.
- `OPU-BST-*`, `OPU-OVR-*`, `OPU-SEC-*` — cần backend route mới, chưa có nguồn sự thật.
- `OPU-WFL-*`, `OPU-DOC-*` — `workflows` và `docs` chưa nằm trong allow-list `DU_ADMIN_WEB_ROUTES`; phải chốt mở allow-list trước.

## 1. Lease matrix — không chồng

| Lane | Agent | Row | File được sửa (duy nhất) | File được tạo mới |
|---|---|---|---|---|
| **A** | Codex `term_ca784044` | `OPU-G1` | `services/orchestrator/src/app/admin/bff/handle.ts`, `apps/admin-web/src/lib/api/client.ts`, `apps/admin-web/src/app-shell/app-shell.tsx` | `services/orchestrator/src/app/admin/bff/health.ts`, `services/orchestrator/tests/admin-bff-health-offline.test.ts` |
| **B** | qwen `term_4bca69af` | `OPU-OPS-1`, `OPU-OPS-2` | `apps/admin-web/src/features/operations/operations-screen.tsx`, `apps/admin-web/src/features/operations/state.ts` | `services/orchestrator/tests/operations-download-live-offline.cjs` |
| **C** | OC `term_f1c5a1d1` | `OPU-REF-1` | `apps/admin-web/src/features/api-docs/api-docs-screen.tsx` | `services/orchestrator/tests/api-docs-build-label-offline.cjs` |

Không lane nào được đụng file của lane khác. Nếu phát hiện cần sửa thêm file ngoài lease →
**dừng, ghi vào receipt, không sửa**.

## 2. Lệnh verify bắt buộc (mỗi lane tự chạy, tự chép literal)

```bash
# typecheck (cả 3 lane)
cd D:/Git/dugate/du-rework/orchestrator/apps/admin-web
pnpm --filter @du/admin-web typecheck        # kỳ vọng exit 0

# test lane (dùng config của orchestrator, KHÔNG dùng config admin-web)
cd D:/Git/dugate/du-rework/orchestrator/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/<file>

# harness .cjs — chạy trực tiếp bằng node, KHÔNG đưa vào jest
node tests/<file>.cjs
```

Bẫy đã biết: `jest.unit.config.cjs` có `testMatch: ['**/*.test.ts']` ⇒ file `.cjs` **không
được jest thu thập**. Chạy bằng `node`. Nếu giao jest vào `.cjs` sẽ ra `No tests found, exit 1`.

## 3. Ràng buộc chung (nhắc lại trong từng prompt)

- fail-first: viết test đỏ trước, chép literal RED, rồi mới sửa.
- Không commit, không `git add`, không push.
- Không hand-edit `docs/21-openapi.json` (chỉ regenerate qua `tools/openapi/gen_openapi.py`).
- Không đọc/in nội dung `.env.live`.
- Không tự tick `VERIFIED`/`ACCEPTED`.
- Không bỏ qua test đỏ, không nới assertion để xanh.
- Offline: không claim DB window, không chạy PostgreSQL/Redis thật.
- Nếu thiếu dữ liệu thì hiện `unknown`/`unavailable` + thời điểm mẫu cuối — **không** thay bằng `0`.

## 4. Sau Wave 1

Coordinator thu receipt → tự verify lại (không tin receipt) → mới quyết định có mở Wave 2
(`OPU-G2/G3/G4`) hay không. Gate tick thuộc coordinator và cuối cùng là user.
