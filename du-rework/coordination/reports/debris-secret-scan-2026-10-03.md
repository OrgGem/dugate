# Debris secret-scan — 403 file `.qwen/tmp` tracked + `.openclaude` (READ-ONLY)

**Packet:** debris-secret-scan · **Lane:** cc_1 · **Date:** 2026-10-03 · **Dispatch:** 2026-10-03T16:02+07:00 (coordinator command-code).
**Nguồn:** `coordination/reports/wtv06-prep-2026-10-03.md` §1 (phát hiện 403 file `.qwen/tmp` + `.openclaude/settings.local.json` **đang TRACKED từ HEAD**).
**Status:** READ-ONLY tuyệt đối — không sửa/xóa/untrack bất kỳ file nào; không tick gate (mọi gate giữ **NO-GO**), không commit, không chạm `nocobase-10`. File duy nhất được ghi: receipt này.

## 0. Phạm vi + phương pháp (literal)

```
cwd: D:\Git\dugate
git ls-files .qwen .openclaude .qwen-tmp '*.bak' '*.tmp' '*.log'
  → 404 tracked files: 403 × .qwen/tmp + 1 × .openclaude/settings.local.json
  → extension: 186 .js, 103 .log, 40 .txt, 28 .md, 20 .ps1, 11 .json, 11 .ts, 3 .cjs, 1 .bak, 1 .bin
  → tổng 1.790.196 bytes, tất cả đã được quét
2 lớp quét:
  (a) Select-String (text) theo bộ pattern của dispatch + pattern mở rộng;
  (b) byte-level latin1 regex trên TOÀN BỘ 404 file (gồm .bin/.bak);
  (c) kiểm tra NUL-byte để chắc không bỏ sót file UTF-16 → 0 file chứa NUL (không file nào cần decode UTF-16).
```

Bộ pattern: `ghp_`, `github_pat_`, `-----BEGIN .*PRIVATE KEY`, `VAULT_TOKEN`, `s3_?secret`, `AKIA`, `sk-[A-Za-z0-9]{20,}`, `Bearer eyJ`, `password\s*[:=]`, `api[_-]?key\s*[:=]`, `du_/dg_` khóa dài ≥32, `xox[baprs]-`/`glpat-`/`npm_`, `AIza`, `minioadmin`, URL-credential catch-all `scheme://user:pass@`, plus tên biến: `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VAULT_ADDR/TOKEN`, `POSTGRES_PASSWORD`, `MYSQL`, `JWT_SECRET`, `SESSION_SECRET`, `secretKey`, `client_secret`, `PRIVATE_KEY`, `AWS_SECRET`.

## 1. Kết quả quét (tổng hợp)

| pattern / sweep | hits | phân loại | bằng chứng |
|---|---|---|---|
| `ghp_` | 0 | — | — |
| `github_pat_` | 0 | — | — |
| `-----BEGIN .*PRIVATE KEY` | 0 | — | (sanity: cùng scanner bắt được 2 hit ở file ngoài debris `delivery-encryption.test.ts` — method tin cậy) |
| `VAULT_TOKEN`, `VAULT_ADDR` | 0 | — | — |
| `s3_?secret`, `s3_secret`, `secret_key`, `secretKey`, `client_secret` | 0 | — | — |
| `AKIA[0-9A-Z]{16}` | 0 | — | — |
| `sk-…{20,}`, `Bearer eyJ`, `xox[baprs]-`, `glpat-`, `npm_`, `AIza` | 0 | — | — |
| `password\s*[:=]` / từ "password" | 0 / 1 | **giả** | `.qwen/tmp/tester-corrupted.bak:7185`: "…MINIO_ROOT_USER, MINIO_ROOT_PASSWORD; **values intentionally omitted**" |
| `api[_-]?key\s*[:=]` | 0 | — | — |
| `du_[A-Za-z0-9_-]{24,}` | 4 text + 3 byte-level | **giả** | toàn **schema/run-id**: `du_test_p801_c126_20260925_1201_a91f` (tester-corrupted.bak:6283,6285,6313,7057) |
| `dg_…{24,}` | 0 | — | — |
| `postgresql://` / URL-cred catch-all | 7 / **7** | **giả** | duy nhất `postgresql://du:du-test-only@localhost:5433/du_orchestrator_test` (tester-corrupted.bak:6604,7383,7403,7518,7529,7537,…) — test-only default đã có sẵn trong repo/docs |
| `redis://` | 30 | **giả** | `redis://localhost:6380` — không nhúng credential |
| `Bearer ` | 12 | **giả** | prose/code: `` Bearer ${RUNTIME_TOKEN} `` (template), mô tả 401/403 trong receipt — 0 literal token (`Bearer [A-Za-z0-9_.-]{16,}` = 0) |
| Log chứa token | 0 thật | **giả** | log đã redact sẵn: `"runtimeToken":"[REDACTED]"` (`.qwen/tmp/d24-base-dc.log:48`…) — redaction hoạt động |
| `test-*-token-` (ephemeral test tokens) | 0 | — | — |
| `MINIO` / `ROOT_PASSWORD` / `AWS_SECRET` | 13 / 1 / 2 | **giả** | toàn văn bản pilot: "Root credential variable names present… **values intentionally omitted**"; "Secret values omitted" (`tester-corrupted.bak:7258,7509`) |
| `minioadmin`, `POSTGRES_PASSWORD`, `MYSQL`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `JWT_SECRET`, `SESSION_SECRET`, `PRIVATE_KEY` | 0 | — | — |
| Byte-level hard-pattern sweep (tất cả 404 file, gồm `.bin`/`.bak`) | **3** | **giả** | chỉ 3 × `du_test_p801_c126_…` (schema names) trong `tester-corrupted.bak` |

