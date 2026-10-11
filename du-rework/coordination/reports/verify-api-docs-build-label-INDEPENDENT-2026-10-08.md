# VERIFY ĐỘC LẬP — OPU-REF-1: build label cho API Reference screen — 2026-10-08

**Vai trò:** verify độc lập (chỉ đọc). **Quy tắc đã tuân thủ:** KHÔNG sửa source, KHÔNG sửa test, KHÔNG commit / `git add` / push, KHÔNG tick gate, KHÔNG hand-edit `docs/21-openapi.json` (file vẫn sạch trong working tree), offline — không chạy PostgreSQL/Redis, không claim DB window; không đọc/in `.env.live`; bỏ qua nocobase. Scope: `du-rework` only.
**Deliverable:** đúng một file — receipt này.
**Revision lúc chạy:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` · Node `v22.23.3` · cwd mỗi lệnh ghi trong bảng.
**Digest nội dung đã kiểm (SHA-256):**

| File | Digest | Trạng thái |
|---|---|---|
| `apps/admin-web/src/features/api-docs/api-docs-screen.tsx` | `eb75603311c454e7f3518d0f230e44c35832b4f83897400ae7d001dce6ce5a3f` | ` M` (OPU-REF-1, chưa commit) |
| `apps/admin-web/src/features/api-docs/openapi-types.ts` | `f2a8083fb3ecca558224878b26a6797831c79eb5100a5e237f497e4a1c9a41e7` | tracked, sạch |
| `apps/admin-web/src/features/overview/overview-screen.tsx` | `137f3507015087c31104a1dd6212f12fa186f045654d0b73bcc88970b35e0ed2` | ` M` (**lane khác**, xem FAIL) |
| `services/orchestrator/tests/api-docs-build-label-offline.cjs` | `c79da94423f82baf27301400ebea7dc180e3c3de6da024ba3d2b579f0cb00c20` | `??` (untracked) |
| `docs/21-openapi.json` | `661703ed1251792b3f25a2de6da09d14b4c718a8f4be20644aee2b4b9459004e` | tracked, **sạch** (không bị hand-edit) |

## 1. Bảng lệnh + exit code + literal

| # | Command (cwd) | Exit | Literal |
|---|---|---:|---|
| 2 | `node tests/api-docs-build-label-offline.cjs` (`orchestrator/services/orchestrator`) | **0** | `RESULT: PASS (24 passed, 0 failed, 24 total)` — 24 dòng `PASS …` (bao gồm `screen imports docs/21-openapi.json with ?raw`, `build-state attribute rendered`, `state 'ok'/'parse-error'/'missing-artifact' present`, `empty import detected before parsing (trim length check)`, `empty-filter marker data-api-docs-empty-filter`, `no fetch(`, `no XMLHttpRequest`, `no axios`, `spec declares openapi 3.x`, `fingerprint helper is deterministic (FNV loop present)`) — **đạt kỳ vọng PASS/exit 0** |
| 4 | `pnpm --filter @du/admin-web typecheck` (`orchestrator/apps/admin-web`) | **2** | **RED** — `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL … Exit status 2`, 10 lỗi `error TS6133` (liệt kê nguyên văn ở §4) — **KHÔNG đạt kỳ vọng exit 0** |
| 6 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`orchestrator/services/orchestrator`) | **0** | **không output** — **đạt kỳ vọng exit 0** |

*Disclosure (lệnh 2):* lần gọi đầu tiên cũng **exit 0** nhưng pipeline của tôi (`ForEach-Object { $_.Line }` trên chuỗi thô) đã nuốt hết text; tôi chạy lại để lấy literal — cùng exit code, không đổi trạng thái, không có lần chạy đỏ nào bị che. Lệnh 4/6 chạy đúng một lần.

## 2. Kết quả đọc code — `api-docs-screen.tsx`

### 2.1 Ba trạng thái + phân biệt "artifact rỗng" với "filter rỗng" → **CÓ phân biệt**

- Kiểu trạng thái: `:48` `type ApiDocsBuildState = 'ok' | 'parse-error' | 'missing-artifact';`
- Quyết định trạng thái ở **module scope**: `:56-57`
  `const BUILD_STATE = specRaw.trim().length === 0 ? 'missing-artifact' : PARSED.ok ? 'ok' : 'parse-error';`
- **`missing-artifact`** (import sai đường dẫn / artifact rỗng): card riêng `:101-119`, `SpecBuildLabel state="missing-artifact"`, `role="alert"` với copy "Empty spec import: the `?raw` import path or the generated artifact is wrong. Rebuild after regenerating `docs/21-openapi.json`…".
- **`parse-error`** (có byte nhưng không phải OpenAPI dùng được): card riêng `:120-135`, `SpecBuildLabel state="parse-error"`, hiện `PARSED.error` (`:130`).
- **`ok`** → `ApiDocsView` (`:136`).
- **Filter rỗng là trạng thái thứ tư, tách hẳn**: trong `ApiDocsView` (chỉ tới được khi `BUILD_STATE==='ok'`), `:278-285` khi `filtered.length === 0` render `data-api-docs-empty-filter="true"` với `No operation matches the current filter ({filtered.length} of {entries.length} operations shown…)` + nêu search/family đang bật + "clear the filter to see all {entries.length} operations".
- ⇒ **Phân biệt được**: khác nhánh code, khác DOM marker (`data-api-docs-build-state="missing-artifact"` vs `data-api-docs-empty-filter="true"`), khác copy; trạng thái filter còn in **0 of N** để chứng minh artifact đã load (N>0), còn `missing-artifact` không có `entries` nào để đếm.

### 2.2 Fingerprint → **hash non-crypto, và ĐƯỢC ghi rõ là non-crypto**

- Hàm: `:36-43` `apiDocsSpecFingerprint` = **FNV-1a 32-bit** (`hash ^= raw.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0;` → hex 8 ký tự, `:42`), tính ở module scope: `:45` `const SPEC_FINGERPRINT = apiDocsSpecFingerprint(specRaw);`
- Ghi rõ non-crypto: doc comment `:31-35` — *"Non-cryptographic FNV-1a fingerprint of the bundled spec text. It lets an operator compare the spec a running build actually shipped against a locally generated artifact; **it is not a security primitive**."*
- Lưu ý chính xác: caveat "non-crypto" nằm ở **comment source**, còn **label hiển thị** (`:69-70`) chỉ nói `fingerprint <code>…</code> · bundled at build time with zero runtime requests` — label không tự nhận là crypto, nhưng cũng không in chữ "non-crypto". Không phải FAIL; chỉ là khác biệt giữa tài liệu-trong-code và chữ trên UI.

### 2.3 Spec lấy từ `docs/21-openapi.json` lúc build, **không có runtime request** → **XÁC NHẬN**

- `:2` `import specRaw from '../../../../../../docs/21-openapi.json?raw';` — Vite `?raw` ⇒ artifact được nhúng vào bundle **lúc build** (không phải URL, không phải import động).
- `:18-22` doc khẳng định: *"imported as a raw string at build time so the spec ships inside the Portal bundle and loads offline from the image. There is no CDN download and no runtime BFF proxy; the page performs zero requests. Try-it-out is intentionally not implemented: nothing here sends a request or a credential."*
- Parse + fingerprint + byte count đều tính ở **module scope** (`:29`, `:45-46`) — không `useEffect`, không state load.
- Đọc hết file: **không có** `fetch(`, `XMLHttpRequest`, `axios` (harness cũng assert 3 điều này ở `:81-83` của harness).
- Byte size lấy từ chính string đã bundle: `:29` `new TextEncoder().encode(specRaw).length` → label in `{SPEC_RAW_BYTES} bytes` (`:66`, `:69`).

## 3. Verdict

- **OPU-REF-1 (target) đạt**: harness offline **24/24 PASS, exit 0**; `api-docs-screen.tsx` **không có lỗi TS nào** trong output typecheck (mọi lỗi đều thuộc file khác — §4); service `tsc --noEmit` **exit 0**; đọc code xác nhận đủ 3 câu hỏi (ba trạng thái + filter tách biệt, fingerprint FNV-1a có ghi chú non-crypto, build-time `?raw` + zero runtime request).
- **Một gate đỏ ngoài target**: `pnpm --filter @du/admin-web typecheck` **exit 2** vì `overview-screen.tsx` của **lane khác** — không sửa gì (read-only), báo nguyên văn dưới đây.
- **Không tick gate nào.** Không sửa file nào ngoài receipt này.

## 4. FAIL (trung thực, nguyên văn)

**Lệnh 4 — `pnpm --filter @du/admin-web typecheck` — exit code 2** (kỳ vọng 0). Toàn bộ 10 lỗi nằm trong **một file không thuộc OPU-REF-1**:

```
src/features/overview/overview-screen.tsx(4,1): error TS6133: 'Button' is declared but its value is never read.
src/features/overview/overview-screen.tsx(161,7): error TS6133: 'AUTO_REFRESH_MS' is declared but its value is never read.
src/features/overview/overview-screen.tsx(177,10): error TS6133: 'DataAgeLabel' is declared but its value is never read.
src/features/overview/overview-screen.tsx(197,10): error TS6133: 'autoRefresh' is declared but its value is never read.
src/features/overview/overview-screen.tsx(197,23): error TS6133: 'setAutoRefresh' is declared but its value is never read.
src/features/overview/overview-screen.tsx(198,10): error TS6133: 'stale' is declared but its value is never read.
src/features/overview/overview-screen.tsx(198,17): error TS6133: 'setStale' is declared but its value is never read.
src/features/overview/overview-screen.tsx(199,10): error TS6133: 'lastSuccessAt' is declared but its value is never read.
src/features/overview/overview-screen.tsx(199,25): error TS6133: 'setLastSuccessAt' is declared but its value is never read.
src/features/overview/overview-screen.tsx(203,10): error TS6133: 'lastSuccess' is declared but its value is never read.
```

- Expected: `exit 0`, không output. Received: `exit 2`, 10 × `TS6133` (unused declarations) — `admin-web/tsconfig.json` bật `noUnusedLocals` + `noUnusedParameters`.
- **Không do OPU-REF-1**: (i) không lỗi nào ở `api-docs-screen.tsx`/`openapi-types.ts`; (ii) `overview-screen.tsx` có diff **chưa commit +42 dòng** (mtime 14:32:13) thêm `Button`, `AUTO_REFRESH_MS`, `DataAgeLabel`, các state `autoRefresh/stale/lastSuccessAt/lastSuccess` nhưng chưa dùng — một tính năng auto-refresh/data-age đang làm dở của lane khác; (iii) target OPU-REF-1 là `features/api-docs/*`, không liên quan file này.
- **Không sửa gì để xanh, không nới assertion, không bỏ qua lỗi.** Owner cần hoàn tất (hoặc revert) phần `overview-screen.tsx` trước khi gate typecheck admin-web có thể xanh.

## 5. Giới hạn

- Offline, chỉ đọc: không chạy browser/DOM (harness là kiểm tra **source text + artifact thật**, không render React), không chạy PostgreSQL/Redis, không claim DB window, không chạy Playwright hay e2e nào.
- `api-docs-screen.tsx` và `overview-screen.tsx` đều là **thay đổi chưa commit**; kết luận gắn với digest ghi ở đầu receipt, không phải nội dung HEAD.
- Lệnh 4 chạy qua `pnpm` (có in nhiều `WARN Unsupported engine` do Node v22.23.3 < yêu cầu >=24.21.0) — warning này không phải nguyên nhân lỗi; lỗi là TS6133 như trên.
