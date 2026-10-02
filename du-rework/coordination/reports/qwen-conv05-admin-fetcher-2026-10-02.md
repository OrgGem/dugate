# CONV-05 — Admin fetcher upstream-error sanitiser (one shared helper)

- **Date:** 2026-10-02. **Mode:** bounded refactor. **No gate ticked. No commit.**
- **Scope:** `services/orchestrator/src/app/admin/*-section-data.ts` + one new helper in `app/admin/`. `server.ts`, renderers, view-models, audit module and contracts untouched (read-only). No `tasks/*.md`, no `AGENTS.md`, no message to `nocobase-10`.

## 1. Before / after (measured, not estimated)

| File | before | after | delta |
|---|---|---|---|
| `api-key-section-data.ts` | 509 | 505 | −4 |
| `business-section-data.ts` | 383 | 376 | −7 |
| `connector-section-data.ts` | 566 | 562 | −4 |
| `operation-section-data.ts` | 1231 | 1227 | −4 |
| `overview-section-data.ts` | 851 | 847 | −4 |
| `profile-section-data.ts` | 637 | 633 | −4 |
| `upstream-error-body.ts` | — | 39 | **new** |

**Stated plainly, because it cuts against the usual framing: total line count went UP by 12** (−27 from the six fetchers, +39 for the helper). Most of the helper is a doc comment recording what it does and, more importantly, what it deliberately does not do. The win here is **single-sourcing**, not fewer lines — a claim of "removed 27 duplicated lines" would be misleading. The six call sites went from 4 duplicated lines each to one import plus one call.

New symbol: `sanitizeUpstreamErrorBody(text: string): string`, plus the exported cap `UPSTREAM_ERROR_BODY_MAX_CHARS = 256`. Six call sites renamed from the two former local names (`readErrorBody` ×4, `sanitiseErrorBody` ×2).

## 2. Why the extraction was safe (the comparison CONV-D02 asks for)

All six bodies were extracted and hashed before anything was removed. Every one is `if (!text) return ''` followed by the same 256-char slice and the same `C0+DEL → space` strip. Grouped by hash: four files identical (`1dca54ea…`), two identical (`26e8eced…`, differing only in the function name), and `business-section-data.ts` differing only by a two-line comment and an intermediate variable. **Zero behavioural difference** — this is a de-duplication, not a behaviour change.

Named `-ize` to match the surrounding admin code (`sanitizeFilterToken`, `sanitizeSortFilter`, `sanitizeAuditSeverityFilter`, `sanitizeOperationsListToken`); the two `-ise` call sites were the minority spelling. That is why `readErrorBody`/`sanitiseErrorBody` did not survive as aliases — keeping two names for one function would preserve the confusion this packet removes.

## 3. CONV-D02 exception — what was NOT extracted, and why

The status matrix was compared case by case before touching the payload parsers. It is **not** uniform, so `parseFetchPayload` / `buildOkFromCatalog` and the status mapping were left alone.

| Fetcher | 401/403 | 404 | other `!ok` | non-JSON |
|---|---|---|---|---|
| business | `{kind:'unauthorized', businessId, …}` | bespoke message with a ternary on `businessId` | `{kind:'error', businessId, …}` | fetcher-specific text |
| api-key | `{kind:'unauthorized'}` — **no id field** | `{kind:'not-found', keyId, …}` | `{kind:'error'}` — **no id field** | fetcher-specific text |
| connector | `{kind:'unauthorized', connectorId, …}` | bespoke (mentions revision) | `{kind:'error', connectorId, …}` | fetcher-specific text |
| profile | `{kind:'unauthorized', businessId, …}` | bespoke | `{kind:'error', businessId, …}` | fetcher-specific text |
| operation | `{kind:'unauthorized'}` — **no id field** | `{kind:'not-found', operationId, …}` with a ternary | `{kind:'error'}` — **no id field** | fetcher-specific text |
| **overview** | **`{__status: 401\|403}`** — a different result shape entirely | **no 404 branch** | **`{__err: …}`** marker object, with `\|\| \`HTTP ${status}\`` fallback | **`{__err: 'Non-JSON payload.'}`** |

Two blockers to a generic helper, both measured rather than asserted:
1. **The id field is not uniform.** `api-key` and `operation` omit it on `unauthorized` and `error`; `business`/`connector`/`profile` include it. A generic builder would need an "is this field present for this fetcher" parameter — it would encode the difference rather than remove it.
2. **`overview` is a different machine.** `asJson()` returns `{__status}` / `{__err}` marker objects, has an `allowDegradedHealth` 503 carve-out, no 404 branch, and different empty-text handling. Forcing it into the same shape would change its behaviour, which this packet forbids.

