# RV01 — loopback HTTP proof for the legacy compat facade

**Task:** RV01 loopback HTTP offline test · **Date:** 2026-10-02 · **Status:** delivered, one new test file. No source change, no gate ticked, no commit, no live infra.

## 0. What this closes, and what it does not

Before this task, **every** legacy-compat test drove `handleLegacyRoute` or `legacyCompatHost` in-process. Nothing had put a real socket under them. Three things were therefore unproven:

1. that `server.ts` actually routes a legacy multipart request into the facade instead of dropping it;
2. that the `isLegacyCompat` streaming-ingress branch in `server.ts` is the branch a real request executes (every prior test passed a `bodyStream` in by hand);
3. that the status codes, headers and envelopes survive a real HTTP response — in particular anything that depends on Node's response finalisation.

This suite closes all three offline. It also **found a defect that no in-process test could have found** (RV01-F1, section 5): the download route produces a truncated response that Node tears down.

**Not proven, and explicitly out of scope here:** anything requiring PostgreSQL, Redis, S3, a queue, or a worker. `createApp` cannot boot offline (it opens a pool, verifies migrations, and starts Redis), so the harness mounts the real `route()` behind a listener transcribed from `createApp`. See section 2.

## 1. The change surface

One new file, nothing else touched.

| File | State |
|---|---|
| `services/orchestrator/tests/rv01-loopback-http-offline.test.ts` | **new** (1417 lines) |
| any existing file | **unmodified** — `git status --porcelain -- du-rework/services/orchestrator` lists no ` M ` entry |

## 2. Harness fidelity: what is real and what is faked

The listener in the test is a transcription of `createApp`'s `createServer` callback (`src/server.ts:717-849`). Four properties of that transcription are load-bearing and are commented in the file:

- the **`isLegacyCompat` predicate** is copied verbatim — `POST` + `^/api/v1/docs/[a-z-]+(?:/schema)?$` + `content-type` starting `multipart/form-data`;
- **`bodyStream: req`** is passed only on that branch, and the body is *not* pre-buffered there;
- the **real `readBoundedBody`** from `src/http/ingress.ts` is imported and used for every other route, rather than a re-implementation;
- the **`HttpError -> problem+json`** mapping and the **raw-vs-JSON** response split are copied — including the fact that only `result.raw` is sent byte-for-byte.

Real code under test: `route()`, `handleLegacyRoute`, `legacyCompatHost`, `toLegacyEnvelope`, `toLegacyListPage`, `readMultipartBody`, `legacyFieldsToRecord`, `decodeLegacyWire`, and **`writePublicArtifact`** (its three storage seams are faked, so the size-check/digest/INSERT ordering under test is the shipped one).

Faked: the `db` (a SQL interpreter over an in-memory store), `artifacts.putPublicArtifact`'s storage seams, `submission.submit`, `runtime.resumeOperation`. An unmodelled SQL statement **throws** rather than returning an empty page, so a predicate that drifts fails loudly instead of looking like an empty tenant.

## 3. How to run

```
cd du-rework/services/orchestrator
npx jest --runInBand --testPathPatterns "rv01-loopback"
```

Result: **45 passed, 45 total, ~4.5 s**. Six of those 45 are `it.failing` tripwires whose bodies are *currently failing* — see section 5. To read the literal red values, flip `it.failing(` to `it(` on the six and re-run: **6 failed, 39 passed**.

## 4. Case table

Expectations are transcribed from the legacy du-gate routes (`D:\Git\dugate\app\api\v1\**`), not from the facade, so a facade change that breaks parity fails here.

