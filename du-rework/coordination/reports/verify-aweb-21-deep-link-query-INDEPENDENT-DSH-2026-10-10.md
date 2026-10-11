# Verify độc lập (DSH) — AWEB-21 deep link query hydration (Trace & Audit) — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), offline tests only.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa product code; **KHÔNG** tick gate.
**Đối tượng:** `coordination/reports/receipt-aweb-21-deep-link-query-2026-10-10.md` (31 dòng, tồn tại) — deep link query hydration cho **Trace & Audit**.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-orch-conformance-aweb21-2026-10-10/DSH/` (`aweb21-mjs.log`, `tsc-adminweb.log`, `SHA256SUMS.txt`).

## 1. Bằng chứng chạy

| # | Lệnh (cwd `orchestrator/apps/admin-web`) | REAL_EXIT | Literal | Claim gốc | Khớp? |
|---|---|---:|---|---|---|
| 4 | `node --test tests/*.test.mjs` (**6** file `.test.mjs`) | **0** | **`# tests 54`** · **`# suites 12`** · `# pass 54` · `# fail 0` | *PASS, 54 tests, 12 suites, exit code 0* | **KHỚP tuyệt đối** |
| 5 | `npm run typecheck` | **0** | không output | *PASS, exit code 0* | **KHỚP** |

*Ghi chú kỹ thuật:* PowerShell không tự mở glob cho lệnh native nên tôi liệt kê file rồi truyền danh sách; thư mục hiện có **6 file `.test.mjs`**, tổng **54 test / 12 suite** — trùng khít cả ba con số receipt khai.

**Đối chiếu theo thời gian:** ở lượt verify **F2 profile key** tôi đo cùng thư mục là **5 file / 48 test**; nay **6 file / 54 test** ⇒ có file test mới (+6 test) giữa hai lượt, phù hợp với việc AWEB-21 bổ sung test cho deep link. Con số trong receipt khớp trạng thái hiện tại.

## 2. Phạm vi đã kiểm và điều chưa kiểm

| Hạng mục | Kết quả |
|---|---|
| Full suite `.mjs` admin-web | **PASS** — 54/54, 12 suite, exit 0 |
| Typecheck admin-web | **PASS** — exit 0 |
| Claim của receipt gốc (số test/suite + exit) | **trùng khớp** |
| Hành vi **hydration** của Trace & Audit (đọc query string → state) | **CHƯA kiểm ở lượt này** — xem GAP 1 |

## 3. Verdict

⇒ **AWEB-21 deep link query hydration: VERIFY ĐỘC LẬP ĐẠT ở mức suite + typecheck xanh, đúng số liệu receipt**; phần **hành vi hydration cụ thể** chưa được tôi kiểm chứng độc lập. Không tick gate (thuộc coordinator).

## 4. GAP / ghi chú

1. **Chưa kiểm riêng logic hydration:** tôi chạy **toàn bộ** suite `.mjs` (kết quả tổng xanh) nhưng **không** tách riêng các ca deep link cho Trace/Audit để xác nhận chúng thực sự phủ việc đọc `location.search` → state (ví dụ: tham số lạ bị bỏ qua, giá trị rỗng, thứ tự ưu tiên giữa URL và state mặc định). Receipt gốc có ghi chú rằng lease chỉ phủ hai màn Trace/Audit và *không có file test mới* (dòng 31 bị cắt trong trích) ⇒ **rủi ro**: tính năng có thể **không** có ca test dành riêng. Đề nghị coordinator yêu cầu owner chỉ rõ **tên ca test** nào phủ hydration.
2. **Offline hoàn toàn:** `node --test` + typecheck; **không** browser/Playwright, không router thật ⇒ hành vi deep link khi mở URL trực tiếp trên trình duyệt **chưa** được chứng minh.
3. **Chưa đọc diff** của các file Trace/Audit screen/state trong lượt này (ngoài ngân sách) ⇒ không phán xét cách hydrate có đúng thiết kế.
4. **Chưa đối chiếu từng dòng receipt gốc** (31 dòng) — chỉ trích claim rồi chạy lại.
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.