**Phân loại: THẬT = 0 · GIẢ = toàn bộ hit nêu trên · KHÔNG KẾT LUẬN = 0.**

Chi tiết 2 file nhị phân/đuôi lạ:
- `.qwen/tmp/f3-backup-c15.bin` (18.6 KB) — thực chất là text, mở đầu `import {` (backup source bị đặt tên .bin); đã quét byte-level, 0 hit.
- `.qwen/tmp/tester-corrupted.bak` (421.5 KB, UTF-8 BOM) — bản receipt tester bị hỏng; chứa tên biến/env + endpoint localhost + run-id; **không giá trị secret nào** (các mục nhạy cảm tự ghi "omitted").

## 2. Kiểm tra `.openclaude` / `.claude`

- `.openclaude/settings.local.json` (**tracked**, 12 dòng): chỉ có `permissions.allow` = 5 rule (`Bash(grep …)`, `Bash(done)`, `Bash(npx jest:*)`, `Bash(npx tsc:*)`) + `spinnerTipsEnabled:false`. **Không token/secret**; không có rule nguy hiểm (không `Bash(rm:*)`, không network). Untrack là tuỳ chọn (bản `.claude/settings.local.json` đã nằm trong `.gitignore`; file này là bản mirror bị tracked).
- `.claude/settings.local.json`: **không tồn tại trên đĩa** (dù có dòng ignore) — không có gì để quét.

## 3. Rủi ro + khuyến nghị theo nhóm

| nhóm | kết luận | khuyến nghị |
|---|---|---|
| 403 file `.qwen/tmp` (tracked) | Không chứa secret thật; chỉ có: test DB default `du:du-test-only@localhost` (đã public trong repo), prose/log đã redact, run-id, backup source/schema | **Chỉ-untrack là đủ về mặt an ninh** (`git rm --cached -r .qwen/tmp` khi owner quyết; giữ ignore như WTV-06 prep). **Không bắt buộc purge history.** Nếu vẫn muốn sạch lịch sử vì lý do gọn nhẹ thì đó là quyết định hygiene, không phải security |
| `.openclaude/settings.local.json` (tracked) | Chỉ allowlist quyền — không secret | Untrack tuỳ chọn (đối xứng `.claude/settings.local.json`); nếu giữ cũng an toàn |
| Rotate credential | — | **Không cần rotate** bất kỳ credential nào: 0 credential thật trong debris |
| Purge history | — | **Không cần** trên cơ sở an ninh; nếu coordinator vẫn muốn, cần owner sign-off riêng (ngoài packet này) |

## 4. Method limits

- Đây là **regex dry-run** (text + byte-level latin1), không phải entropy/DLP scanner đầy đủ; kết luận "sạch" áp dụng cho **tập 404 file tracked hiện tại** (đúng nội dung đang có trong HEAD/index — file trên đĩa được quét trực tiếp).
- **Không quét blob lịch sử sâu hơn HEAD** (các commit cũ hơn có thể từng chứa bản khác) — ngoài scope packet; nếu cần, phải quét riêng `git log -p`/history scan.
- 0 file chứa NUL-byte ⇒ không có file UTF-16 nào bị scan trượt; file `.bin` thực chất là text nên cũng được phủ.
- Sanity check scanner: cùng method phát hiện đúng 2 hit `-----BEGIN` trong `du-rework/services/orchestrator/tests/delivery-encryption.test.ts` (ngoài debris) — chứng minh bộ lọc hoạt động trước khi kết luận 0-hit.

## 5. Verdict

**CLEAN** — 404 tracked debris files (1.79 MB) không chứa secret thật: hard-pattern byte-level sweep chỉ 3 hit (run-id/schema), toàn bộ hit khác là test-only default DB URL, prose/template, và log đã redact (`[REDACTED]`). Không cần rotate, không cần purge history trên cơ sở an ninh; **untrack-only là đủ** cho nhóm `.qwen/tmp` (và tuỳ chọn cho `.openclaude/settings.local.json`). READ-ONLY giữ nguyên: không file nào bị sửa/xóa/untrack.
