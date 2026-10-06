# CURL-SPEC-FIX — p730-curl-import.spec CJS-safe — cc_2 — 2026-10-04

**Packet:** coordinator 23:12 (+07) (từ bonus finding §5 của P745-UI-KEYS). **Mode:** offline; no commit; chỉ sửa **1 file spec** (load-fix), không đụng source/UI.

---

## 0. TL;DR

`tests/browser/admin-web/p730-curl-import.spec.ts` không load được dưới `admin-web/playwright.config.ts` vì `fileURLToPath(new URL(..., import.meta.url))` (config transpile **CJS** → `import.meta` ngoài module). Đã chuyển sang `__dirname` + `join` (đúng pattern của `p745-ui-keys.spec.ts`). Sau fix: **16/16 test pass ×3 liên tiếp, exit 0** — spec chạy THẬT trong playwright harness (không cần node-checker thay thế như receipt curl-import cũ), và **collection full-dir sạch** (`--list`: Total: 72 tests in 9 files, exit 0 — trước đó p730 làm toang collection).

## 1. File đã sửa

| File | Vị trí | Việc | sha16 |
|---|---|---|---|
| `tests/browser/admin-web/p730-curl-import.spec.ts` | `:2` import, `:24-29` paths | `node:url`→`node:path`; 3 × `fileURLToPath(new URL(..., import.meta.url))` → `join(SPEC_DIR, ...)` + `const SPEC_DIR = __dirname` | `6AC12735B6FC79D4` |

Diff tóm tắt (không kèm source khác — packet giới hạn đúng load-fix):
```diff
-import { fileURLToPath } from "node:url";
+import { join } from "node:path";
-const PARSER_PATH  = fileURLToPath(new URL("...curl-import.ts",        import.meta.url));
-const PREVIEW_PATH = fileURLToPath(new URL("...curl-import-preview.tsx", import.meta.url));
-const SCREEN_PATH  = fileURLToPath(new URL("...connectors-screen.tsx", import.meta.url));
+const SPEC_DIR = __dirname;
+const PARSER_PATH  = join(SPEC_DIR, "....curl-import.ts");
+const PREVIEW_PATH = join(SPEC_DIR, "....curl-import-preview.tsx");
+const SCREEN_PATH  = join(SPEC_DIR, "....connectors-screen.tsx");
```

## 2. Evidence literal

```
## Load-fix trước/sau (cùng lệnh, cùng config)
TRƯỚC:  npx playwright test --config admin-web/playwright.config.ts --grep "P745-UI-KEYS"
        → Warning: Failed to load the ES module: p730-curl-import.spec.ts
        → SyntaxError: Cannot use 'import.meta' outside a module   (exit 1)

SAU:    npx playwright test --config admin-web/playwright.config.ts admin-web/p730-curl-import.spec.ts
  RUN 1: 16 passed (718ms)  exit=0
  RUN 2: 16 passed (553ms)  exit=0
  RUN 3: 16 passed (546ms)  exit=0

## Collection full-dir (không execute):
npx playwright test --config admin-web/playwright.config.ts --list
  Total: 72 tests in 9 files     exit=0   (không còn SyntaxError nào)
```
**16 test của spec = chính 14 case parser + 2 static guard đã mô tả trong `p730-curl-import-2026-10-04.md`** (không phải test mới) — giờ được chạy đúng cách thay vì chỉ qua node-checker.

## 3. Finding từ bước 3 (test fail?)

**Không.** 16/16 pass, không case nào fail vì fixture/UI → **không có finding mới, không cần gap mới**. Lưu ý: 2 static guard (test 14-15 mount CurlImportPreview trong ConnectorsScreen) đọc source THẬT và pass → phần "mount + accept-only wiring" vẫn nguyên vẹn sau các packet sau đó (P745-UI-KEYS không chạm connectors).

## 4. Boundary / limitations

- Chỉ 1 file spec + receipt này. **0 chạm** source app/UI (đúng yêu cầu).
- **Full-dir RUN** (không `--list`) vẫn sẽ fail khi thiếu env `AWEB01B_URL/TOKEN/EVIDENCE/AWEB03B_STUB/VIEWER` — đó là guard `beforeAll` cố ý của các spec harness-seam (profiles/overview/operations/…), không phải vấn đề load nữa. Muốn chạy full-dir cần harness env (LIVE-prep, ngoài packet này).
- Test 14-16 pin mount/redaction tĩnh/qua summarize; "bấm modal trong browser thật" vẫn là gap LIVE đã ghi ở receipt curl-import §5 — giữ nguyên, không thay đổi đánh giá.
