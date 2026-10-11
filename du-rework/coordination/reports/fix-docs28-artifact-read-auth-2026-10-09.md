# FIX DOCS/28 — artifact-read-auth (version C, doc-only) — 2026-10-09

**Vai trò:** doc-editor, lane khác tác giả (draft B/C) và lane khác verifier (DSH). Áp đúng version C trong bản thảo; **không** tự sửa source/test/config; không commit/`git add`/push; không tick gate; không đọc `.env.live`; OFFLINE.
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`
**File duy nhất bị sửa:** `du-rework/docs/28-test-inventory.md`

## Tài liệu tham chiếu đã đọc

1. `coordination/reports/draft-decision-artifact-read-auth-2026-10-09.md` — mục BƯỚC 3 (version C) + BƯỚC 4.
2. `coordination/reports/verify-draft-decision-independent-2026-10-09.md` — đã xác nhận version C DUNG cho cả 4 claim.

## BẢNG CHỨNG — từng dòng đã sửa

| Dòng (sau sửa) | Hành động | Nội dung | Fail-first (khớp draft)? |
|---|---|---|---|
| `docs/28:1399` | THAY | **Mệnh đề 1:** `cross-operation plus declared plus STAGING returns 409 PERMISSION_DENIED (artifacts.ts:753-755, kiểm tra *foreign task + chưa READY* chạy trước nhánh STATE_CONFLICT ở :756)` — thay `409 STATE_CONFLICT, not PERMISSION_DENIED`. **Mệnh đề 2:** `…whereas an expired (or never-set) lease yields 409 LEASE_LOST (artifacts.ts:707) trước khi task state được xét, và một lease còn sống với epoch đúng vẫn được cấp` — thay `whereas expiry plus a wrong state yields 403, and a live lease with the correct epoch still grants`. | ✅ khớp nguyên văn draft |
| `docs/28:1400` | THÊM MỚI | Dòng CORRECTION (copy nguyên văn từ version C của draft, với định dạng blockquote `> `): `**CORRECTION 2026-10-09 (independent verify, DSH):** hai mệnh đề trên đã sai trước bản này — code thực thi trả 409 PERMISSION_DENIED cho declared cross-op STAGING (artifacts.ts:753-755) và 409 LEASE_LOST cho lease hết hạn (artifacts.ts:707); 403 PERMISSION_DENIED chỉ đến từ forbidden() (src/http/errors.ts:53) và hiện không được dùng trên đường đọc. Bằng chứng: 5 RED tại tests/artifact-read-authorization.test.ts:375,386,597,732,742; 2 tiến trình độc lập, exit 1.` | n/a — là dòng mới |
| `docs/28:1401` (trước là `:1400`) | THAY | **Verification (2026-10-09)**: suite hiện **5 failed, 85 passed, 90 total** (exit 1, node v24.21.0, 2 tiến trình độc lập, không flake); ba lần '90 passed' ghi ở đây là số **trước** khi lộ lệch hợp đồng docs↔code. `tsc --noEmit` ExitCode 0 với log 0 byte: vẫn đúng. — thay toàn bộ câu cũ `three consecutive runs, each 90 passed, 90 total, 1 suite passed…` | ✅ khớp nguyên văn draft |

**Git diff --stat confirm (docs/28):** 2 dòng thay, 1 dòng thêm = +3/-2 dòng; file dài từ 2211 → 2212 dòng (thêm đúng 1 dòng CORRECTION).

## GAP (nếu có)

- **Không có khoảng cách / thiếu khớp.** Tất cả ba mục A/B/C khớp nguyên văn đề xuất trong version C của draft, áp dụng được.
- **Lưu ý trung thực 1:** mệnh đề 2 của version C (được copy nguyên văn) giữ lại cụm `For leases, a wrong epoch plus an expired lease yields LEASE_LOST,` — đây là phần trong C được phép giữ, nên dòng :1399 mới có câu nhắc lại `LEASE_LOST` hai lần gần nhau. Tôi **không tự chỉnh sửa**; giữ nguyên đúng version C đã được độc lập verify.
- **Lưu ý trung thực 2:** version C không yêu cầu sửa dải dòng `(321-420)` ở :1397 (Bản thảo đánh dấu là ghi chú ngoài phạm vi) → tôi **không** sửa dòng đó.
- **Không chạy lại test/tsc** ở lượt này — vai trò là doc editor; :1401 ghi lại số liệu do hai lane trước đo (real exit 1, 2 tiến trình), không phải do tôi đo lại.

## Xác nhận

- **KHÔNG tick gate** nào. Không viết VERIFIED/ACCEPTED trong file đã sửa; không ở receipt này.
- **KHÔNG commit, KHÔNG `git add`, KHÔNG push.**
- **KHÔNG chạm** source/test/config. Không chạm `docs/04-data-state.md` (đang dirty, thuộc lease khác — xem `git status`).
- **OFFLINE.** Không đọc `.env.live`. Chỉ edit file text.