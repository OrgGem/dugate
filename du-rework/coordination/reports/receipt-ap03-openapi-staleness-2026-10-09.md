# AP-03 — OpenAPI staleness indicator (`api-docs-screen.tsx`) — 2026-10-09

**Lease (đúng 1 file):** `du-rework/orchestrator/apps/admin-web/src/features/api-docs/api-docs-screen.tsx`
**Plan:** `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`
**Không commit, không `git add`, không push, không tick gate, không sửa backend, không đụng file ngoài lease.**

## 1. Đọc trước khi sửa

`SpecBuildLabel` (cũ, dòng 59-73) chỉ hiện: `Spec build: <source> · N bytes · fingerprint <fp> · bundled at build time with zero runtime requests.` — có **nguồn + kích thước + fingerprint**, nhưng **không có gì nói về tình trạng tươi mới**. Người vận hành không biết bundle đang ở revision nào, cũ bao lâu, và nó đã tự khai thiếu gì.

## 2. Điều tra dữ liệu freshness thật (trước khi thiết kế)

Đọc `docs/21-openapi.json` (chỉ đọc, **không sửa**):

```text
TOP:  openapi, info, servers, tags, components, paths, x-absent, x-contract-models
INFO: version = "1.5.0"   title = "DUGate rework API (code-derived, W40-CX)"
TOPX: x-absent = [8 mục]   x-contract-models = {secretCatalog, callbackPolicy}
INFOX: (none)
```

**Kết luận quan trọng:** artifact **KHÔNG** mang timestamp sinh tài liệu — không có `x-generated-at`, `info.x-*` nào. Mà trang này **không gọi request nào** (hợp đồng zero runtime requests, cũng là assertion của harness). ⇒ **Không thể đo tuổi của bundle trên chính trang này.**

Vì vậy tôi **không bịa ngày build**. Thiết kế chọn 4 tín hiệu **thật**: (i) `info.version` = revision đã đóng gói, (ii) số phần tử `x-absent` = danh sách **do chính generator khai** là không phủ, (iii) fingerprint = mỏc so sánh với artifact regenerate tại máy, (iv) thời điểm bundle nạp vào trình duyệt. Trạng thái cuối đặt tên `snapshot · age unknown` — nói thẳng là **không đo được tuổi**, thay vì hiện một ngày giả.

## 3. Đã thêm (đúng trong lease)

| Dòng | Nội dung |
|---|---|
| 59-63 | `SPEC_VERSION`, `SPEC_ABSENT_COUNT` — đọc thẳng từ `PARSED.doc` (`info.version`, `x-absent.length`) |
| 65-104 | `type ApiDocsFreshness` + `FRESHNESS_BY_BUILD_STATE` / `FRESHNESS_LABEL` / `FRESHNESS_VARIANT` / `FRESHNESS_ADVICE` — 4 trạng thái: `artifact-missing`, `unreadable`, `version-unknown`, `snapshot-age-unknown` |
| 106-110 | `BUNDLE_LOADED_AT = new Date()` — chỉ đánh giá 1 lần mỗi lần nạp tài liệu. **Đã kiểm tra SSR:** grep `hydrateRoot|renderToString` trong `apps/admin-web/src` chỉ ra `main.tsx` dùng `createRoot` ⇒ client-only, nên mốc thời gian module-scope không thể lệch với thứ người dùng thấy |
| 112-121 | `freshnessSentence()` — ghép câu ở TS thay vì trong JSX, để separator tường minh và không phụ thuộc text node rỗng của JSX |
| 123-151 | `SpecBuildLabel` nâng cấp: p-tag thành div có `space-y-1`, giữ nguyên dòng cũ, **thêm dòng thứ hai** gồm Badge trạng thái + câu giải thích |

**Data attribute mới (để tự động hoá/scan được):** `data-api-docs-freshness`, `data-spec-version`, `data-spec-absent-count`, `data-bundle-loaded-at`, `data-api-docs-freshness-note`.

**Các attribute cũ giữ nguyên 100%:** `data-api-docs-build-label`, `data-api-docs-build-state`, `data-spec-source`, `data-spec-bytes`, `data-spec-fingerprint`.

## 4. Build check (bước 3) — có 1 sai lệch phải ghi rõ

**Lệnh đúng như packet KHÔNG chạy được** trong checkout này:

```text
> cd du-rework/orchestrator/apps/admin-web
> node ../../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Error: Cannot find module 'D:\Git\dugate\du-rework\node_modules\typescript\bin\tsc'   (MODULE_NOT_FOUND, exit 1)
```

