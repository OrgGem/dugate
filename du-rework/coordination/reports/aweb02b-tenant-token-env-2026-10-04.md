# AWEB-02b — wire `tenantAdminTokens` env trong main.ts (cc_2)

**Packet:** aweb02b-tenant-token-env · **Lane:** cc_2 · **Dispatch:** 2026-10-04T12:22+07:00 (spec `coordination/dispatch-specs/2026-10-04-1222-AWEB02b-tenant-token-env.md`).
**Trạng thái:** implementation + focused test + tsc xanh. **Không commit; không tick**; không đổi policy fence. File ghi: `src/main.ts` + test mới + receipt này (đúng lease).

## 1. Diff `main.ts` (3 hunk, không hunk nào khác)

```diff
@@ after workerIdentityTokensByBusiness() @@
+/**
+ * Optional JSON object mapping TENANT IDs to their admin bearer tokens (env
+ * mirrors WORKER_IDENTITY_TOKENS_BY_BUSINESS: key = non-secret id, value =
+ * secret). ServerConfig.tenantAdminTokens is the REVERSE map (token ->
+ * tenantId) and is what the admin shell/BFF fence consumes; the flip happens
+ * here, once. Fail-fast on shape errors and on a token assigned to two
+ * tenants — the reverse map could not represent that without silently picking
+ * one, and a silent tenant mix-up is exactly what the fence exists to stop.
+ * Error messages never echo the token value.
+ */
+export function tenantAdminTokensFromEnv(): Record<string, string> | undefined {
+  const raw = optional('TENANT_ADMIN_TOKENS_BY_TENANT');
+  if (raw === undefined) return undefined;
+  let parsed: unknown;
+  try { parsed = JSON.parse(raw); } catch { throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT must be a JSON object mapping tenant IDs to admin bearer tokens'); }
+  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('… must be a JSON object …'); }
+  const byToken = new Map<string, string>();
+  for (const [tenantId, token] of Object.entries(parsed as Record<string, unknown>)) {
+    if (tenantId.length === 0) throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT tenant IDs must be non-empty');
+    if (typeof token !== 'string' || token.length === 0) throw new Error(`… token for tenant '${tenantId}' must be a non-empty string`);
+    if (byToken.has(token)) throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT assigns the same token to multiple tenants');
+    byToken.set(token, tenantId);
+  }
+  return Object.fromEntries(byToken);
+}

@@ createApp options, after adminToken @@
     adminToken: optional('ADMIN_TOKEN'),
+    tenantAdminTokens: tenantAdminTokensFromEnv(),

@@ entry @@
-void main().catch((error: unknown) => { … process.exit(1); });
+// Entry semantics are preserved for `npm start` (`node dist/main.js`); the
+// guard only makes this module importable by focused tests … without booting.
+if (require.main === module) {
+  void main().catch((error: unknown) => { logger.error('orchestrator startup failed', …); process.exit(1); });
+}
```

## 2. Format env đã chốt

- **Tên:** `TENANT_ADMIN_TOKENS_BY_TENANT` (SCREAMING của field + hậu tố `BY_TENANT` để chỉ rõ map được key theo tenantId — cùng họ với `WORKER_IDENTITY_TOKENS_BY_BUSINESS`: **key = id không nhạy cảm, value = secret**). Alternative `TENANT_ADMIN_TOKENS` (ngắn hơn) chỉ là 1 dòng rename nếu coordinator muốn — ghi nhận.
- **Giá trị:** JSON object **`{"<tenantId>":"<token>", …}`** — tức "map tenantId → token" đúng như spec mô tả; `main.ts` flip một lần sang shape ServerConfig **token → tenantId** — đúng thứ tự mà validation/boot đang kiểm (`create-app.ts:199-209` lặp `[token, tenantId]`; `rbac.ts:51` và `credentialForTenant` (BFF) cũng đọc token→tenant; mọi test nền tảng như `admin-audit-scope.test.ts` dùng `{ [OP_A]: TENANT_A }`).
- **Không bật gì mặc định:** env thiếu/`''` → `undefined` (hành vi trước AWEB-02b giữ nguyên). Không đổi policy fence/BFF/anything khác.

