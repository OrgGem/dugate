# Receipt: VFY-SC03 — live browser probe (harness + Playwright)

- **Task:** dispatch khởi động admin-web harness và chạy live browser probe cho SC-03 (F2/F6/F7 + no-plaintext).
- **Recipient:** oc_4 (term_ff912d69-95a4-4ab7-9faf-89ff75b91739) · **Thời điểm:** 2026-10-07 ~01:45–02:05 · **HEAD:** `4308cc54eda32cfcca54e0c55554fc85d720a43b` (+ working tree uncommitted) · Node v22.16.0.
- **Code freeze:** không commit, không push. File mới duy nhất ngoài receipt: 2 probe bổ sung trong `coordination/reports/raw/` (evidence).

## 1. Môi trường chạy (ephemeral, đã dọn sạch)

| Bước | Lệnh / hành động | Kết quả |
|---|---|---|
| Build admin-web | `node node_modules/vite/bin/vite.js build` (cwd `du-rework/apps/admin-web`) | **exit 0**, 10.50s — `dist/` fresh, chứa F6 fix thế hệ mới nhất |
| Harness | `node <root>/node_modules/tsx/dist/cli.mjs tests/browser/admin-web/harness.ts .harness-out.tmp.json` (cwd `du-rework`, background, pid ghi file) | up: admin-web `http://127.0.0.1:62283`, stub `:62282`, token từ `.harness-out.tmp.json` |
| Probe chính | `AWEB01B_URL/AWEB01B_TOKEN/AWEB03B_STUB node coordination/reports/raw/vfy-sc03-browser-verify.cjs` | **exit 0** (xem §2 — có cảnh báo skip) |
| Supplement | `node coordination/reports/raw/vfy-sc03-f6-f7-supplement-2026-10-07.cjs` | **exit 1** (2 FAIL — đều thuộc F7, xem §3) |
| Cleanup | `Stop-Process` pid harness + xóa `.harness-out.tmp.json`, `.harness-pid.tmp`, 2 log boot | process chết, port 62283 đóng, không còn file `.harness*` |

Raw output: `coordination/reports/raw/vfy-sc03-browser-e2e-2026-10-07.txt` (probe chính), `coordination/reports/raw/vfy-sc03-f6-f7-supplement-2026-10-07.txt` (supplement).

## 2. Probe chính (qwen_2) — exit 0 nhưng **F6/F7 bị skip âm thầm**

```
PASS F2 no duplicate DOM ids
PASS no plaintext secret in DOM
PASS no plaintext secret in responses
PASS no page errors
VFY-SC03: all checks PASS   (exit 0)
```

**Cảnh báo toàn văn:** probe **không in dòng nào cho F6 và F7** — cả hai bị skip vì selector không chạm được DOM thật:

- F6 tìm `input[name="version"]` — input thật là `#vault-version-number` (không có attribute `name`), lại nằm **trong modal "New secret" đang đóng** → `count()===0` → nhánh check không chạy.
- F7 tìm `[role="radiogroup"]` trên trang secrets — radiogroup duy nhất ("Secret provider") cũng nằm trong modal đóng → skip.

Kết luận: exit 0 của probe chính **không phải** bằng chứng F6/F7 PASS (đúng quy tắc "harness exit 0 ≠ functional PASS"). F2 và no-plaintext là PASS thật trên browser.

## 3. Supplement (mới, của lượt này) — F6 PASS đầy đủ, **F7 ĐỎ**

Vì F6/F7 bị skip, tôi viết supplement `coordination/reports/raw/vfy-sc03-f6-f7-supplement-2026-10-07.cjs` (mở modal thật, spy network). Kết quả:

```
PASS F6 invalid pinned ""    : inline error + Save disabled
PASS F6 invalid pinned "1.5" : inline error + Save disabled
PASS F6 invalid pinned "0"   : inline error + Save disabled
PASS F6 zero create POST for invalid versions        ← spy request: 0 POST /admin/api/secrets
PASS F7 provider radiogroup present
FAIL F7 roving tabindex (exactly one 0, rest -1) :: ["0","0"]
FAIL F7 ArrowRight moves focus to the other radio :: radio:Managed value
PASS F6 valid pinned version not blocked (Save enabled, no inline error, request fired)
PASS no page errors during supplement
exit 1 (2 FAIL)
```

### F6 — VERIFIED PASS trên browser thật (đủ mạnh cho mọi phương án dispatch)

