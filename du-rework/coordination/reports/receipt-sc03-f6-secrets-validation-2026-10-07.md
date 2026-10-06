# Receipt: SC-03 / F6 — client validation pinned Vault version (Secrets Screen)

- **Task:** dispatch sửa F6 (Vault version NaN → null trên wire) tại `apps/admin-web/src/features/secrets/secrets-screen.tsx`.
- **Recipient:** oc_4 (term_ff912d69-95a4-4ab7-9faf-89ff75b91739) · **Thời điểm:** 2026-10-07 ~01:10 · **HEAD:** `4308cc54eda32cfcca54e0c55554fc85d720a43b` · Node v22.16.0.
- **Code freeze:** không commit, không push. Không tạo/sửa file nào ngoài receipt này.

## 1. Kết quả chính: fix F6 ĐÃ hiện hữu trong working tree (uncommitted, +33 dòng) — vai trò của lượt này là kiểm chứng

Khi mở file trong lease, toàn bộ nội dung dispatch yêu cầu đã có sẵn dưới dạng diff uncommitted so với HEAD (33 insertions; tôi **không** claim authorship — file này không nằm trong danh sách modified ở lần kiểm git status trước đó ~30 phút, nghĩa là sửa đổi vừa được một worker khác áp vào tree gần đây; dispatcher nên đối chiếu để tránh giao trùng lease). Tôi không chồng sửa; phần việc còn lại là đối chiếu spec ↔ implementation và chạy integrity.

### Diff hiện trường (`git diff HEAD -- …/secrets-screen.tsx`, exit 0)

Hai hunk, tổng +33 dòng:

1. **Helper `parsePinnedVersion(raw)` (sau `emptyCreateDraft`, dòng 80-95):** `trim()` → `/^\d+$/` → `Number.isSafeInteger(version) && version >= 1`, sai thì trả `null`. Comment giải thích rõ gốc bug: `Number('')/Number('abc')/Number('1.5')` → NaN → `JSON.stringify` → `null`.
2. **Guard trong `submitCreate()` (dòng 163-178):** khi `providerKind === 'vault_reference' && versionMode === 'pinned' && parsePinnedVersion(...) === null` → **refuse submit TRƯỚC khi build payload**, set `createError` 422 `INVALID_VERSION` với `pointer: '/provider/version'` và message nêu rõ giá trị nhận được (`an empty value` hoặc chuỗi raw qua `JSON.stringify`). Payload builder phía sau (`Number(draft.version)`) vì vậy không bao giờ chạy với input invalid.

## 2. Đối chiếu yêu cầu dispatch ↔ implementation

| Yêu cầu | Trạng thái | Bằng chứng |
|---|---|---|
| Trim + regex `/^\d+$/` + `> 0` | ✅ (chặt hơn: thêm `Number.isSafeInteger`, chặn cả `1.5` và số tràn) | `secrets-screen.tsx:89-95` |
| Không hợp lệ → báo lỗi trên form hoặc chặn submit, không gửi NaN | ✅ Chặn submit + banner lỗi 422 `INVALID_VERSION` hiển thị trong modal (AlertBanner đã có sẵn render `createError` với list pointer) | `:163-178` + `:456-467` |
| Nút Save "có thể disable **hoặc** báo lỗi rõ ràng" | ✅ Chọn nhánh "báo lỗi rõ ràng" (dispatch cho phép một trong hai). Không thêm disable vào nút Save (`:441-447`): nút bị disable sẽ giấu lý do, còn banner nêu đúng field và giá trị sai — UX tốt hơn và không tạo hai cơ chế song song | quyết định có chủ đích, ghi tại đây |

## 3. Kiểm tra tính toàn vẹn (đã chạy thật, cwd `du-rework/apps/admin-web`)

| # | Lệnh | exit | Kết quả |
|---|---|---|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | không lỗi type |
| 2 | `node node_modules/vite/bin/vite.js build` | 0 | built in 11.19s; chỉ còn cảnh báo chunk >500 kB (pre-existing, không liên quan F6) |
| 3 | `git diff --check HEAD -- …/secrets-screen.tsx` (cwd repo root) | 0 | không whitespace/conflict marker |

## 4. Kết luận và hàm ý

1. **F6 đã được khắc phục đúng spec ở mức client**: pinned version rỗng/không phải số nguyên dương không thể thành `NaN`/`null` trên wire; người dùng nhận thông báo lỗi tại chỗ với pointer `/provider/version`.
2. Trạng thái packet: **IMPLEMENTED + integrity smoke PASS** (typecheck + build exit 0). Chưa VERIFIED theo nghĩa browser e2e — nếu gate yêu cầu, cần browser packet bấm thử form (nhập rỗng/`abc`/`1.5` ở chế độ pinned → submit → thấy banner, request không rời trình duyệt).
3. Lưu ý điều phối: sửa đổi +33 dòng xuất hiện trong tree trong khoảng <1 giờ qua bởi worker khác — nếu dispatcher có packet F6 song song, kiểm chứng lease để tránh hai writer cùng file.

---