| # | Case | Wire assertion | Result |
|---|---|---|---|
| 1 | unknown path | 404 + `type: urn:du:error:not_found` | PASS |
| 2 | `POST /docs/ingest` | 202 + `Operation-Location` + 3-key envelope, artifact role `source` | PASS |
| 3 | `POST /docs/extract` | same, role `source` | PASS |
| 4 | `POST /docs/analyze` | same, role `source` | PASS |
| 5 | `POST /docs/transform` | same, role `source` | PASS |
| 6 | `POST /docs/generate` | same, **zero** artifacts | PASS |
| 7 | `POST /docs/compare` | same, roles `source`,`target` | PASS |
| 8 | compare field order | `['src.pdf','tgt.pdf']`, roles in that order | PASS |
| 9 | `?sync=true` | 200, **no** `Operation-Location`, `done:false` | PASS |
| 10 | replayed `idempotency-key` | 200, no header, same `name`, **one** operation row | PASS |
| 11 | `output_format` | reaches `output.format` verbatim; defaults `json` | PASS |
| 12 | unknown variant | 400 `.../invalid-parameter` | PASS |
| 13 | discriminator, no file | 202, `artifacts` absent | PASS |
| 14 | `GET /docs/extract` | 405 `.../method-not-allowed`, detail `extract accepts POST only` | PASS |
| 15 | GET SUCCEEDED | full `result` block: 6-key `usage`, `download_url`, `extracted_data` | PASS |
| 16 | FAILED + steps | `error` **and** `result` both present | PASS |
| 17 | FAILED, no steps | `error` present, **no** `result` | PASS |
| 18 | CANCELLED | `done:true`, **neither** block | PASS |
| 19 | unknown id | 404, 5 keys incl. `requested_id` | PASS |
| 20 | foreign-tenant id | 404 (no existence leak) | PASS |
| 21 | DELETE | 204, **zero** bytes, then GET 404 | PASS |
| 22 | cancel RUNNING | 200, state `CANCEL_REQUESTED`, `done:false` | PASS |
| 23 | cancel unknown | legacy 3-key 404 | **RED — F2** |
| 24 | cancel SUCCEEDED | 409 with `.../already-done` | **RED — F3** |
| 25 | resume `WAITING_INPUT` | 200 `{success:true,message:'Resumed successfully'}`, runtime called once | PASS |
| 26 | resume RUNNING / unknown | 400 `{error:...}`, 404 `{error:'Operation not found'}` — bare, not problem+json | PASS |
| 27 | download, SUCCEEDED + inline | 17 document bytes, `text/markdown; charset=utf-8`, response completes | **RED — F1** |
| 28 | download RUNNING | 409 `.../not-ready` | PASS |
| 29 | download SUCCEEDED, no output | 404 `.../no-output`, exactly 4 keys | PASS |
| 30 | list + `page_token` walk | `{operations,next_page_token}`; token is the plain uuid; page 2 empties the token to `null` | PASS |
| 31 | soft-deleted row | absent from the list | PASS |
| 32 | `filter=state=BOGUS` | 400 bare `{error}` | PASS |
| 33 | `filter=state=SUCCEEDED` | narrows the page | PASS |
| 34 | balance with limit | `spending_limit`/`total_used`/`balance` = 50 / 12.5 / 37.5 | PASS |
| 35 | balance, no limit | `spending_limit:null`, `balance:null` (not negative) | PASS |
| 36 | billing usage | per-model SUM, `total_operations` counts SUCCEEDED only | PASS |
| 37 | bad usage date | 400 bare `{error}` | PASS |
| 38 | admin bearer on `/operations` | canonical `{items,nextCursor,prevCursor,total,limit}`, **no** `operations` key | PASS |
| 39 | unauthenticated legacy read | 401 `.../unauthorized` | **RED — F4** |
| 40 | wrong API key | refused identically to a missing one, key not echoed | PASS |
| 41 | `POST /docs/workflows` | 503 `.../service-not-available` (claimed, not silent 404) | PASS |
| 42 | `POST /docs/workflows/schema` | 503 | PASS |
| 43 | `GET /api/v1/services` | 500 Internal Error, **no** empty `services` list | PASS |
| 44 | unknown `/docs/<slug>` | 404 in the `dugate.vn/errors` namespace | **RED — F5** |
| 45 | JSON body to `/docs/extract` | 415 `.../unsupported-media-type` | **RED — F6** |

**39 green, 6 red.**

## 5. Reds and findings

No source was changed for any of these. Each is a one-line fix at most, but each is a **product** decision, so it is recorded rather than applied.

### RV01-F1 — download returns a truncated response that Node tears down (most severe)

The download branch of the mount loads the output bytes (`legacy-http-mount.ts:597`) and returns:

```
{ status: 200, body: {}, headers: { 'content-type': ..., 'content-length': String(bytes.length) } }
```

`body` is `{}` and there is **no `raw` buffer**. `server.ts:814-821` only sends `result.raw` byte-for-byte; for every other outcome it JSON-stringifies `body` at `:820`. So the response declares `Content-Length: 17` (`:606`) and then writes 2 bytes of `{}`. Node keeps the declared length, and the client sees a truncated response.

Observed over a real socket:

```
aborted:        true
status:         200
contentType:    "text/markdown; charset=utf-8"
declaredLength: "17"
receivedBytes:  2
received:       "{}"
```

The client receives **no document at all** — not `{}`, not an error: Node tears the response down, `end` never fires, and the socket-timeout does not fire either. Legacy returned the output content inline (`app/api/v1/operations/[id]/download/route.ts:45-58`).

Reproduced independently of the suite with a 12-line `node:http` probe: a server that `setHeader('content-length','19')` then `end('{}')` produces the identical `aborted` with no `end` event.

*Fix shape:* return `raw: bytes` from the mount (and stop setting `content-length` by hand), plus add the legacy `Content-Disposition: attachment; filename=...`, which the facade also omits.

### RV01-F2 — cancel 404 carries a fourth key legacy never sent