`../../../` từ `apps/admin-web` trỏ tới `du-rework/`, nơi **không có** `node_modules/typescript`. Dùng **script của chính project** (`package.json:11` = `tsc --noEmit -p tsconfig.json`, `typescript ^5.6.0` ở devDependency) — cùng lệnh biên dịch: `pnpm --filter @du/admin-web typecheck`.

**Fail-first (trung thực):** lần chạy đầu **ĐỎ** — tôi để sót 1 dấu nháy kép trong array literal, tsc bắt được ngay:

```text
src/features/api-docs/api-docs-screen.tsx:136:61 - error TS1003: Identifier expected.
136       data-bundle-loaded-at={BUNDLE_LOADED_AT.toISOString()}"
src/features/api-docs/api-docs-screen.tsx:136:62 - error TS1002: Unterminated string literal.
src/features/api-docs/api-docs-screen.tsx:138:7  - error TS2657: JSX expressions must have one parent element.
Found 5 errors in the same file, starting at: src/features/api-docs/api-docs-screen.tsx:136
Exit status 2
```

**Sau khi sửa — XANH:**

```text
> @du/admin-web@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json
Exit Code: 0
```

## 5. Regression — không phá hợp đồng build-label đã có

Harness sẵn có `services/orchestrator/tests/api-docs-build-label-offline.cjs` (grep source + parse artifact thật):

```text
RESULT: PASS (24 passed, 0 failed, 24 total)
Exit Code: 0
```

Các assertion nhạy với thay đổi này đều xanh: `data-api-docs-build-label`, `data-spec-source`, `data-spec-bytes`, `data-spec-fingerprint`, `data-api-docs-build-state`, `bytes`, `fingerprint`, và đặc biệt **no fetch(**, `no XMLHttpRequest`, `no axios`, `SPEC_FINGERPRINT = apiDocsSpecFingerprint(specRaw)` — xác nhận thay đổi freshness **không** làm mất bất kỳ cam kết nào của OPU-REF-1.

## 6. GAP / cần coordinator biết

1. **Sự cố mtimes khi sửa (không đoán nguyên nhân).** Lệnh sửa dấu nháy sót của tôi bị `edit` **từ chối** với lý do *file has been modified since you last read it*. Đọc lại thì dấu nháy sót **đã biến mất** và typecheck xanh. Tôi **không xác định được** ai đã xóa: hoặc guard của công cụ chặn nhưng thay đổi vẫn áp dụng, hoặc có tiến trình khác trên file dùng chung. **Điểm cần lưu ý:** file này **đang dirty sẵn từ lane khác** (điểm 2), nên có tiến trình song song trên cùng file là khả thi — nên soi lại trước khi giao lane khác chạm cùng file.
2. **`git diff` vs HEAD không thuộc một mình tôi.** File đã ` M` **trước khi tôi bắt đầu** với công việc chưa commit của lane OPU-REF-1 (SPEC_SOURCE, SPEC_RAW_BYTES, fingerprint FNV-1a, BUILD_STATE, nhánh `missing-artifact`, `data-api-docs-empty-filter`, và dòng comment route `(admin/api-docs)`). Phần **của tôi** chỉ là các dòng **59-63, 65-121, 123-151** đã liệt kê ở mục 3. Không tự nhận công cho phần còn lại.
3. **Không có tuổi bundle thật** — đã nêu ở mục 2. Nếu muốn hiện built-at, cần generator ghi timestamp vào `docs/21-openapi.json` (**ngoài lease**, tôi không đụng file đó theo yêu cầu).
4. **Không có test mới cho phần freshness** — task giao là smoke receipt, không yêu cầu test. Regression dựa vào harness có sẵn (24/24). Đề xuất follow-up (chưa làm): thêm assertion cho `data-api-docs-freshness`, `data-spec-version`, `data-spec-absent-count` vào file harness đó.
5. **`x-contract-models` chưa dùng** — có 2 ghi chú thiếu sót trong artifact (`secretCatalog`, `callbackPolicy`) nhưng tôi chỉ đếm `x-absent`. Mở rộng sang nó nằm ngoài ý nghĩa nhỏ nhất của task, nên để lại.

## 7. Xác nhận

- Sửa **đúng 1 file** trong lease: `apps/admin-web/src/features/api-docs/api-docs-screen.tsx`. Không file nào khác.
- **Không sửa backend. Không sửa `docs/21-openapi.json`** (chỉ đọc để điều tra). Không đụng màn hình khác.
- **Không commit, không `git add`, không push. Không tick gate**, không ghi VERIFIED/ACCEPTED.
