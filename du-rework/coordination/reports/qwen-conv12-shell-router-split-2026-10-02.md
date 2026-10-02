# CONV-12 — `shell-router.ts` split

**Task:** CONV-12 (plan `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` §CONV-12) · **Date:** 2026-10-02 · **Status:** implemented and verified. No gate ticked, no commit, no `tasks/*.md` / AGENTS.md edit.

## 1. Before / after (literal)

`shell-router.ts` measured by `Get-Content … .Count` (PowerShell), which is how the coordinator's 1.916 figure was produced.

| file | before | after |
|---|---|---|
| `shell-router.ts` | **1916** | **447** |
| `shell-router-shared.ts` | — (new) | 396 |
| `section-dispatch.ts` | — (new) | 595 |
| `auth-dispatch.ts` | — (new) | 321 |
| `mutation-dispatch.ts` | — (new) | 118 |
| `crypto-config-dispatch.ts` | — (new) | 294 |

**447 < 1500.** The threshold is met with 1053 lines of headroom, not by trimming — every removed line moved to a named module.

## 2. Module map

The packet suggested `{section,auth,mutation}-dispatch.ts` plus crypto-config. I used those names and added one more (`shell-router-shared`) because the cycle requirement forces it — see §4.

| module | owns | lines |
|---|---|---|
| `shell-router.ts` | `matchShellRoute`, `dispatchShellRequest`, `dispatchShellRequestAsync`, and the re-export surface | 447 |
| `shell-router-shared.ts` | `ShellRuntimeConfig`, `SectionFetchers` + the 7 `*SectionFetcher` interfaces, `OperationListQuery`, `CryptoConfigPaneResolver`, `CryptoConfigApply`, `parseQueryString`, `parseOperationListQuery` | 396 |
| `section-dispatch.ts` | `handleSectionGet`, `handleAuditGet`, and the 7 `resolve*Extras` / `read*FromRequest` helpers | 595 |
| `auth-dispatch.ts` | `deriveRoleFromToken`, `handleLoginGet/Post`, `handleLogout`, `legacyCookiePosture`, and the async session gate (`toFlowRequest`, `joinSetCookie`, `resolveOpaqueSession`, `liveSessionClaims`, `sessionAuditEventFor`) | 321 |
| `mutation-dispatch.ts` | `csrfTokenForRequest`, `handleAdminMutationPost` | 118 |
| `crypto-config-dispatch.ts` | the registration registry, `registerCryptoConfigWiring`, `cryptoConfigPaneResolver/Applier`, `handleCryptoConfigGet/Post` | 294 |

**Method:** declarations were moved **verbatim** by a script that chunks the file on top-level declarations with a comment/string-aware brace scanner, buckets them by symbol name, and regenerates the import/export statements. **44 chunks, 0 unclassified, 0 unbalanced.** No declaration body was edited; the only hand edits were three `export`/re-export corrections the generator got wrong (recorded in §6).

## 3. Invariants held

Everything below is asserted by the unchanged tests in §5, not by inspection.

- **`dispatchShellRequest` / `dispatchShellRequestAsync` signatures unchanged** — still exported from `shell-router.ts` with identical parameters and return shapes.
- **URL matcher precedence unchanged** — `matchShellRoute` stayed in `shell-router.ts` and was not touched.
- **All 20 original exports still resolve from `shell-router.ts`**, so `server.ts:65` (`registerCryptoConfigWiring`), `shell-server.ts:28,32,39` (`dispatchShellRequestAsync`, `ShellRuntimeConfig`, `parseCookieHeader`, `parseFormBody`, `parseQueryString`) and `app/admin/index.ts:38-40` are **byte-untouched**.
- Cookie mint/clear, CSRF, session revocation, role gate, GET/POST routing, `deferredSectionExtras`, redirect and `no-store` all live in moved code that was not edited.

## 4. Why `shell-router-shared.ts` exists (no import cycle)

Three symbols could not stay in the router without creating a cycle, because the dispatch modules need them:

- `parseOperationListQuery` — used by `section-dispatch`; if it stayed in `shell-router.ts`, that would be `section-dispatch -> shell-router -> section-dispatch`.
- `parseQueryString` — same dependency.
- `CryptoConfigPaneResolver` / `CryptoConfigApply` — referenced by the shared interfaces, and needed by `crypto-config-dispatch`.

