# VERIFY-ADMIN-WEB-CSRF-805 — 2026-10-05

## Kết quả

- Standalone TypeScript check `pnpm exec tsc --noEmit -p tsconfig.json` từ `apps/admin-web`: **exit 0**, không có diagnostic.
- Production build `pnpm --filter @du/admin-web build`: **3/3 exit 0**. Script package chạy `tsc --noEmit -p tsconfig.json && vite build`; mỗi lượt đã typecheck lại thành công trước Vite.
- Cả ba lượt tạo cùng hai file `dist/assets/*`, cùng kích thước và SHA-256. **Build hiện tại deterministic**, nhưng digest không khớp hai digest trong các receipt CFGADM; xem mục “Digest reconciliation”. Vì vậy không xác nhận các digest cũ là asset của working tree hiện tại.
- `/docs` đang đăng ký đúng route, bootstrap session bằng `getSession()`, và chặn nút/handler Test Workbench nếu chưa có session hợp lệ hoặc role không phải admin/operator.

## Raw build results

Mỗi command là `pnpm --filter @du/admin-web build` từ root `du-rework/`; exit code ghi ngay sau output Vite.

| Run | Vite | Kết quả build | Vite duration | Exit code |
|---|---|---|---:|---:|
| 1 | 6.4.3, production | 2674 modules; assets emitted | 13.96s | 0 |
| 2 | 6.4.3, production | 2674 modules; assets emitted | 8.73s | 0 |
| 3 | 6.4.3, production | 2674 modules; assets emitted | 8.26s | 0 |

Cả ba build có cảnh báo chunk JavaScript lớn hơn 500 kB sau minify; build vẫn thành công. `dist/index.html` tham chiếu `/admin/web/assets/index-B1j53ou2.js` và `/admin/web/assets/index-9VWq5VN-.css`.

| Asset trong cả ba lượt | Bytes | SHA-256 |
|---|---:|---|
| `index-B1j53ou2.js` | 508667 | `58c718bd788fbfd38f9d9c5de2cc128b1162b83791bfcc33c793c1e290d0f61f` |
| `index-9VWq5VN-.css` | 42978 | `8b18276131bbb16cc32ee427a4c52c5f6a49869dacc3c8dec32e66e428e39ba6` |

Standalone typecheck:

```text
pnpm exec tsc --noEmit -p tsconfig.json
TYPECHECK_EXIT_CODE=0
```

## `/docs` SessionState và CSRF gate

Đã đọc source và kiểm tra marker trong bundle JS vừa build:

- `apps/admin-web/src/router.tsx:50` đăng ký `path: 'docs'` → `DocsRoute`; `apps/admin-web/src/routes/docs.tsx:1-4` render `DocsScreen`.
- `apps/admin-web/src/features/docs/docs-screen.tsx:23-26` định nghĩa `SessionState` gồm `loading | ready | failed`.
- `docs-screen.tsx:46-56` gọi `client.getSession()` khi mount, chỉ đánh dấu `ready` nếu kết quả thành công, và có unmount guard.
- `docs-screen.tsx:60-68` chỉ đặt `canRunTest=true` với role `admin` hoặc `operator`; loading/failed/role khác đều có lý do unavailable.
- `docs-screen.tsx:91-103` từ chối trong handler trước request nếu session chưa `ready` hoặc role không được phép; `:200` disable nút khi busy hoặc `!canRunTest`.
- `apps/admin-web/src/lib/api/client.ts:221-224` chỉ sau `getSession()` thành công mới lưu `csrfToken`; `:156` gửi `x-csrf-token` cho mutation có `csrf: true` khi đã có token.
- Bundle `index-B1j53ou2.js` chứa các marker `getSession`, `Profile Test Endpoint is unavailable for this session`, `Admin session unavailable, so the server-issued CSRF proof cannot be obtained`, và `requires an admin or operator session`.

Điều này xác minh nội dung source và output build. **Không chạy trình duyệt/Playwright**, nên không đưa ra kết luận browser runtime.

## Digest reconciliation với hai receipt CFGADM

Các digest trong receipt owner không nhận diện asset do ba build hiện tại sinh ra:

| Nguồn | JavaScript được ghi trong receipt | CSS được ghi trong receipt | So với build hiện tại |
|---|---|---|---|
| `cfgadm-port-p3-2026-10-05.md:19` | `index-Bs0p8VRI.js`, SHA-256 prefix `8ccdbab15d44cca1` | `index-BffJF1YL.css`, prefix `baf331d4ea62f327` | Cả tên file và digest đều khác. |
| `cfgadm-docs-csrf-fix-2026-10-05.md:67-74` (receipt nói supersede P3) | `index-BZ2-Edjb.js`, prefix `2296c26628f4a454` | `index-BffJF1YL.css`, prefix `baf331d4ea62f327` | Cả tên file và digest đều khác. |
| Working tree build x3 | `index-B1j53ou2.js`, SHA-256 `58c718bd788fbfd38f9d9c5de2cc128b1162b83791bfcc33c793c1e290d0f61f` | `index-9VWq5VN-.css`, SHA-256 `8b18276131bbb16cc32ee427a4c52c5f6a49869dacc3c8dec32e66e428e39ba6` | Giống nhau tuyệt đối trong cả ba lần build. |

Source hash cũng cho thấy working tree không đúng nguyên snapshot của receipt CSRF: receipt ghi `docs-screen.tsx` SHA prefix `f5e2f3a8be6503b9`, còn file hiện tại có SHA-256 `08a9a61348f349e80cc6b54e0b45021c135ddb50b192a1ec7a5837f327dc838c`. Ngược lại, `router.tsx` hiện tại bắt đầu bằng prefix `f3419a4c374bb94c` như P3 receipt; `routes/docs.tsx` hiện tại bắt đầu bằng prefix `839781e0aef0c7eb` như P3 receipt. Source hiện tại vẫn có đúng SessionState/canRunTest logic mô tả ở trên và output bundle có các marker đó, nhưng **không thể quy digest mới cho đúng hai snapshot/receipt cũ nếu không reconcile source drift**.

Đề nghị owner cập nhật digest và ghi rõ snapshot/source hash được review trước khi dùng `index-B1j53ou2.js` làm artifact đại diện cho hai fix. Đây là mismatch bằng chứng, không phải lỗi build/typecheck hoặc bằng chứng gate bị mất.

## Phạm vi và giới hạn

- Đã chạy standalone typecheck và ba production builds; không sửa source/test. Build đã tạo lại `apps/admin-web/dist` theo nội dung hiện tại.
- `git status --short` trước build cho thấy toàn bộ `apps/admin-web/` và hai receipt CFGADM là untracked trong checkout hiện tại. Vì vậy đánh giá gắn với working tree hiện có, không chứng minh nội dung đã commit hoặc deploy.
- Chưa chạy browser, server preview, hay live Admin BFF/session; việc đó ngoài ba bước được yêu cầu. Cảnh báo chunk-size là non-blocking.
