# RV01 — F1/F4 fix patch draft (READ-ONLY)

**Task:** RV01 fix draft · **Date:** 2026-10-02 · **Status:** draft only. No source, test, config or gate was touched; no commit.

Source receipt: `qwen-rv01-loopback-http-2026-10-02.md`. Every line reference below was re-read from the working tree while drafting — none is carried from memory.

**Scope of this wave: F1 and F4 only.** §4 states why the other four are excluded and where they would collide.

## 0. The decision that is NOT parity, stated first

F1 is a straight bug: legacy returned bytes, rework returns nothing.

**F4 is not.** Legacy never answered 401 anywhere on this surface. `app/api/v1/operations/route.ts:35` reads `x-api-key-id` — a header the middleware stripped — so the `if (apiKeyId)` fence on line 38 never ran and the route returned **200 with an unscoped list**. Same in `[id]/route.ts:29`, `cancel/route.ts:24`, `download/route.ts:29`. There is no legacy 401 to match; today the facade answers 500.

So F4 replaces one non-parity wire with a different non-parity wire. That is still the right call — a 401 is the only defensible answer and a 500-for-401 reads as an outage in every caller's logs — but it is an **owner decision**, not a parity restoration, and should be signed off as such rather than filed under "parity fix".

## 1. Correction to the dispatch brief: the 401 shape

The brief asks for a "401 problem+json". **Do not do that.** The legacy surface does not use `application/problem+json`; it uses `{type,title,status,detail}` under `https://dugate.vn/errors/*` (`legacyError`, `legacy-http-mount.ts:159-173`). Answering canonical problem+json here would hand these clients a different error namespace on the one request where they most need to recognise the failure — and it is the same mistake as **F5**, which is still open.

Use `legacyError(401, 'Unauthorized', ...)`. `titleForStatus` (`:356-367`) already returns `'Unauthorized'` for 401, so the slug comes out as `https://dugate.vn/errors/unauthorized` — exactly what the existing F4 tripwire already asserts. **No new error vocabulary is introduced**, and nothing in `packages/contracts` needs to change.

For reference, the canonical alternative would be `problem(401, 'UNAUTHENTICATED', ...)` → `type: 'urn:du:error:unauthenticated'`. Note `'UNAUTHENTICATED'` is **not** in `PublicErrorCodes` (`packages/contracts/src/errors.ts:26-44`), which lists `INVALID_API_KEY` / `INVALID_AUTH` for auth — a second reason not to route the legacy surface through it.

## 2. F1 — download returns a truncated response

### 2.1 Why it is three edits and not one

`route()` already supports binary responses (`server.ts:814-821`: `raw` is piped or `res.end(raw)`-ed, and `content-length` is set from `raw.length`). But the mount's own response contract has no `raw` field, **and the call site at `server.ts:1766` destructures only `status`, `body`, `headers`**. Returning `raw` from the mount alone would still be dropped. All three edits are required.

### 2.2 Edit 1 — widen the mount's response contract

`src/compat/legacy-http-mount.ts:147-151`

```diff
 export interface LegacyRouteResponse {
   readonly status: number;
   readonly body: Record<string, unknown>;
   readonly headers: Record<string, string>;
+  /**
+   * Stored bytes, sent byte-for-byte by the listener. Only the download
+   * route sets it: with it absent the listener JSON-stringifies `body`, which
+   * is how a declared Content-Length and a 2-byte payload reached the wire
+   * together. See docs/39 section 5 (RV01-F1).
+   */
+  readonly raw?: Buffer;
 }
```

### 2.3 Edit 2 — return the bytes, and fix the filename

`src/compat/legacy-http-mount.ts:601-608`

```diff
     return {
       status: 200,
       body: {},
       headers: {
         'content-type': legacyDownloadContentType(row.outputFormat),
-        'content-length': String(bytes.length),
+        'content-disposition': legacyDownloadDisposition(row.outputFormat),
       },
+      raw: bytes,
     };
```

`content-length` is deleted deliberately: `server.ts:816-817` already sets it from `raw.length`, which is the only value guaranteed to match the bytes actually written.

New helper, placed immediately after `legacyDownloadContentType` (`:126-130`):

```ts
/**
 * Legacy download filename.
 *
 * `app/api/v1/operations/[id]/download/route.ts:45-58` read the name from
 * `operations.files_json` (`filesData[0]?.name ?? 'output'`), reduced it with
 * `path.basename`, and appended the extension derived from `outputFormat`.
 *
 * That column does not exist on the rework `operations` table — grep across
 * `migrations/` for `files_json` returns zero matches, and `toLegacyRow`
 * (`compat/legacy-host-adapter.ts`) does not project it. The legacy source is
 * therefore unreachable and the constant fallback is not a simplification, it
 * is the only correct value today.
 *
 * SECURITY: if `files_json` is ever added, this must re-apply the
 * `path.basename` reduction AND strip `"`, CR and LF before the value enters
 * a response header. A caller-influenced filename is header injection.
 */