**Decision: extract the sanitiser only, record the rest as a CONV-D02 exception.** Unifying the payload parsers needs its own packet with its own equivalence matrix.

## 4. Verification

| Check | Result |
|---|---|
| `tsc --noEmit` orchestrator | **exit 0** |
| Focused set, 11 admin fetcher/boundary suites | **11 suites / 435 tests: 432 passed, 3 failed — all 3 proven pre-existing (below)** |
| `admin-error-boundary-offline.test.ts` (structural pin scanning every `*-section-data.ts`) | **PASS** |
| `adm-base-03` structural-pin block (same scan) | **PASS** — the one failing test in that file is a different `describe` |
| New `admin-upstream-error-body-offline.test.ts` | **PASS, 5 tests** |
| Largest file in `app/admin/` | `operation-section-data.ts` 1227 lines — **no file exceeds 2000**, before or after |
| Circular import | helper imports **0** modules; the six fetchers import it, nothing imports back |

### The 3 failures are pre-existing — proven by A/B, not asserted

Those tests are in files another lane is actively editing right now (`admin-shell-render.test.ts` shows as `M`, alongside seven new untracked per-section render suites and a deleted `admin-operations-list-pagination.test.ts`). That is circumstantial, so I ran a byte-exact A/B: the six fetcher files were backed up, overwritten with `git show HEAD:<path>` bytes, the suites re-run, then my bytes restored and **verified byte-identical**.

| Suite | with my change | at HEAD |
|---|---|---|
| `adm-base-03-safe-error-offline.functional.test.ts` + `admin-shell-platform-mount.test.ts` | 2 suites failed, 3 failed / 53 passed / 56 total | **identical, same 3 test names** |
| `admin-shell-render.test.ts` | 2 failed / 21 passed / 23 total | **identical, same 2 test names** |

Restoration confirmed byte-exact both times. So CONV-05 introduces **no new red**.

## 5. EOL — why this was done with a byte-preserving script

`app/admin/` is **mixed-EOL**, badly: `overview-section-data.ts` was 572 CRLF + 279 LF, `connector-section-data.ts` 544 + 22. A text-mode read/write would have silently normalised whole files and produced a diff of thousands of lines for a four-line change. The edit was therefore done with a script that splits on line boundaries *keeping each terminator* and splices, so untouched bytes are untouched.

Verified after: every file's **LF count is unchanged** (4, 4, 22, 0, 279, 12) and only the CRLF count fell by the removed lines. `git diff --numstat` for the six files: **12 insertions, 39 deletions** — no EOL churn.

## 6. Boundary recorded in the helper itself

`sanitizeUpstreamErrorBody` bounds and de-controls text. It does **not** redact: an upstream secret inside the first 256 characters still reaches the operator, exactly as before. The new test pins that limit explicitly (`does NOT redact…`), so a future redaction step cannot land silently and change what an operator sees. Stronger scrubbing is a per-fetcher decision and belongs next to each fetcher's own error mapping — which is exactly the mapping §3 shows is not uniform.

## 7. New test

`tests/admin-upstream-error-body-offline.test.ts` (5 tests, LF to match the tests directory): 256 cap; control characters injected and replaced with spaces; bounded on an all-control body; empty in → empty out so callers never emit a dangling colon; and the no-redaction boundary. Control-character sentinels are **injected into the input**, so the leak assertions are not vacuous.

## 8. Open / not done

- **CONV-D02 remainder:** `parseFetchPayload` / `buildOkFromCatalog` / status mapping deliberately not unified — see §3.
- **Not touched, out of scope:** `audit-section-data.ts` has no sanitiser copy (verified: 0 matches), so it was not modified.
- **Not done:** no commit, no gate tick, no live window used.

## RESUME POINT

- Packet **CONV-05** closed 2026-10-02. The admin sanitiser is single-sourced; six fetchers import `sanitizeUpstreamErrorBody`.
- **Reproduce:** `cd du-rework/services/orchestrator && npx jest tests/admin-upstream-error-body-offline.test.ts tests/admin-error-boundary-offline.test.ts tests/adm-base-03-safe-error-offline.functional.test.ts` → the two new/structural suites pass; `adm-base-03` carries one pre-existing failure (log sink) that reproduces identically at HEAD.
- **Baseline for the next lane:** 3 failures in that area (`adm-base-03` ×1, `admin-shell-platform-mount` ×2) plus 2 in `admin-shell-render` — all reproduced byte-exactly at HEAD by A/B, all inside files another lane is mid-edit on.
