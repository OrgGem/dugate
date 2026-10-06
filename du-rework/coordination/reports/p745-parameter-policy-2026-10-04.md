# P745-PARAMETER-POLICY (MEDIUM-1) — receipt — 2026-10-04

**Packet:** `coordination/dispatch-specs/2026-10-04-2333-P745-PARAMETER-POLICY.md` (lane qwen_1).
**Prep source:** `coordination/reports/p730-medium1-prep-2026-10-04.md` (lane cc_1).
**Mode:** offline-only; no commit/push/reset; literal Exit Code from wrapper; SKIP != PASS.
**Lease:** `modules/profiles/policy.ts`, `modules/profiles/profiles.ts`, new tests `p730-medium1-*`.
**Read-only:** `submission.ts`, contracts, migrations, dispatcher/BFF.

## 0. TL;DR

- **Scope C (reserved-key deny + key-allowlist)** landed in `policy.ts`: `__proto__`/`constructor`/`prototype` are refused on the client path (400) and skipped on the stored/read path. The allowlist (declared ∪ defaults) already existed and is unchanged.
- **A-lite** landed in `profiles.ts`: the client-supplied `parameters` branch of `carryForwardPolicy` is now validated by a new `parseWriteParameters` (reserved keys → strict shape → caps), fail-closed 422 **before** the INSERT.
- **Admin-trusted pin** landed as tests only: a sentinel secret in a value is stored verbatim, unredacted. No scanner exists and none was added.
- **No contracts change.** `ProfileParametersSchema` stays `value: z.unknown()`; caps live in the service layer.
- **40 new tests, 3× literal exit 0.** Mutation probe: 3 mutations, each turning exactly the right tests RED for the right reason.
- **One real bug found and fixed** (not in the packet): `value: z.unknown()` makes `value` OPTIONAL in zod, so the write schema accepted `{isLocked:true}` — which the read path then silently drops. Write and read now agree.

## 1. Measured: the prototype vector (probe before conclusion)

Per the prep receipt's own limitation ("pin trước khi kết luận exploit"), the behaviour was measured before any fix. Probe: `.qwen/tmp/p745-probe.js`, run with `node`, exit 0.

| # | Measurement | Result |
|---|---|---|
| 1 | `JSON.parse('{"__proto__":{...}}')` — own key? | **YES** (own enumerable) |
| 1 | `Object.entries` surfaces it? | **YES** |
| 1 | `parsed.polluted` | `undefined` (prototype NOT set by parse) |
| 2 | `merged['__proto__'] = obj` — own key? | **NO** |
| 2 | `merged.polluted` | **`'yes'`** |
| 2 | `Object.getPrototypeOf(merged) === Object.prototype` | **FALSE** |
| 2 | `({}).polluted` (the realm) | **`undefined`** |
| 3 | `m2['constructor'] = obj` → `m2.constructor.polluted` | **`'yes'`** (own prop shadows) |
| 4 | `{...merged}` copies the prototype-set prop? | **NO** (spread copies own keys only) |

**Conclusion, stated precisely:** the vector is a **per-object prototype set on the result object**, NOT realm-wide `Object.prototype` pollution. `({}).polluted` is `undefined` both before and after the fix.

### 1.1 The packet's acceptance assertion is vacuous

`({}).polluted === undefined` passes on unpatched code. It is kept as a baseline test but is **not** load-bearing. The assertions that actually fail pre-fix are on the result object:

```ts
expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
expect(merged.polluted).toBeUndefined();
```

Under mutation 1 the first of these failed with `Object { "polluted": "yes" }` received — the attacker object as the prototype. That is the proof.

### 1.2 Where the deny is load-bearing vs defence-in-depth

Mutation 1 (disable every `isReservedParameterKey` check) turned **4** tests RED:

| Test | RED? | Why |
|---|---|---|
| `recognizes exactly the three reserved keys` | YES | the helper itself |
| `NON-VACUOUS: a stored __proto__ default is skipped` | YES | **the real vector** — stored row reaches the assignment |
| `refuses a reserved key at the write boundary with 422` | YES | `parseWriteParameters` |
| `createRevision … reserved __proto__ key BEFORE the INSERT` | YES | the `profiles.ts` wiring |
| `refuses a client-supplied __proto__ key with 400` | **no** | the allowlist already blocks it (not declared, not stored) |

So on the **client** path the deny is defence-in-depth (the allowlist blocks it incidentally, and only because no manifest declares such a key). On the **write/read** paths it is the real fix: an admin-controlled key reaches `out[key] = …` directly via `parametersFromFlatValues` / `coerceRowParameters`.

## 2. Changes

### 2.1 `policy.ts` (sha256 `54F21B5A0089`)

**New exports:**

