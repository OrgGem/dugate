# CONV-12 independent verification

Read-only verification against the current working tree; no source/test edits, gate ticks, or commits.

## Independent line counts

Counted with `[IO.File]::ReadAllLines(path).Length`:

| File | Lines | Receipt claim | Result |
|---|---:|---:|---|
| `services/orchestrator/src/app/admin/shell-router.ts` | 447 | 447 | match; below 1,500 |
| `services/orchestrator/src/app/admin/shell-router-shared.ts` | 396 | 396 | match |
| `services/orchestrator/src/app/admin/section-dispatch.ts` | 595 | 595 | match |
| `services/orchestrator/src/app/admin/auth-dispatch.ts` | 321 | 321 | match |
| `services/orchestrator/src/app/admin/mutation-dispatch.ts` | 118 | 118 | match |
| `services/orchestrator/src/app/admin/crypto-config-dispatch.ts` | 294 | 294 | match |

## Commands and results

Working directory: `D:\Git\dugate\du-rework\services\orchestrator`.

| Command | Result | Exit |
|---|---|---:|
| `npx tsc --noEmit -p tsconfig.json` | no output, clean | 0 |
| Focused Jest (exact invocation below) | 9 suites passed; 290 tests passed | 0 |

Exact focused Jest command from receipt §5: `npx jest --runInBand --testPathPatterns "admin-shell-oidc|admin-crypto-config|admin-audit-route|oidc-cookie-secure|admin-oidc04-claims"`.

## Invariants

- Parsed the committed `HEAD` version and current `shell-router.ts` with the TypeScript AST. `matchShellRoute`, `dispatchShellRequest`, and `dispatchShellRequestAsync` are present; all three signatures match `HEAD`, and all three function bodies match `HEAD` byte-for-byte after AST extraction. Thus `matchShellRoute` matching/precedence is unchanged.
- `shell-server.ts` currently imports `dispatchShellRequestAsync`, `ShellRuntimeConfig`, `parseCookieHeader`, `parseFormBody`, and `parseQueryString` from `shell-router.ts`; all five names are exported by that module. The focused suites and typecheck also pass against these imports.
- AST check found no duplicate exported names in `shell-router.ts`.
- Intra-group import graph is acyclic: `shell-router` imports the dispatch modules/shared types; `section-dispatch` imports crypto, mutation, auth, and shared; auth, mutation, and crypto import shared; `shell-router-shared` imports none of the group. No module imports back into `shell-router.ts`; cycle check returned false.

At verification start, `shell-server.ts` and several sibling admin files were already marked modified in the worktree by concurrent work. This verification only read them; the invariant results above describe their current state.

## Verdict

The file-size claims match the receipt, TypeScript reports no errors, all 9 focused suites pass, and the checked router APIs/import graph retain the claimed invariants. No claim failed to reproduce.