function legacyDownloadDisposition(outputFormat: string | null | undefined): string {
  const ext = outputFormat === 'html' ? 'html' : outputFormat === 'json' ? 'json' : 'md';
  return `attachment; filename="output.${ext}"`;
}
```

The `ext` mapping is identical to the one `legacyDownloadContentType` already encodes, so the two cannot drift.

### 2.4 Edit 3 — forward `raw` through `route()`

`src/server.ts:1766`

```diff
     if (legacy !== null) {
-      return { status: legacy.status, body: legacy.body, headers: legacy.headers };
+      return {
+        status: legacy.status,
+        body: legacy.body,
+        headers: legacy.headers,
+        ...(legacy.raw !== undefined ? { raw: legacy.raw } : {}),
+      };
     }
```

**This edit is the one that serialises against the compat owner.** It is inside `server.ts`, the file the compat owner does not otherwise touch, and it sits 20 lines below the mount block. §5.

### 2.5 What does NOT need to change

`server.ts:814-821` needs no change — it already handles `Buffer` raw bodies and already sets the correct `content-length`. The RV01 harness handles it too: its listener copies the same branch, so the F1 tripwire flips without a harness edit.

## 3. F4 — an unauthenticated legacy request answers 500

### 3.1 The hazard that makes the naive fix wrong

`safePrincipal` swallows **every** rejection. If it simply started answering 401, a **dead database pool during key resolution** would also answer 401 — sending operators to hunt for a credential problem during an outage. The 401 must be reached **only** on an auth rejection. `resolveApiKey` (`server.ts:4223-4235`) throws `HttpError(401, 'UNAUTHENTICATED', ...)` in both the missing-key and wrong-key cases, so `isHttpError(error) && error.status === 401` is a precise discriminator.

### 3.2 Edit 1 — a discriminating resolver

`src/compat/legacy-http-mount.ts:92-104` (replace `safePrincipal`)

```diff
+import { HttpError, isHttpError } from '../http/errors';
-import { HttpError } from '../http/errors';
...
-async function safePrincipal(request: LegacyRouteRequest): Promise<LegacyPrincipal | null> {
+type PrincipalResolution =
+  | { readonly ok: true; readonly principal: LegacyPrincipal }
+  | { readonly ok: false; readonly status: 401 | 500 };
+
+/**
+ * Resolve the caller WITHOUT collapsing an outage into a credentials problem.
+ *
+ * Only an auth rejection becomes 401. Anything else — a dead pool, a timeout —
+ * stays 500, because answering "unauthorized" to a healthy server with a
+ * broken database sends operators chasing the wrong thing.
+ */
+async function safePrincipal(request: LegacyRouteRequest): Promise<PrincipalResolution> {
   try {
-    return await request.resolvePrincipal();
+    return { ok: true, principal: await request.resolvePrincipal() };
   } catch (error: unknown) {
-    // Both "no key" and "bad key" are 401 in the legacy surface; the
-    // canonical HttpError is discarded so its message cannot leak whether a
-    // key exists.
     void error;
-    return null;
+    return { ok: false, status: isHttpError(error) && error.status === 401 ? 401 : 500 };
   }
 }
+
+/**
+ * ONE body for a missing key and a wrong key. `resolveApiKey` says
+ * 'missing x-api-key' vs 'invalid api key'; forwarding either would let a
+ * caller probe which keys exist. Legacy-shaped, not problem+json — see
+ * receipt section 1.
+ */
+function unauthorized(correlationId: string | undefined): LegacyRouteResponse {
+  return legacyError(401, 'Unauthorized', 'Missing or invalid API key.', correlationId);
+}
```

### 3.3 Edit 2 — the seven guards

Seven identical sites: `:471` (DELETE), `:484` (GET by id), `:508` (list), `:541` (cancel/resume/download), `:618` (balance), `:651` (usage), `:697` (services).

```diff
-    if (principal === null) return internalError(correlationId);
+    const resolved = await safePrincipal(request);
+    if (!resolved.ok) {
+      return resolved.status === 401 ? unauthorized(correlationId) : internalError(correlationId);
+    }
+    const principal = resolved.principal;
```

and the line above each becomes `const resolved = await safePrincipal(request);` in place of `const principal = await safePrincipal(request);`. **Watch `:541`** — it is inside the `cancel|resume|download` block and already declares `principal` once for all three; only one resolution belongs there.

### 3.4 Edit 3 — the submit path

`:410-415`, which does not use `safePrincipal`:

```diff
     let principal: LegacyPrincipal;
     try {
       principal = await request.resolvePrincipal();
     } catch {
-      return internalError(correlationId);
+      return unauthorized(correlationId);
     }
```

**Inconsistency to decide:** this site cannot use the 401-vs-500 discriminator without restructuring, because a bare `catch` erases the type. Either widen the catch to `catch (error)` and apply the same test, or accept that the submit path reports 401 for a database outage while the read paths report 500. **Recommendation: widen the catch** — the two behaviours differing by route is worse than the three lines.

### 3.5 Routes affected

| Route | Today | After |
|---|---|---|
| `POST /api/v1/docs/{6 actions}` | 500 | 401 legacy shape |
| `GET /operations/:id` | 500 | 401 |
| `DELETE /operations/:id` | 500 | 401 |
| `GET /operations` | 500 | 401 |
| `POST /operations/:id/cancel` | 500 | 401 |
| `POST /operations/:id/resume` | 500 | 401 |
| `GET /operations/:id/download` | 500 | 401 |
| `GET /billing/balance` | 500 | 401 |
| `GET /billing/usage` | 500 | 401 |
| `GET /services` | 500 (**catalogue unwired**, a different cause) | 500 — unchanged |
| admin-bearer caller | falls through to canonical | unchanged (`hasAdminBearer` returns null before any of this) |

### 3.6 Tests this wave must add or edit

1. **Edit** `tests/rv01-loopback-http-offline.test.ts` — *"a wrong API key is refused exactly like a missing one"* currently asserts **500** and will fail. Change it to 401 and strengthen it to assert the two bodies are **byte-identical**, which is the actual anti-leak property.
2. **Add** a database-failure case: a `db.query` that rejects with a non-401 must still answer 500. Without it, the §3.1 hazard is untested and a future refactor can silently reintroduce it.
3. **Add** a 401 case on the submit path — none of the 45 currently exercises an unauthenticated submit.
4. The F4 tripwire flips green with **no** edit: it already asserts 401 and the legacy `type` slug.

## 4. Boundary — what this wave does NOT touch

| Finding | Status | Why excluded |
|---|---|---|
| **F2** cancel 404 extra `detail` | untouched | needs a `legacyError` variant (`:159-173`) that omits `detail`; separate decision about whether omitting it is the goal |
| **F3** cancel 409 `type` slug | untouched | needs `legacyError` (`:159-173`) to accept an explicit slug instead of deriving it from the title |
| **F5** unknown `/docs/<slug>` namespace | untouched | needs the path table closed; a routing change, not an error-shape change |
| **F6** non-multipart → 415 | untouched | needs a content-type check **before** `decodeLegacyMultipart`, in the same region F1 edits |

**Conflict analysis.** F2 and F3 both land inside `legacyError` (`:159-173`), which **F1 and F4 do not touch** — F1 only widens the interface and the download branch, F4 only adds two helpers. So F2/F3 can land in parallel with this wave with no textual conflict.

**F6 is the one to serialise.** Its check belongs immediately before the `decodeLegacyMultipart` call (`:418-419`), three lines below the block F4's Edit 3 rewrites (`:410-415`). Same function, adjacent, no line overlap — but one merge conflict is likely if both land in one wave.

## 5. Apply checklist

1. **Serialise with the compat owner** before applying. Two touch points: `server.ts:1766` (F1 Edit 3 — the file the compat owner avoids) and the `:410-415` submit region (F4 Edit 3). Confirm who owns `server.ts` and whether an integration wave is landing in `legacy-http-mount.ts` this cycle.
2. Apply F1 edits 1-3, then F4 edits 1-3.
3. **Flip the two tripwires** in `tests/rv01-loopback-http-offline.test.ts`: `it.failing('RV01-F1` → `it('RV01-F1` and `it.failing('RV01-F4` → `it('RV01-F4`. Neither assertion needs editing — F1's snapshot still expects `content-length: 17` and F4's still expects 401 with the legacy `type` slug.
4. Run `npx jest --runInBand --testPathPatterns "rv01-loopback"` in `services/orchestrator`. Expect **45 passed, exit 0**, with the four remaining `it.failing` tripwires (F2/F3/F5/F6) still green.
5. Run `npx tsc --noEmit -p tsconfig.json`. `tests/` is excluded from that project, so it will **not** catch a type error in the new assertions — `npx jest` is the only check for those.
6. Full-suite check: `npx jest --runInBand` in `services/orchestrator` must stay at **28 failures / 8 admin-P6-01 suites** with passes rising 4083 → 4088. A non-zero exit here is expected and is not a regression signal on its own.
7. Do not tick any gate; this wave is offline-verified only.

## 6. Open points for the owner

1. **F4's non-parity status** (§0) — confirm 401 over 500 as a deliberate hardening, not as parity restoration.
2. **F4 submit-path inconsistency** (§3.4) — widen the catch, or accept the divergence?
3. **F1 filename** — `output.<ext>` is the only reachable value today. If a source-name column is wanted, that is a separate migration, and it must carry the header-injection guard.
4. **F1 `Content-Disposition` at all** — legacy sent it; the facade currently does not. Included above because it is part of the same legacy branch, but it could be split out if the wave is kept minimal to the byte-loss bug.
5. **Binary output** — `loadOutputContent` reads `output_content`, a text column, and does `Buffer.from(raw,'utf8')`. A binary output would be corrupted before `raw` ever reaches the wire. Out of scope for F1; worth a follow-up finding.

## 7. What depends on RV01-VERIFY

This draft was written against the working tree while RV01-VERIFY was running in parallel. If that run reports a change to `legacy-http-mount.ts` or `server.ts` in the regions cited above, **§2.4, §3.3 and §3.4 must be re-derived against the new line numbers** — the sketches are anchored by surrounding code text as well as line numbers, so an `edit` with a stale line number will fail loudly rather than apply at the wrong place.