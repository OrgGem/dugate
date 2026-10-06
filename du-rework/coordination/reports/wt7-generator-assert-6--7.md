# WT-7 — Generator OpenAPI assert trên text source (qwen_2) — 2026-10-07

> **SUPERSEDED:** bản bàn giao chuẩn ở `wt07-generator-assert-2026-10-07.md`. File này giữ lại như bản gốc, nội dung tương đương.

**Task:** WT-7 (LOW) · plan `tasks/CODE-REVIEW-FOLLOWUP-WTREE-6--7.md`. Rate: Docs/tooling/migrations owner.
**Loại:** refactor cua `gen_openapi.py` + them export helper. **Khong commit, khong push.**

## 1. Defect (WT-7)

`tools/openapi/gen_openapi.py:775-784` nhanh behaviour bang **text scan** cua source file `bff/secrets.ts` (cac fragment nhu `effectiveRoute = route;`). Reformat lam gay tool voi loi **khong noi ten rui ro that**.

## 2. Fix — export helper + assert behaviour

### 2.1 `services/orchestrator/src/app/admin/bff/secrets.ts`

Them export `resolveSecretsRoute(method, route)` (pure, khong thay doi logic hien co):

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

Va `handleSecretsRoute` gio **goi helper** tren cung cai dispatch:

```ts
const resolvedRoute = resolveSecretsRoute(method, route);
if (!resolvedRoute.allowed) {
  writeProblem(res, 405, 'METHOD_NOT_ALLOWED', resolvedRoute.reason, correlationId);
  return;
}
const effectiveRoute: SecretsRoute = resolvedRoute.route;
```

-> Mot source of truth duy nhat, nhieu cho (BFF handler + OpenAPI generator) cung dung.

### 2.2 `tools/openapi/gen_openapi.py`

Loai bo toan bo khoi **text scan** cu:

```python
_create_dispatch_fragments = ["if (route.kind === 'list') {", ...]
assert all(fragment in _secret_source for fragment in _create_dispatch_fragments), (...)
```

Thay bang **assert behaviour** bang cach goi script `.cjs` moi:

```python
_dispatch = subprocess.run(
    ['node', 'du-rework/tools/openapi/secrets-route-assert.cjs'], ...)
_dispatch_matrix = json.loads(_dispatch.stdout)
assert _dispatch_matrix['list_get'] == 'list', ...
assert _dispatch_matrix['list_post'] == 'create', ...
...
```

### 2.3 `tools/openapi/secrets-route-assert.cjs` (moi)

Script goi **that** `resolveSecretsRoute` (transpile TS trong-process, giong pattern cua `catalog_callback_schemas.cjs`) va in JSON matrix. Khong scan source nao.

## 3. Bang chung (literal)

**Dispatch matrix (script chay that):**

```
{"list_get":"list","list_post":"create","list_put":null,...,"rotate_post":"rotate","disable_post":"disable","test_post":"test",...}
```

**OpenAPI validator:**

```
cd du-rework
python tools/openapi/validate_openapi.py
paths=58 x-absent=9
SC-CB-CANONICAL-SCHEMAS-VALIDATED count=37 refs=resolved operationIds=unique
OPENAPI-EXAMPLES-VALIDATED
Exit Code: 0
```

**tsc (ts toa bo orchestrator):**

```
npx tsc --noEmit -p tsconfig.json
Exit Code: 0
```

**Offline suite lien quan:**

```
cd du-rework/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand tests/bff-secrets-method-dispatch.test.ts
PASS tests/bff-secrets-method-dispatch.test.ts
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Exit Code: 0
```

## 4. Diff

| File | Thay doi |
|---|---|
| `services/orchestrator/src/app/admin/bff/secrets.ts` | + export `resolveSecretsRoute()`; handler gio goi helper instead of text-scan logic block |
| `tools/openapi/gen_openapi.py` | - text scan blocks; + subprocess assert matrix JSON |
| `tools/openapi/secrets-route-assert.cjs` | moi, smoke-assert the (method,route) matrix bang cach goi the that helper |

## 5. Gioi han

- **Khong commit, khong push.** Code freeze van ap dung.
- Khong sua logic dispatch — chi extraction + assert behaviour tuy hon.
- `_secret_source` su dung trong cac doan sau cua doc-gia van giu, khong dong nghia la moi assert deu khong scan.
