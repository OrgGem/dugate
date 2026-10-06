# ORCH-CANDIDATE-BUILD-FIX-891 — receipt (qwen_1, 2026-10-05)

Dispatch ORCH-CANDIDATE-BUILD-FIX-891. Lease: ONLY migration-candidates/orchestrator/**.
No gốc source, no commit, no tick.

## State before this fix (reported by Antigravity, re-confirmed)

- Antigravity ran `pnpm install` offline inside migration-candidates/orchestrator:
  396 packages installed, 0 errors.
- `node scripts/build.cjs` went from 146 errors (25 missing modules +
  ~121 implicit-any cascade) down to exactly 3 type errors.
- All 25 missing-module errors are gone (zod now installed).
- The remaining 3 were TS7053/TS7006 at
  services/connector/src/contract-grants.ts:28,33,35 — `signature`,
  `encodedHeader`, `encodedPayload` inferred `string | undefined` after
  `token.split(".")` under noUncheckedIndexedAccess.

## The fix (candidate copy only)

Inside the candidate file an additional runtime guard was inserted so the
TS narrowing is also honest at runtime:

    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token.");
    const [encodedHeader, encodedPayload, signature] = parts;
    // noUncheckedIndexedAccess types these as string | undefined; the check is
    // also a real runtime guard, because a token like `..` splits into three
    // EMPTY segments and would otherwise reach the HMAC.
    if (!encodedHeader || !encodedPayload || !signature) throw new Error("Invalid token.");

A type-cast-only fix (`parts as [string,string,string]`) was rejected: it
would silence TS but leave `..` reaching the HMAC. The guard closes that hole
and is the idiomatic noUncheckedIndexedAccess fix.

## Verification — REAL, not inferred from markers

| check | result |
|---|---|
| `node scripts/verify-isolation.cjs` | exit 0 — 616 TS files, 0 outside-repo relative imports, 0 workerSiblingReferences, businessesDirPresent false |
| `node scripts/build.cjs` | **exit 0**, output exactly `CANDIDATE_BUILD_OK`, no type errors |
| original source untouched? | `services/connector/src/contract-grants.ts` sha256 = `5771B232…` (unchanged); candidate copy = `E7F0FC95…` |

Re-running build changes: the prior 146 -> Antigravity install drops zod to 3 ->
this type guard drops the final 3 -> 0 errors, build exit 0.

## Honest residual notes

- This receipt does not re-run the full pnpm install; it trusts Antigravity's
  396-packages/0-errors report and the fact that the build output went from 146
  zh errors to 3 to 0.
- `verify-isolation` is a static proof (no escapes, no siblings); the green
  `tsc --noEmit` is the type-level proof that the isolated source is self-consistent.
  Neither proves an isolated DOCKER build with siblings absent-at-the-OS-level —
  that remains VFY-RPK-01 / PLAT-MIG-06 territory.
- The candidate fix is local to migration-candidates/orchestrator/**. Propagating
  the same one-line guard into the canonical services/connector/src/contract-grants.ts
  is a SEPARATE serialized-lease change and was NOT done.