`app/api/v1/operations/[id]/cancel/route.ts:17-21` answered a missing operation with `{type, title, status}`. `legacyError()` always writes a `detail`, so the rework body has **four** keys. Observed: `['detail','status','title','type']` vs legacy `['status','title','type']`.

### RV01-F3 — cancel 409 `type` slug changed

`legacyError()` derives the `type` slug from the title, so `Already Completed` becomes `.../already-completed`. Legacy hardcoded `.../already-done` (`cancel/route.ts:34`). Observed: `https://dugate.vn/errors/already-completed` vs `https://dugate.vn/errors/already-done`. A client branching on `type` misses the 409.

### RV01-F4 — an unauthenticated legacy request answers 500, not 401

`safePrincipal()` swallows the `resolveApiKey` rejection and every operations route then returns `internalError()`. Observed: `500` where `401` is expected.

Worth stating precisely: **legacy did not 401 either.** `app/api/v1/operations/route.ts:35` reads `x-api-key-id` — a header the middleware stripped — so the `if (apiKeyId)` fence on line 38 never fired and the route returned 200 with an *unscoped* list. That is the IDOR this whole compat layer was built to avoid: rework takes identity only from `x-api-key`, as `docs/39-legacy-parity-contract.md` §6 records. So neither wire is right; 401 is the only defensible one, and collapsing a missing key and a wrong key into a 500 was not a deliberate choice worth preserving.

### RV01-F5 — an unknown `/api/v1/docs/<slug>` leaves the legacy error namespace

`parseLegacyDocsPath` returns `null` for a slug outside the six core actions, so the request falls through to the canonical table. Observed `type: urn:du:error:not_found`; the legacy runner answered `404 Service Not Found` in the `dugate.vn/errors` namespace. Same status, different namespace — a client that switches on `type` misclassifies it.

### RV01-F6 — a non-multipart submit is 400, not 415

A JSON body never enters the streaming branch, so `decodeLegacyMultipart` finds no `bodyStream` and the guard is converted to `400 Invalid Parameter / "multipart body stream is required"`. Observed `400` where `415` is expected. The content type was the thing that was wrong; the message describes an internal invariant instead.

### Tripwire mechanism

The six reds are written as `it.failing(...)`. That reports green **while the defect stands** and turns **red the moment the behaviour matches legacy** — so the suite stays usable today and alarms on the fix. Section 3 records the exact command to read the literal red values.

## 6. Known-unwired surfaces (green, but not parity)

These pass because the suite asserts the **honest failure**, and they are still open product work:

| Surface | Observed | Why |
|---|---|---|
| `POST /docs/workflows`, `/schema` | 503 | `serviceCatalogue` and the three legacy workflow businesses are not registered |
| `GET /api/v1/services` | 500 | `serviceCatalogue` is undefined on the host; deliberately 500 rather than an empty catalogue, which would read as "you may call nothing" |
| `download` file branch | n/a | only the inline branch is wired; the file branch would 404 `no-output` |
| `billing/*` against a real DB | n/a | `api_keys.total_used` has no writer, so `total_used` and `balance` are permanently 0. The fake DB proves the *arithmetic*, not the *accumulation* |
| migration `0024_legacy_parity_columns.sql` | n/a | still never executed against a real database |

## 7. Full-suite regression

`npx jest --runInBand` in `services/orchestrator`:

```
Test Suites: 8 failed, 17 skipped, 117 passed, 125 of 142 total
Tests:       28 failed, 225 skipped, 4083 passed, 4336 total
```

Identical to the baseline established earlier in this lane (28 failures across the same 8 suites), with the pass count moving 4038 -> 4083, i.e. **+45, exactly this suite**. The eight failing suites are all admin/P6-01 lane:

`admin-shell-session-lifecycle`, `admin-operations-list-pagination`, `admin-shell-server`, `admin-shell-platform-mount`, `admin-shell-render`, `admin-p6-01-shell-fixtures`, `adm-base-03-safe-error-offline.functional`, `admin-shell-router`.

No `legacy-*` suite fails.

## 8. What a wave fix should do, in order

1. **RV01-F1** — download is the only red that breaks a working client path rather than an error shape. Highest priority.
2. **RV01-F4** — 500-for-401 is the one red that will show up as an outage in every caller's logs.
3. **RV01-F2 / F3** — mechanical: pass an explicit `type` slug instead of deriving it from the title, and omit `detail` on the two routes legacy omitted it.
4. **RV01-F6** — answer 415 when `content-type` is not multipart, before decoding.
5. **RV01-F5** — close the `/api/v1/docs/*` table so an unknown slug 404s inside the legacy namespace.
6. Not a defect but a prerequisite for any of the above being *proven*: migration `0024` still needs one live run, and the harness still cannot see a real DB.