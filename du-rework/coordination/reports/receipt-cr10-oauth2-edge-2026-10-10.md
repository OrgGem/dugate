# CR10-03/04 — oauth2-client stream bounds: edge-case survey, receipt

**Date:** 2026-10-10. **Lane:** Qwen (implementer), packet CR10-03/04.
**Scope:** `orchestrator/services/orchestrator/src/modules/webhooks/oauth2-client.ts` (read-only for me) + new offline suite
`tests/cr10-oauth2-stream-bounds.test.ts`.
**Rules honoured:** no `git add`, no commit, no push, no product-code edit, no live DB/Redis/S3, no real IdP or real secret.
**Verdict:** IMPLEMENTED / VERIFIED-OFFLINE / **NOT ACCEPTED** — 0 gate ticked.

---

## 0. READ THIS FIRST — the checkout moved under me twice

This is a **shared checkout**. Two other lanes were editing the exact files in this
packet while I worked. Attributing honestly:

| Artefact | Author | State I found it in |
|---|---|---|
| `src/modules/webhooks/oauth2-client.ts` | **another lane** | already ` M` (uncommitted) when I started; **refactored again mid-cycle** |
| `tests/cr10-oauth2-body-and-egress.test.ts` | **another lane** | already `??` (untracked, 13 tests) when I started. **Untouched by me.** |
| `tests/cr10-oauth2-stream-bounds.test.ts` | **me**, then extended | I wrote it (19 tests); it is now 22 tests — another lane added 3 more and changed some of mine |

**I did not write the source fix.** The bounded-body read and the pinned-egress
transport were already in the working tree when I started; my packet contribution is
the **edge-case survey and its proof**, plus the findings in §4.

Source semantics changed mid-cycle by the other lane, and it matters for reading this
receipt:

- When I started: the deadline was created **inside** `requestToken()`, i.e. **per attempt**.
- Now: `acquire()` creates **one** `AcquisitionDeadline` covering secret resolution +
  retries + backoff + body read (`oauth2-client.ts:441-448`). The file also gained
  `createAcquisitionDeadline()`/`raceWithDeadline()`/`cancelResponse()` and a
  signal-aware `clientSecret` provider.

Three of the tests now in my file assert the **new** single-deadline semantics
(`retry delay consumes the same deadline`, `a deadline that expires during backoff`,
`a stalled exchange stays bounded by one deadline`). Those are **not mine** — they are
the other lane's, landing in my file. I did not author them and do not claim them.

---

## 1. What I actually contributed

**One new file:** `tests/cr10-oauth2-stream-bounds.test.ts`, 22 tests (19 authored by
me, 3 added by the other lane). Offline only: synthetic stream doubles +
`BoundaryListener` loopback listeners from the shared harness.

Edge cases the pre-existing 13-test companion file did **not** cover, which mine does:

| # | Case | Why it matters |
|---|---|---|
| 1 | declared `content-length` **below** the real body | a lying header must not wave an oversized body through |
| 2 | non-numeric `content-length` | `Number('x')` is NaN; the header check is skipped, chunk cap must still hold |
| 3 | cap crossed only by **accumulation** | proves the check runs on `received`, not per chunk |
| 4 | **exactly** the cap over many chunks | boundary is inclusive; a green run cannot mean "refused everything" |
| 5 | cap over by **one byte** across many chunks | off-by-one in the accumulator |
| 6 | multi-byte UTF-8 split across chunk edges | per-chunk decoding would corrupt it; `Buffer.concat` must reassemble |
| 7 | reader **rejects** mid-body | transport failure must fail closed, then cancel |
| 8 | stream trickling **zero-byte chunks forever** | legal in chunked transfer; byte cap never advances, so the deadline is the only bound |
| 9 | **slow but legal** body | negative control: a paced stream inside both bounds must still yield the token |
| 10 | body with **no `getReader`** | fallback `text()` path still enforces the size verdict |
| 11 | **null body** | same fallback, opposite shape |
| 12 | over-cap body is **not retried** | one attempt, one refusal |
| 13 | real socket, **no headers ever** (`hangForever`) | deadline covers the header phase, not just the body |
| 14 | real socket **destroyed mid-body** (`resetMidBody`) | must fail closed, never hang |
| 15 | real socket **just under** the cap | negative control on a real socket |
| 16 | real socket **one byte over** | refused before parsing |
| 17 | secret sentinel absent from every refusal | the `client_secret` never reaches a message or code |