## 3. Fail-fast (giữ theo yêu cầu)

| Input env | Kết quả |
|---|---|
| thiếu / rỗng | `undefined` (off) |
| `{}` | `{}` (không throw) |
| JSON hỏng / không phải object (array/string/null/number) | **throw** (message nêu tên env) |
| tenantId rỗng (`""` key) | **throw** |
| token rỗng / không phải string (number, nested object) | **throw** |
| cùng một token gán cho 2 tenant | **throw** — reverse map không biểu diễn được, silent pick là đúng loại lỗi fence sinh ra để chặn; **message không echo token** (log hygiene) |
| token alias `ADMIN_TOKEN`/`RUNTIME_TOKEN` | vẫn do boot validation cũ chặn (`create-app.ts:203-208`) — không nhân bản luật |

`__proto__` an toàn: map trung gian là `Map` + `Object.fromEntries` → key `__proto__` thành **own property**, không ghi prototype (có test).

## 4. Kiểm thử (literal)

```
cwd: D:\Git\dugate\du-rework\services\orchestrator, NODE_ENV=test
> pnpm exec jest --runInBand tests/aweb02b-tenant-token-env.test.ts tests/admin-audit-scope.test.ts
PASS tests/aweb02b-tenant-token-env.test.ts          (8 case: missing/valid/{}/malformed/non-object/empty-id+token/dup-token/__proto__)
PASS tests/admin-audit-scope.test.ts                 (21 test — regression fence nền tảng)
Test Suites: 2 passed, 2 total
Tests:       29 passed, 29 total
Time:        5.87 s
JEST_EXIT=0

> pnpm exec tsc --noEmit -p tsconfig.json
TSC_EXIT=0
```

- Import-safety của test chính là bằng chứng guard: suite import `../src/main` mà **không** boot orchestrator (nếu guard hỏng, main() cần `DATABASE_URL` và sẽ `process.exit(1)` giết tiến trình jest).
- **Entry semantics vẫn nguyên** (kiểm chủ động): chạy trực tiếp `pnpm dlx tsx src/main.ts` (thiếu `DATABASE_URL`) → **exit 1** + log `orchestrator startup failed` → main() thật sự chạy khi được invoke làm entry (`npm start` = `node dist/main.js` không đổi).
- Ghi nhận trung thực: lần chạy đầu bị chặn bởi **lỗi compile của lane khác** trong `src/app/admin/bff/handle.ts:264/273/329` (mtime 12:26:52, đang sửa giữa chừng) — lọc tsc: **0 lỗi thuộc `main.ts`/test của packet**; lane đó sửa xong trước lần chạy thứ hai nên kết quả trên là plain run, không workaround.

## 5. Doc-note (KHÔNG sửa `.env.example` / docs/)

Đề xuất thêm vào `du-rework/.env.example` (không secret thật):

```
# Per-tenant admin bearers for the Admin Web BFF (and tenant-fenced admin reads).
# JSON object keyed by tenantId: {"<tenantId>":"<token>"} — unset means tenant
# operators get 403 TENANT_SCOPE_UNAVAILABLE; tokens must not alias
# RUNTIME_TOKEN/ADMIN_TOKEN (boot refuses), keep >=32 chars.
#TENANT_ADMIN_TOKENS_BY_TENANT={"tenant-a":"change_me_tenant_a_token_min_32_chars"}
```

## 6. Ranh giới & không chứng minh

- Chỉ chạm `src/main.ts` + `tests/aweb02b-tenant-token-env.test.ts`; **không** chạm `shell-server.ts`, `bff/**`, `apps/**`, `contracts`, `server.ts`, `tasks`, `docs` (status xác nhận diff của tôi chỉ main.ts; các file `M` khác là của lane đang mở).
- Chưa chứng minh: boot live với env thật + gọi BFF operator read end-to-end (cần token tenant thật + stack live — ngoài packet; format đã khớp đúng shape mà AWEB-02 verify 20/20 đã chạy qua seam).
- Không commit.

**Verdict:** DONE ở tầng parse + wiring + test/tsc; gap AWEB-02 §7 (operator read live cần env) đã được đóng ở phía orchestrator entry — chỉ còn thao tác vận hành set env.
