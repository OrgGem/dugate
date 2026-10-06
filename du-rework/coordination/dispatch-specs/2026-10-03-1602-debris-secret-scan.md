# Debris secret-scan (READ-ONLY) — 403 file debris đang tracked + `.openclaude`

**Packet:** debris-secret-scan | **Lane:** cc_1 | Dispatch 2026-10-03T16:02+07:00 (coordinator command-code).

**Nguồn:** `coordination/reports/wtv06-prep-2026-10-03.md` §1 — phát hiện **403 file `.qwen/tmp` + `.openclaude/settings.local.json` đang TRACKED từ HEAD**. Trước khi owner quyết untrack, cần biết debris này có chứa secret không (nếu có, chỉ untrack là chưa đủ — history vẫn giữ).

**Việc:**
1. Lấy danh sách tracked debris: `git ls-files .qwen .openclaude .qwen-tmp '*.bak' '*.tmp'` (và bất kỳ path debris nào trong receipt wtv06-prep §1).
2. Quét mẫu secret: `ghp_`, `github_pat_`, `-----BEGIN .*PRIVATE KEY`, `VAULT_TOKEN`, `s3_?secret`, `AKIA`, `sk-[A-Za-z0-9]{20,}`, `Bearer eyJ`, `password\s*[:=]`, `api[_-]?key\s*[:=]` — kèm loại trừ false-positive hợp lệ (test fixtures, ví dụ `sk-test`, `example`).
3. Phân loại mỗi hit: **thật (chỉ rõ file:line + loại)** / **giả (nêu lý do)** / **không kết luận**.
4. Tổng hợp: danh sách rủi ro + khuyến nghị cho từng nhóm (chỉ-untrack / cần purge history / purge+c rotate / an toàn).
5. Kiểm tra nhanh `.openclaude/settings.local.json` + `.claude/settings.local.json` (bản ignored) có chứa token/permission nào không.

**Ranh giới:** READ-ONLY tuyệt đối — không sửa/xóa/untrack bất cứ file nào. Chỉ ghi `du-rework/coordination/reports/debris-secret-scan-2026-10-03.md`. Không tick; không commit; không chạm `nocobase-10`.
