# Receipt — SC-03 F5: UI validation gaps (CRLF/NUL header prefix & bounds)

- Task: Sửa lỗi UI Validation F5 (dispatch 2026-10-07), nguồn `coordination/reports/ui-frontend-audit-lane1-2026-10-06.md` §F5 + rà soát Claude Reviewer
- Owner: OpenCode (`oc_3` / `term_8a432ae3-63b7-41fd-929e-0797860c7426`), mode WORKER
- Repo scope: `du-rework` — file sửa duy nhất: `apps/admin-web/src/features/profiles/callback-policy.ts`
- Date: 2026-10-07
- Constraints honored: **KHÔNG commit, KHÔNG push**; không sửa file sản phẩm nào khác
- Status: **IMPLEMENTED + offline-verified (typecheck/build/probe)**; chưa có independent VFY/Claude review cho packet này. Không tick.

## 0. TL;DR

- `validateCallbackDraft` nay chặn `header.prefix` chứa CR/LF/NUL bằng đúng message yêu cầu, đếm giới hạn header theo **entry thực** (`active`) thay vì `draft.headers` (bỏ qua hàng trống), và bound OAuth2 `clientId ≤256`, `scope/audience/resource ≤512` khớp contract đã đóng băng.
- Kiểm chứng: typecheck exit 0 (đúng lệnh dispatch), production build exit 0 (tsc + vite, 2688 modules), probe hành vi chạy trực tiếp file nguồn (Node type-stripping, script ngoài repo) pass hết 9 nhóm assert, `git diff --check` exit 0.
- File hash sau sửa: `CF068D7779849E8EC2EF5B1E24E8EDAE7FA33F120C5B92C48807010339F19B25`.

## 1. Diff (chỉ các hunk F5 của packet này)

File: `apps/admin-web/src/features/profiles/callback-policy.ts` — `validateCallbackDraft`.

```diff
@@ configured_headers
     const active = draft.headers.filter((header) => header.name.trim().length > 0 || header.secretId !== null);
     if (active.length === 0) errors.push('configured_headers requires at least one header');
-    if (draft.headers.length > CALLBACK_MAX_HEADERS) errors.push(`at most ${CALLBACK_MAX_HEADERS} headers`);
+    // F5: count only real entries; blank draft rows must not trip the limit.
+    if (active.length > CALLBACK_MAX_HEADERS) errors.push(`at most ${CALLBACK_MAX_HEADERS} headers`);
     for (const header of active) {
       ...
       if (header.prefix.length > 64) errors.push(`header '${name}' prefix is too long`);
+      // F5: the frozen contract rejects CR/LF/NUL in a prefix; fail here so the
+      // operator sees the field error instead of a server 422.
+      if (/[\r\n\0]/.test(header.prefix)) {
+        errors.push(`header '${name}' prefix must not contain CRLF or NUL characters`);
+      }
     }

@@ oauth2_client_credentials
     if (draft.clientId.trim().length === 0) errors.push('client id is required');
+    // F5: mirror the frozen contract bounds so long values fail in the editor.
+    if (draft.clientId.length > 256) errors.push('client id must be at most 256 characters');
+    if (draft.scope.length > 512) errors.push('scope must be at most 512 characters');
+    if (draft.audience.length > 512) errors.push('audience must be at most 512 characters');
+    if (draft.resource.length > 512) errors.push('resource must be at most 512 characters');
     if (draft.clientSecretId === null) errors.push('client secret reference is required');
```

Vị trí sau sửa: `active.length` limit `:205`; CRLF/NUL prefix `:216-218`; bounds `:232-235`.

Lưu ý provenance: worktree đang chứa các hunk **của lane khác** trong cùng file (F1–F4: `configuredOnServer`/`replacing`, `CALLBACK_SECRET_PURPOSES`, seeding từ policy đọc) — packet này **không** chạm các phần đó; diff đầy đủ so với HEAD bao gồm cả chúng.

## 2. Đối chiếu yêu cầu

| Yêu cầu dispatch | Trạng thái |
|---|---|
| `header.prefix` chứa `[\r\n\0]` → error `header '${name}' prefix must not contain CRLF or NUL characters` | PASS (`:216-218`) |
| `draft.headers.length` → `active.length` cho giới hạn `CALLBACK_MAX_HEADERS` | PASS (`:205`) |
| `clientId.length > 256` → `client id must be at most 256 characters` | PASS (`:232`) |
| `scope/audience/resource > 512` → message tương ứng | PASS (`:233-235`) |
| Typecheck admin-web exit 0 | PASS (§3) |

Khớp contract CB-01 (`packages/contracts/src/profile-callback.ts`): prefix `.max(64)` + refine `!/[\r\n\u0000]/`; `clientId.max(256)`; `scope/audience/resource.max(512)`. Client-side giờ báo lỗi field-level thay vì để server 422.

## 3. Kiểm chứng (literal)

| Command (cwd) | Kết quả |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (cwd `du-rework/apps/admin-web`) — **đúng lệnh dispatch** | exit **0** |
| `npm run build` (cwd `du-rework/apps/admin-web`) = `tsc --noEmit && vite build` | exit **0**; `2688 modules transformed`, `✓ built in 11.72s`; cảnh báo chunk >500 kB (`873.49 kB`/`218.45 kB` gzip) là pre-existing (audit §F8), không phải lỗi |
| `node --experimental-strip-types <temp>/f5-probe.mjs` (probe ngoài repo, không phải deliverable) | exit **0** — `F5 probe OK` |
| `git diff --check -- apps/admin-web/src/features/profiles/callback-policy.ts` | exit **0** |

Probe hành vi (chạy trực tiếp `callback-policy.ts` qua Node 22 type-stripping, script ở `%TEMP%\opencode\f5-probe.mjs`, **không** nằm trong repo) xác nhận:
1. prefix `Bearer\r\nX-Evil: 1` → đúng message CRLF/NUL; prefix `Bearer\0sneak` → đúng message; prefix hợp lệ `Bearer ` → không lỗi;
2. 9 header active → `at most 8 headers`; 8 active + 5 hàng trống → **không** còn false-positive limit;
3. `clientId` 257 → lỗi bound; `scope`/`audience`/`resource` 513 → lỗi bound tương ứng;
4. boundary hợp lệ (clientId 256, scope/audience/resource 512) → không lỗi.

Không có test runner trong `apps/admin-web` (không có jest/vitest; audit §F8 ghi nhận “lint” chỉ là `tsc --noEmit`) nên probe ngoài repo là bằng chứng hành vi bổ sung; typecheck + build là gate chính thức theo dispatch.

## 4. File + hash

| File | SHA-256 |
|---|---|
| `apps/admin-web/src/features/profiles/callback-policy.ts` | `CF068D7779849E8EC2EF5B1E24E8EDAE7FA33F120C5B92C48807010339F19B25` |

## 5. Notes / open items

- Các khoảng trống contract khác được audit ghi trong cùng §F5 (secret name regex, vault mount/path/field/namespace bounds, literal ≤64 KiB, `additionalHeaders` chưa có UI) **không thuộc dispatch này**; giữ nguyên trạng thái (server 422 là authority).
- F1–F4 (purpose filter, duplicate DOM ids, seeding) là lane khác, không sửa trong packet này.
- **Không commit, không push**; không tick task/gate.