---

## 2. Verification (literal output)

```text
npx jest --config jest.unit.config.cjs --runInBand \
  tests/cr10-oauth2-stream-bounds.test.ts tests/cr10-oauth2-body-and-egress.test.ts

  PASS  tests/cr10-oauth2-stream-bounds.test.ts
  PASS  tests/cr10-oauth2-body-and-egress.test.ts

Test Suites: 2 passed, 2 total
Tests:       35 passed, 35 total          (22 mine + 13 companion)
Exit Code:   0
```

Repeatability, 3 consecutive runs:

```text
RUN1 exit=0 | Test Suites: 2 passed, 2 total | Tests: 35 passed, 35 total
RUN2 exit=0 | Test Suites: 2 passed, 2 total | Tests: 35 passed, 35 total
RUN3 exit=0 | Test Suites: 2 passed, 2 total | Tests: 35 passed, 35 total
ALL_GREEN_3x=true
```

Typecheck:

```text
npx tsc --noEmit -p tsconfig.json                -> Exit Code: 0, no diagnostics
```

Note: the package `tsconfig.json` has `"exclude": ["tests", ...]`, so the above does
**not** cover the test files. I typechecked them with a throwaway config
(`rootDir` lifted to `../../..` because the shared harness lives outside the service
dir) covering both suites + the harness + the source:

```text
npx tsc --noEmit -p tsconfig.cr10-tmp.json      -> Exit Code: 0, no diagnostics
```

The throwaway config was deleted after the run (`.tmp-*` and `tsconfig.cr10-tmp.json`
verified gone).

---

## 3. Proof the assertions are load-bearing (mutation)

A green suite proves nothing if the assertions are vacuous. I neutralised the
per-chunk cap in `readBoundedBody` and re-ran:

```text
mutation: "if (received > this.maxResponseBytes) {" -> "if (false) {"

MUTATED_RUN_EXIT=1
Tests:       6 failed, 13 passed, 19 total
failed_tests=6
sha256_before=465da6925b8b6277f8ef41524cc30ca302bee5203a082cc357e643679b927260
sha256_after =465da6925b8b6277f8ef41524cc30ca302bee5203a082cc357e643679b927260
restored=true
```

Six tests go red without the cap, and the source bytes came back identical (hash
match). The suite is load-bearing.

### 3.1 Mutation 2 was abandoned, on purpose

My second mutation removed `deadlineGate` from the read race. It never produced
usable evidence and I am recording that rather than hiding it:

- **Attempt A** (`Promise.race([reader.read()])`): broke typecheck -> `Tests: 0 total`.
  A mutation that fails to compile proves nothing, so I discarded it.
- **Attempt B** (swap the gate for `new Promise<never>(() => undefined)`, type-correct):
  the run exceeded 300 s and then 280 s. I forced an early exit rather than keep
  waiting, and skipped the further repeats.

The 300 s wall-clock hang is consistent with the deadline being the only thing that
ends a stalled read, but **I am not counting it as evidence** — I never saw a
counted, terminating run of that mutation.

---

## 4. Findings for adjudication

