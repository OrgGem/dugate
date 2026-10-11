# Verify độc lập (DSH) — AWEB i18n language alignment + workflow stage count — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), offline tests only.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa product code; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3 · cwd `orchestrator/apps/admin-web`.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-i18n-stage-count-2026-10-10/DSH/` (`full-mjs.log`, `typecheck.log`, `SHA256SUMS.txt`).
**2 receipt đối tượng:** `receipt-aweb-i18n-language-alignment-2026-10-10.md` (219 dòng) · `receipt-aweb-workflow-stage-count-2026-10-10.md` (83 dòng) — **đều tồn tại**.

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| A | `node --test tests/*.test.mjs` (**7** file) | **0** | `# tests 62` · `# suites 13` · `# pass 62` · `# fail 0` |
| B | `npm run typecheck` | **0** | không output · `TS_errors=0` |
| C | Quét ký tự tiếng Việt trong `src/**/*.ts,tsx` (78 file) | — | **19 dòng còn tiếng Việt, thuộc 5 file** — xem §2 (**mâu thuẫn phạm vi**, không tick) |
| D | Đọc dòng fallback stage count | — | `workflows-screen.tsx:759` `<span>{wf.nodesCount ?? wf.stages?.length ?? 0} stages</span>` |

*Đính chính phương pháp:* lần quét đầu của tôi dùng lớp ký tự `[\u00C0-\u1EF9]` và cho **kết quả sai** (khớp cả dòng ASCII như `import … from 'react';`). Tôi **bỏ kết quả đó** và quét lại bằng tập code point tiếng Việt dựng tường minh (43 ký tự đặc trưng: ă â ê ô ơ ư đ à á ả ã ạ ế ệ ể ộ ờ ợ ủ ứ ợ …, dựng bằng `[char]`), rồi mới báo cáo.

## 2. i18n — claim của receipt gốc **KHÔNG được tái lập ở phạm vi toàn `src`**

- Receipt khai: bảng *Vietnamese lines before 135 → after **0***, *140 pairs*, mô tả *Both files went from mixed Vietnamese/English to English only*.
- Quét độc lập của tôi trên **toàn bộ** `src` (78 file) tìm thấy **19 dòng còn tiếng Việt trong 5 file**:

| File | Số dòng tiếng Việt |
|---|---:|
| `features/operations/operations-screen.tsx` | 9 |
| `features/api-docs/api-docs-screen.tsx` | 6 |
| `features/workflows/workflows-screen.tsx` | 2 |
| `features/identity/identity-screen.tsx` | 1 |
| `features/operations/operations-monitor-dashboard.tsx` | 1 |

Ví dụ nguyên văn: `api-docs-screen.tsx:408` *Chọn một API operation từ danh sách bên trái để xem tài liệu chi tiết.* · `operations-screen.tsx:310` *Đã chọn: {selected.size}* · `operations-screen.tsx:722` *Lượt {task.attempt}/{task.maxAttempts}*.

**Đọc kết quả này cho đúng (không suy diễn quá):**
- Nếu claim *0 dòng* chỉ **trong phạm vi 2 file mà lane đó sở hữu** thì **có thể vẫn đúng** cho 2 file đó — tôi **chưa** xác định được tên 2 file từ trích xuất receipt (tôi chỉ đọc phần tóm tắt/bảng), nên **không** khẳng định claim sai trong phạm vi đó.
- Nhưng ở phạm vi **toàn admin-web `src`** (cách đọc mà câu *0 Vietnamese lines remaining* gợi ra): **SAI còn 19 dòng / 5 file**, và **`workflows-screen.tsx` — file liên quan packet stage-count — vẫn còn 2 dòng tiếng Việt**, tức hai packet trong cùng batch **không** cùng trạng thái ngôn ngữ.
- ⇒ **GAP cần coordinator chốt:** hoặc siết lại câu chữ receipt (nêu rõ 2 file), hoặc giao packet i18n tiếp cho 5 file còn lại.

## 3. Workflow stage count — **ĐẠT, khớp nguyên văn receipt**

- `workflows-screen.tsx:759`: `<span>{wf.nodesCount ?? wf.stages?.length ?? 0} stages</span>` ⇒ fallback nay là **`?? 0`**, **không** còn bịa `1`.
- Comment ngay trên (`:756-758`) ghi rõ chủ ý, nguyên văn: *Both fields are optional, so an absent stage list is 0 stages - never a fabricated 1, and nodesCount 0 stays 0 because ?? only falls through on null/undefined.* ⇒ đúng bảng hành vi receipt khai (ô `nodesCount=0` vẫn ra 0, mảng rỗng ra 0, thiếu cả hai ra 0).
- **KHÔNG** tìm thấy mẫu `: 1}` / `?? 1` cho số stage trong `features/workflows` (grep `stages`/`fallback` chỉ ra các dòng `:435,449-459,635,879,1181-1186` — đều là luồng simulation/kết quả, không phải fallback bịa số).

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Full suite admin-web (7 file `.mjs`) | **PASS** — 62/62, 13 suite, exit 0 |
| Typecheck admin-web | **PASS** — exit 0, 0 lỗi |
| **Workflow stage count honesty** | **ĐẠT** — `:759` `?? 0` + comment `:756-758`; không còn `?? 1` |
| **i18n "0 dòng tiếng Việt"** | **KHÔNG tái lập ở phạm vi toàn `src`** — còn **19 dòng / 5 file** (có thể đúng nếu claim chỉ trong 2 file của lane; xem §2) |

⇒ **Workflow stage count: VERIFY ĐỘC LẬP ĐẠT.** **i18n: PARTIAL — không tick**, vì phạm vi "0 dòng" không khớp số đo toàn cục và còn 1 file trong cùng batch (workflows) mang 2 dòng tiếng Việt. Không tick gate nào (thuộc coordinator).

## 5. GAP / ghi chú

1. **Chốt phạm vi claim i18n** (2 file hay toàn `src`) và quyết định có mở packet cho 5 file còn lại (`operations-screen` 9, `api-docs-screen` 6, `workflows-screen` 2, `identity-screen` 1, `operations-monitor-dashboard` 1).
2. **Chưa kiểm chất lượng bản dịch:** tôi chỉ **đếm ký tự tiếng Việt**, không đánh giá 140 cặp dịch có đúng nghĩa/ngữ cảnh; cũng **chưa** kiểm chuỗi trong test/fixture hay trong `dist` (build cũ).
3. **Offline hoàn toàn:** không browser ⇒ chưa thấy UI thật; `node --test` chỉ chạy helper thuần JS.
4. **Chưa đọc hết 219 dòng receipt i18n** (chỉ trích phần tổng kết/bảng) ⇒ tên 2 file cụ thể **chưa** được tôi xác nhận.
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa product code; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 dòng trailing whitespace**; **2 dòng chứa ký tự nháy kép** (dòng 53 và 55 — phần trích nguyên văn comment mã nguồn) — ghi đúng sự thật, khác quy ước không-nháy-kép của các receipt khác.