# APPEND — fix thực hiện bởi qwen_1 (term_7cb640ae…) · 2026-10-07

> **Lưu ý lease (gây ra bởi mục 4 ở trên):** phần trên là receipt của **oc_4** (term_ff912d69…). Tôi (**qwen_1**) cũng được dispatcher giao lease file **"F6 — fixes secrets-screen.tsx"** — tức **2 worker cùng nhận lease 1 file**. Tôi APPEND thay vì ghi đè để giữ nguyên receipt trước. Dispatcher cần chốt ai là writer chính của F6; hiện **không có conflict text** (§C.1).

## A. Scope

- Repo: `du-rework` ONLY · Lease: `apps/admin-web/src/features/secrets/secrets-screen.tsx`
- **NO commit, NO push.** `git diff --staged --stat` = rỗng tại thời điểm xuất receipt.

## B. Thay đổi (diff vs HEAD: +51 / −2, 4 hunk)

oc_4 ghi nhận 2 hunk (+33) và *chủ đích* chọn nhánh "báo lỗi" **thay vì** "disable Save". Tôi thêm tầng thứ ba mà dispatch yêu cầu ("chặn submit / hiển thị lỗi / disable Save"):

| # | Vị trí | Thay đổi |
|---|---|---|
| 1 | `:79-95` | helper `parsePinnedVersion` (trim → `/^\d+$/` → `Number` → `Number.isSafeInteger && >= 1`) — có ở cả hai lượt |
| 2 | `:161-163` | **MỚI** — derived `pinnedVersionInvalid` |
| 3 | `:169-178` | **MỚI** — guard trong `submitCreate` refuse TRƯỚC khi build payload → 422 `INVALID_VERSION`, `pointer /provider/version`, `setBusy(false)`, `return`; `client.createSecret` không bao giờ được gọi |
| 4 | `:197` | payload: `Number(draft.version)` → `parsePinnedVersion(draft.version)!` |
| 5 | `:455-457` | **MỚI** — Save `disabled` thêm `|| pinnedVersionInvalid` |
| 6 | `:576-582` | **MỚI** — `FormField error` inline trên Version field |

Cả 6 hunk đều nằm trong cùng một file lease.

## C. Bằng chứng (đã chạy thật)

### C.1 Không trùng lặp / không đè (dual-writer check)

```
rg -n "function parsePinnedVersion|const pinnedVersionInvalid|INVALID_VERSION|parsePinnedVersion\(" secrets-screen.tsx
  :89  function parsePinnedVersion        <-- ĐÚNG 1 lần, không double-define
  :161 const pinnedVersionInvalid
  :172 guard
  :175 INVALID_VERSION
  :197 payload use
rg -c "SC-03 / F6"  --> 4 (helper doc, flag, guard, Save-disable) — toàn bộ là của tôi
rg -l "parsePinnedVersion|pinnedVersionInvalid|SC-03 / F6" du-rework/apps/admin-web/src
  --> CHỈ features/secrets/secrets-screen.tsx
```

### C.2 Behaviour probe (chạy `node -e` với chính thân helper)

| input | result |
|---|---|
| `""` / `"0"` / `"-1"` / `"1.5"` / `"abc"` / `"1e5"` / `"0x10"` / `"Infinity"` / `"9007199254740993"` | **null** (bị chặn) |
| `"3"` | 3 |
| `"007"` | 7 |
| `" 4 "` | 4 |

`NaN leaked: false` — không input nào có thể thành `NaN` trong payload, nên không thể serialise ra `null` trên wire.

### C.3 Integrity (cwd `du-rework/apps/admin-web`)

| # | Lệnh | exit |
|---|---|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** (không lỗi type) |
| 2 | `npm run build` (`tsc --noEmit && vite build`) | **0** — `BUILD_EXIT=0`; `dist/assets/index-8a2FA9k7.js 874.14 kB` |
| 3 | `git diff --staged --stat` (repo root) | 0 (rỗng — không staged) |

## D. Khác biệt giữa hai lượt (để dispatcher biết ai quyết gì)

- **oc_4**: chỉ chặn submit + banner lỗi; *chủ đích* không disable Save (mục 3 receipt trên).
- **qwen_1**: thêm **disable Save + inline `FormField error`** → cả 3 điều kiện dispatch nêu đều thoả.
- Muốn giữ đúng lựa chọn của oc_4 → yêu cầu tôi revert 2 hunk (5) và (6); chúng **hoàn toàn tách rời** khỏi (1)-(4).
- **Không thêm unit test**: `apps/admin-web` không có test runner (không có test script / vitest / jest trong `package.json`), và `package.json` ngoài lease. Nếu gate cần test file → cần lease riêng cho harness.

## E. Trạng thái

**IMPLEMENTED + integrity smoke PASS (typecheck 0, build 0).** Chưa VERIFIED ở mức browser e2e (nhập rỗng/`abc`/`1.5` ở pinned → submit → banner hiện, request không rời trình duyệt) — packet đó chưa được giao. Code freeze giữ nguyên: **0 commit, 0 push**.