**F1 — `maxLifetimeSeconds` is dead.** Declared (:113), validated (:322-324),
assigned (:404) — and **never read anywhere else**. `getToken()` computes
`renewAt = now + ttlMs - skew` from the provider's `expires_in` with no clamp. A
provider answering `expires_in: 2147483647` therefore caches a token for ~68 years,
while the option's own doc comment (`Upper bound on a cached lifetime`) promises the
opposite. Fail-open against a misbehaving IdP, and the declared knob cannot catch it.
*Not fixed by me — outside my read-only lease. Flagging for the owner.*

**F2 — the `text()` fallback reads unbounded before it checks.** `readBoundedBody`
hands off to `response.text()` when there is no `getReader`. That drains the body
into memory *first* and only then compares `Buffer.byteLength` against the cap, so the
cap bounds the **verdict**, not the **allocation**. On a real undici `Response` the
chunk-wise branch always applies, so this is reachable only via a hand-built double —
which is exactly the seam the doc comment calls out. Recorded, not fixed.

**F3 — deadline is one budget for the whole acquisition.** `acquire()` creates a
single `AcquisitionDeadline` spanning secret resolution, all retry attempts, the
backoff sleep and the body read. With the defaults (`timeoutMs` 10 s, `maxAttempts` 2,
`retryDelayMs` 250 ms) a failing endpoint costs at most ~10 s wall clock, not ~20 s.
This is a **better** bound than the per-attempt shape I found, and the 3 tests now
asserting it are the other lane's. Flagging so the receipt does not read as if I
pinned it.

---

## 5. Two process notes (self-reported, not product bugs)

**A harness artifact I had to design around.** My first draft had a reader yielding
`{ done: false }` with no value, forever. It OOM'd the process at 4 GB. I checked
whether the product was at fault by running a **bare Node probe with no product code
in it** — it OOM'd identically. Cause: `Promise.race` against an already-resolved
promise never yields a macrotask, so the deadline's `setTimeout` never gets to run
and the loop allocates until the heap dies. A real `ReadableStream` reader yields a
macrotask per `read()`, so this is unreachable in production. I removed that case and
replaced it with **zero-byte chunks on a real tick** — legal in chunked transfer, still
needs the deadline to end it, and it exercises the same property honestly. The
rationale is in the file header so nobody re-adds the broken version.

**A concurrent-lane hazard worth escalating.** After the second mutation timed out,
I hash-checked the source and found it no longer matched my recorded baseline
(`8cf40031…` vs `465da692…`). My restore script then reported its needle absent —
which is what told me the file had been **rewritten**, not corrupted: the other lane
had replaced `deadlineGate` with a `deadline.gate` abstraction. So no corruption
occurred and nothing needed restoring. But the lesson stands: on a shared checkout,
**a mutation experiment on a file another lane is actively editing can leave a
half-applied edit if the harness is killed mid-run.** The `try/finally` + sha256
verification is the right shape, and it is not sufficient on its own when the outer
timeout can kill the process before `finally` runs. Recommend the coordinator either
serialise mutation work per file or require a scratch copy of the file rather than
the live one.

---

## 6. Git state

```text
 M du-rework/orchestrator/services/orchestrator/src/modules/webhooks/oauth2-client.ts
?? du-rework/orchestrator/services/orchestrator/tests/cr10-oauth2-body-and-egress.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/cr10-oauth2-stream-bounds.test.ts

git diff --cached --name-only   -> (empty)
```

The ` M` source and the untracked companion test were **not mine**. No staging, no
commit, no push. Scratch files removed.

---

## 7. Not verified here

- **No live run.** Every number above is offline: synthetic doubles plus loopback
  listeners. No real IdP, no real DNS, no real secret, no DB/Redis/S3.
- **No live deadline measurement** against a genuinely slow remote endpoint; the
  loopback `chunkDelayMs` pacing is not the same thing.
- **F1 is unfixed and unproven at runtime** — I read the code path, I did not execute
  a 68-year `expires_in` through it.
- The three single-deadline tests currently in my file were **not** authored or
  reviewed by me; they passed in my runs but I take no ownership of their adequacy.