Trong lúc verify, fix F6 trên tree đã tiến hóa thêm một thế hệ (worker song song bổ sung vào `secrets-screen.tsx`, diff hiện tại +51/−2). Trạng thái cuối được kiểm chứng gồm **3 lớp phòng thủ**:

1. Nút **Save bị disable** khi pinned version invalid (`pinnedVersionInvalid` trong điều kiện `disabled`).
2. **Inline error** "Enter a whole number of 1 or more." hiển thị ngay tại field (FormField `error`).
3. Guard `submitCreate` refuse + banner 422 `INVALID_VERSION` (defense-in-depth), payload builder dùng `parsePinnedVersion(...)!` — không còn đường `Number()` → NaN → null.

Supplement chứng minh: `''`, `'1.5'`, `'0'` đều bị chặn (error + disabled, **0 request** rời trình duyệt); giá trị hợp lệ `'3'` → Save enabled, error tắt, request được gửi (positive control).

Observation nhỏ (không thuộc acceptance dispatch): `aria-invalid` không được gắn lên `#vault-version-number` vì child của FormField là `<div>` composite (select + input), ngoài khả năng clone của FormField. Lỗi vẫn hiển thị đầy đủ trực quan. Ghi nhận dạng INFO trong raw log.

### F7 — VẪN MỞ (đỏ thật, có bằng chứng live)

Audit lane1 §F7 phạt **hai nơi**: `value-source-selector.tsx` và "tương tự nhóm provider ở `secrets-screen.tsx`". Hiện trạng trên build đã test:

- `value-source-selector.tsx:135-143,191-218` **đã có** roving tabindex + arrow keys — nhưng **không render trong app**: cả 2 call-site ở `callback-policy-editor.tsx` đều `secretOnly` → `showToggle=false`. Fix đúng nhưng unreachable, không thể verify bằng browser.
- `secrets-screen.tsx:519` — radiogroup **"Secret provider" (live, render thật trong modal)** vẫn chưa có gì: hai radio đều `tabindex="0"` (`["0","0"]`), không `onKeyDown`; ArrowRight không chuyển focus (focus đứng ở "Managed value").

→ **F7 chưa được đóng.** Đề xuất packet nhỏ cho Portal owner: áp pattern đã có sẵn trong `value-source-selector.tsx` (ref + `tabIndex={active?0:-1}` + `handleRadioKeyDown`) cho nhóm provider ở `secrets-screen.tsx:508-524`. Supplement probe ở §3 có thể tái dùng nguyên vẹn làm failing-first test (hiện FAIL đúng 2 case F7, sẽ xanh khi fix xong).

## 4. Tổng hợp check theo yêu cầu dispatch

| Check dispatch yêu cầu | Kết quả | Nguồn bằng chứng |
|---|---|---|
| F2 — 0 duplicate id (hai callback editor mở) | **PASS** | probe chính (exit 0) |
| F6 — pinned version NaN/null bị chặn | **PASS** (3 invalid bị chặn, 0 POST, positive control OK) | supplement |
| F7 — roving tabIndex | **FAIL — finding còn mở** (`["0","0"]`, ArrowRight không hoạt động trên "Secret provider") | supplement |
| 0 secret leak (DOM + response bodies, sentinels `sk-live-`/`hunter2`/`dXNlcjpwYXNz`) | **PASS** | probe chính |
| 0 page errors | **PASS** | cả hai probe |
| Exit code | probe chính **0**; supplement **1** (đỏ F7) | raw logs |

## 5. Khuyến nghị cho dispatcher

1. **Không tick F7/SC-03** dựa trên exit 0 của probe chính — F7 còn mở với bằng chứng live ở §3.
2. Giao packet F7 cho Portal owner (lease `apps/admin-web/src/features/secrets/secrets-screen.tsx`); supplement probe làm acceptance: `node coordination/reports/raw/vfy-sc03-f6-f7-supplement-2026-10-07.cjs` phải exit 0.
3. Nhờ qwen_2 cập nhật selector probe chính (`input[name="version"]` → mở modal + `#vault-version-number`; F7 → radiogroup trong modal mở), nếu không probe sẽ tiếp tục "xanh giả" ở F6/F7.
4. Điều phối: `secrets-screen.tsx` đã có **2 thế hệ sửa trong <1 giờ** bởi nhiều worker — nên chốt một lease duy nhất cho file này tới khi F7 đóng.