| Export | Purpose |
|---|---|---|
| `isReservedParameterKey(key)` | the 3-key deny set |
| `PROFILE_PARAMETER_MAX_KEYS = 64` | service-side cap (not in contracts) |
| `PROFILE_PARAMETER_MAX_VALUE_LENGTH = 8192` | service-side cap (not in contracts) |
| `parseWriteParameters(raw)` | write-boundary validator → `ProfileParameters` |

`parseWriteParameters` runs three checks in this order, each fail-closed 422 `INVALID_SCHEMA`:

1. **Reserved keys** — checked on the RAW object *before* the zod parse, so a crafted key never reaches a zod record assignment.
2. **Strict shape** — `ProfileParametersSchema.safeParse`.
3. **Caps** — key count, then per-value size (`parameterValueSize`: strings by `.length`, everything else by `JSON.stringify` length; circular/non-serializable → `Infinity` → 422).

**Guarded functions:** `mergeParameters` (client deny + stored-default skip), `coerceRowParameters` (skip), `coerceProfileParameters` (returns a sanitized **copy**, never the caller's object), `parametersFromFlatValues` (skip).

### 2.2 `profiles.ts` (sha256 `3F89A5E3E6977`)

`carryForwardPolicy` — the client-supplied branch only:

```ts
const parameters =
  has('parameters') && policy.parameters !== null
    ? parseWriteParameters(policy.parameters)
    : (previous?.parameters ?? {});
```

Two deliberate choices, both commented in the code:

- **`parameters: null` keeps its legacy meaning** ("clear" → `{}`). The old INSERT coalesced `null ?? {}` to `{}`; rejecting it would 422 a legacy client for a gesture that used to work.
- **The carried-forward branch is NOT re-validated.** It is already stored, and `coerceRowParameters` reads it tolerantly. Re-checking it would strand a live profile on a legacy row shape. Pinned by the test `a carried-forward legacy shape is NOT re-validated`.

## 3. Bug found (not in the packet)

`ProfileParameterValueSchema` is `z.object({ value: z.unknown(), isLocked: z.boolean().optional() }).strict()`. Because `z.unknown()` includes `undefined`, **zod treats `value` as optional** — so `{ isLocked: true }` parses successfully.

The read path disagrees: `isProfileParameters` and `coerceRowParameters` both require `'value' in c` and **silently drop** an entry without it.

Net effect before the fix: a writer could store `{isLocked:true}` and every subsequent read would drop it — silent data loss, with no error anywhere.

Fixed by requiring an own, non-`undefined` `value` in `parseWriteParameters`, so **what is stored is what reads back**. Pinned by `refuses an entry with no \`value\` BEFORE the INSERT` and `write/read agreement: what is stored reads back unchanged`.

## 4. Tests

| File | sha256 (short) | Tests |
|---|---|---|
| `tests/p730-medium1-parameter-policy.test.ts` | `F294EA697B054` | 30 |
| `tests/p730-medium1-write-validation.test.ts` | `4CE74B23AB6BE` | 10 |

**Literal exit codes (wrapper `Exit Code:` line):**

| Run | Suites | Tests | Exit Code |
|---|---|---|---|
| new suites ×1 | 2 | 40 passed | **0** |
| new suites ×2 | 2 | 40 passed | **0** |
| new suites ×3 | 2 | 40 passed | **0** |
| profile regression set | 10 | 219 passed | **0** |

Regression set = the 2 new suites + `p730-prof03-invariant1`, `p730-prof03-publish-cas`, `p730-profile-snapshot`, `w1-sub02-snapshot-secret`, `w1-sub03-sourceurl-extension`, `aweb04-bff-profiles`, `admin-profile-render`, `admin-profile-view-model`.

### 4.1 Acceptance mapping

| Packet acceptance | Where | Result |
|---|---|---|
| proto denied, `({}).polluted undefined` | `scope C: reserved-key deny` (last test) | PASS (recorded as non-load-bearing, see §1.1) |
| proto denied, non-vacuous | `NON-VACUOUS: a stored __proto__ default is skipped` | PASS, RED under mutation 1 |
| unknown key → 400 | `refuses an unknown key with 400 PROFILE_UNKNOWN_FIELD` | PASS |
| locked key → 400 | `refuses a locked key with 400 even when the value is identical` | PASS |
| oversized / too-many → 422 | 4 tests in `A-lite: write-path caps` + 4 in `createRevision write validation` | PASS, RED under mutations 2/3 |
| admin-trusted pin | 4 tests in `scope 3: admin-trusted pin` + `ADMIN-TRUSTED PIN: a sentinel secret is stored verbatim` | PASS |
| focused tests literal | 3× exit 0 above | PASS |

## 5. Mutation probe (load-bearing proof)

| # | Mutation | RED | Verdict |
|---|---|---|---|
| 1 | `isReservedParameterKey` → always `false` | 4/40 | load-bearing; the NON-VACUOUS test failed with the attacker object as `merged`'s prototype |
| 2 | key-count cap bypassed (`if (false && …)`) | 2/40 | load-bearing, exactly the 2 key-cap tests |
| 3 | `profiles.ts` wiring removed (raw `policy.parameters`) | 4/40 | load-bearing, exactly the 4 write-path 422 tests; the unit suite stayed green, proving the wiring is what makes `createRevision` refuse |

All three mutations reverted; `grep MUTATION` over `src/modules/profiles` returns no matches.

## 6. Typecheck

`npx tsc --noEmit -p tsconfig.json` → **Exit Code: 0, 0 errors**.

Note: an earlier run in this session reported one error at `submission.ts:649` (`promptOverride: string | null` vs `string`). `git diff HEAD` on that file does not contain `promptOverride`, so it was **pre-existing in the committed baseline**, not caused by this packet. It was fixed on the shared checkout by another lane while this receipt was being written — the final typecheck above is clean.

## 7. Full `test:unit` — no P745 regression

`pnpm run test:unit` → `Test Suites: 12 failed, 10 skipped, 155 passed, 167 of 177 total`; `Tests: 36 failed, 89 skipped, 4458 passed, 4583 total`.

The 12 failing suites, and why none is attributable to P745:

| Suite | Cause |
|---|---|
| `admin-shell-session-lifecycle`, `admin-shell-platform-mount`, `admin-shell-server`, `admin-shell-router`, `admin-shell-render`, `admin-p6-01-shell-fixtures`, `admin-local-user-repository` | the known pre-existing admin-shell set (7 suites) |
| `br12-isolation-offline` | known pre-existing (`declaredParameterKeys(undefined)` TypeError in Phase-2 code) |
| `enc-meta-sentinel-runtime-refs` | known deliberate RED gap detector |
| `oidc02-multi-replica-offline` | session object gained `issuer`/`principalId` — a SEC-lane commit landing concurrently |
| `p8-01-audit-entity-offline` | audit-entity INSERT param validation — an audit-lane change |
| `runtime-encryption-metadata` | expected-subsystem ref list — encryption-lane change |

None of these modules import `profiles/policy` or touch parameter handling; the failure texts are in session shape, audit params and encryption refs. P745's own 10-suite regression set is 219/219 green.

## 8. Deviations / notes for other lanes

1. **`parsePolicy` was NOT wired at upsert.** T-API-02 is still closed — `profile.upsert` is absent from `ADMIN_ACTIONS` (`dispatcher.ts`), so there is no upsert to wire. Instead the validation is applied **service-level in `createRevision`**, which is strictly broader: it covers the admin route, a future upsert, import and any manual writer, without waiting for the dispatcher. When T-API-02 opens, the dispatcher can call `parsePolicy` for the whole-object strict check.
2. **Do NOT run `parsePolicy` wholesale inside `carryForwardPolicy`.** `ProfileEndpointPolicySchema.fileUrlAuthConfig` is `.optional()`, so `fileUrlAuthConfig: null` — the explicit "clear the stored secret" gesture — would fail strict validation and 422 a legitimate admin action. Validate the `parameters` half only, as done here.
3. **Caps values are this lane's choice** (64 keys / 8192 bytes); the packet did not specify them. Flagged for coordinator/security sign-off. They are service-side constants, not contracts, so they are cheap to change.
4. **`coerceProfileParameters` now returns a copy.** It had zero callers in `src`, so nothing breaks; noted in case a future caller relied on identity. 5. **WARNING - prefix collision with another lane.** `tests/` also contains `p745-prompt-carrier-claim.test.ts`, `p745-prompt-carrier-producer.test.ts` and `p745-prompt-producer-impl.test.ts` (packet `P745-PROMPT-CARRIER-*`) - a DIFFERENT packet sharing the `P745` number. This receipt is unambiguously `P745-PARAMETER-POLICY`; the two must not be merged. If `P745` is meant to be unique per packet, the dispatch numbering needs a coordinator-side fix.

## 9. Limitations

- Caps are per-value and per-map; there is no aggregate cap on the whole `parameters` JSON. A 64-key map of 8 KB values is ~512 KB per revision, and the snapshot copies it per operation. Not measured against a real DB.
- The write-path tests use an in-memory fake with a committed/pending split (same shape as the DD-05 fake). They prove ordering and absence of the INSERT, not real PG behaviour.
- No live run: MEDIUM-1 core needs no live infra (per the prep receipt), and this lane has no DB/Redis window.
- `parseWriteParameters` bounds what an admin may persist; it does not bound what a **public client** may put in `effectiveInput` (T3 in the prep threat model). That path is still bounded only by the action's AJV schema. Out of this packet's scope.

READ-ONLY compliance: `submission.ts`, contracts, migrations, dispatcher and BFF were read only. Files written: `policy.ts`, `profiles.ts`, the two test files, and this receipt.