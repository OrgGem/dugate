# WT-07 — Generator OpenAPI assert trên text source — BÀN GIAO (qwen_2) — 2026-10-07

**Task:** WT-07 (LOW) · role: Docs, tooling & migrations owner · scope `du-rework` ONLY.
**Kết quả:** ✅ XONG — IMPLEMENTED + VERIFIED-OFFLINE. **Không commit, không push** (code freeze).

> Ghi chú bàn giao: receipt cùng nội dung đã được ghi trước đó tại `wt7-generator-assert-6--7.md`
> (đường dẫn trong prompt dispatch). File này là **bản bàn giao chuẩn**; bản cũ được đánh dấu superseded.

---

## 1. Defect (WT-07)

`tools/openapi/gen_openapi.py:775-784` khoá behaviour của BFF secrets bằng **quét chuỗi source** của `bff/secrets.ts` — các fragment nhu `effectiveRoute = route;`, `"if (route.kind === 'list') {"`. Hệ quả: **chỉ cần reformat** file đó (prettier, đổi tên biến, tách dòng) là generator gãy, với lỗi assert không chỉ ra rủi ro thật.

## 2. Fix — một source of truth, assert theo hành vi

### 2.1 `services/orchestrator/src/app/admin/bff/secrets.ts`

Thêm helper thuần, **không đổi logic dispatch** hiện có:

```ts
export function resolveSecretsRoute(
  method: string,
  route: SecretsRoute,
): { allowed: true; route: SecretsRoute } | { allowed: false; reason: string } {
  if (route.kind === 'list') {
    if (method === 'GET') return { allowed: true, route };
    if (method === 'POST') return { allowed: true, route: { kind: 'create' } };
    return { allowed: false, reason: `method ${method} is not allowed here` };
  }
  if (method === 'POST') return { allowed: true, route };
  return { allowed: false, reason: `method ${method} is not allowed here` };
}
```

`handleSecretsRoute` dùng lại chính helper này thay cho khối if/else trước đó:

```ts
const resolvedRoute = resolveSecretsRoute(method, route);
if (!resolvedRoute.allowed) {
  writeProblem(res, 405, 'METHOD_NOT_ALLOWED', resolvedRoute.reason, correlationId);
  return;
}
const effectiveRoute: SecretsRoute = resolvedRoute.route;
```

### 2.2 `tools/openapi/gen_openapi.py`

Xoá khối **text scan** (`_create_dispatch_fragments` + `assert all(fragment in _secret_source ...)`), thay bằng **assert hành vi**:

```python
_dispatch = subprocess.run(
    ['node', 'du-rework/tools/openapi/secrets-route-assert.cjs'],
    capture_output=True, text=True, check=True)
_dispatch_matrix = json.loads(_dispatch.stdout)
assert _dispatch_matrix['list_get'] == 'list', _dispatch_matrix
assert _dispatch_matrix['list_post'] == 'create', _dispatch_matrix
# ... mọi (method, route) khác phải None; rotate/disable/test POST-only
```

### 2.3 `tools/openapi/secrets-route-assert.cjs` (mới)

Gọi **thật** `resolveSecretsRoute` (transpile TS trong-process, đúng pattern của `catalog_callback_schemas.cjs`) và in JSON matrix. Không đọc/scan source.

## 3. Bằng chứng (literal)

**Dispatch matrix do script chạy thật:**
```
{"list_get":"list","list_post":"create","list_put":null,"rotate_put":null,"disable_put":null,"test_put":null,
 "list_delete":null,"rotate_delete":null,"disable_delete":null,"test_delete":null,"list_patch":null,
 "rotate_patch":null,"disable_patch":null,"test_patch":null,"list_head":null,"rotate_head":null,
 "disable_head":null,"test_head":null,"rotate_post":"rotate","rotate_get":null,"disable_post":"disable",
 "disable_get":null,"test_post":"test","test_get":null}
```

**OpenAPI validator** — cwd `du-rework`:
```
python tools/openapi/validate_openapi.py
paths=58 x-absent=9
SC-CB-CANONICAL-SCHEMAS-VALIDATED count=37 refs=resolved operationIds=unique
OPENAPI-EXAMPLES-VALIDATED
Exit Code: 0
```

**Offline suite liên quan** — cwd `du-rework/services/orchestrator`:
```
node node_modules/jest/bin/jest.js --runInBand tests/bff-secrets-method-dispatch.test.ts
PASS tests/bff-secrets-method-dispatch.test.ts
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Exit Code: 0
```

**Typecheck orchestrator:** `npx tsc --noEmit -p tsconfig.json` → **Exit Code: 0**.

## 4. File thay đổi

| File | Thay đổi |
|---|---|
| `services/orchestrator/src/app/admin/bff/secrets.ts` | + export `resolveSecretsRoute()`; handler gọi helper thay khối if/else trước |
| `tools/openapi/gen_openapi.py` | − khối text-scan; + subprocess assert matrix JSON |
| `tools/openapi/secrets-route-assert.cjs` | mới — assert matrix bằng cách gọi helper thật |

## 5. Bàn giao / giới hạn

- **Không commit, không push.**
- Không sửa logic dispatch — chỉ extraction + assert hành vi tinh vi hơn.
- **`_secret_source` vẫn được đọc ở các đoạn khác của generator** (ví dụ kiểm `matchSecretsRoute` được handle.ts gọi). Chỉ khối behaviour-critical của dispatch đã chuyển khỏi text scan.
- Trong quá trình làm: guard transpile ban đầu giới hạn trong `app/admin/bff/` nên vấp `http/errors.ts`; đã mở về `services/orchestrator/src` (và sửa depth của `createRequire`).