Moving them into one leaf module resolves all three. The resulting graph is a DAG, verified by grepping every intra-group import:

```
shell-router-shared        (no intra-group import — it is the leaf)
  ^        ^        ^
  |        |        |
crypto-config-dispatch   auth-dispatch   mutation-dispatch
        \         |         /
         section-dispatch --/        (also -> shell-router-shared)
  \        |        |        |
   \_______|________|________|
          shell-router.ts
```

**No module imports `shell-router.ts`, and `shell-router-shared.ts` imports nothing from this directory.** One spurious edge was found and removed: the generator had emitted `shell-router-shared -> auth-dispatch` for `legacyCookiePosture`, which appears in that file only in a **doc comment** (`shell-router-shared.ts:149`), never in code. Left in place it would have been a real runtime cycle.

## 5. Verification (literal)

```
cd services/orchestrator
npx tsc --noEmit -p tsconfig.json        -> exit 0, no output
npx jest --runInBand \
  --testPathPatterns "admin-shell-oidc|admin-crypto-config|admin-audit-route|oidc-cookie-secure|admin-oidc04-claims"
                                        -> Test Suites: 9 passed, 9 total
                                           Tests:       290 passed, 290 total
```

These 9 focused suites cover the session gate, the router matcher, mutation/CSRF and the crypto-config pane — i.e. exactly the four responsibilities being moved.

**Full-suite A/B.** Because 8 suites fail on this repo for reasons unrelated to this task, the only meaningful check is a same-session before/after:

| run | Test Suites | Tests |
|---|---|---|
| pre-split (`git checkout shell-router.ts`, modules removed) | 8 failed, 127 passed | **28 failed, 4088 passed** |
| post-split | 8 failed, 127 passed | **28 failed, 4088 passed** |

Identical counts **and** the identical failing set: `admin-operations-sql`, `admin-shell-server`, `admin-shell-platform-mount`, `admin-shell-session-lifecycle`, `admin-p6-01-shell-fixtures`, `admin-shell-render`, `adm-base-03-safe-error-offline.functional`, `admin-shell-router`. **No regression.**

## 6. Two things worth recording

**A flake, caught rather than shipped.** An earlier post-split full run reported **9 failed / 29 tests**, with `admin-operations-sort-http-offline` newly failing. Re-running gave 8/28 — identical to pre-split. That suite binds a **fixed** port (`46_800 + pid % 20`, same pin documented in the RV01 suite), so it is sensitive to run conditions. **I am not claiming the suite is deterministic**; the claim is only that two runs of the split match the pre-split run exactly. If a future run shows 9 again, that suite is the first suspect.

**The generator needed three hand corrections** (all mechanical, all now in the tree):

1. `auth-dispatch.ts` — `async function resolveOpaqueSession` needed an `export`; the generator located declarations by the chunk's first line, which is the leading comment, not the declaration.
2. `shell-router.ts` tail — the generator emitted a duplicate `export type { ShellRuntimeConfig }` plus a value-style `export { …, CryptoConfigApply, … }` where `CryptoConfigApply` is a type. Replaced with one clean value re-export and one type re-export.
3. `shell-router-shared.ts` — removed the comment-only `legacyCookiePosture` import described in §4.

## 7. Not done / out of scope

- **`server.ts` untouched by this task** — no ` M ` entry for it.
- **`shell-server.ts`: I did not modify it**, but `git status` currently shows ` M` for it and for `connector-section-renderer.ts`, `business-section-data.ts`, `api-key-section-data.ts`, `connector-section-data.ts`, `operation-section-data.ts`, `overview-section-data.ts` and `profile-section-data.ts`. **None of those are my edits** — another lane is writing `src/app/admin/` concurrently while this task runs. Recorded so the next reader does not attribute them to CONV-12.
- Those concurrent edits do not undermine this split: `shell-server.ts` imports only `dispatchShellRequestAsync`, `ShellRuntimeConfig`, `parseQueryString`, `parseCookieHeader` and `parseFormBody` from `shell-router.ts`, and all five still resolve there (§3). Re-verify with a fresh full-suite run before relying on §5 if the other lane's work lands in the meantime.
- No behaviour, signature, matcher or header was changed. This is a relocation only.
- The 8 failing suites belong to the admin/P6-01 lane and were failing before this task; they are not addressed here.

**No gate is ticked by this receipt.**