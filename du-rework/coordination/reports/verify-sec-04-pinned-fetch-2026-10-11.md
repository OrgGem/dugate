# Receipt SEC-04V - pinned fetch verification - 2026-10-11

| Field | Value |
|---|---|
| Task ID | SEC-04V |
| Date | 2026-10-11 |
| Repo scope | `du-rework` |
| Verifier | Qwen-C, terminal `term_c89675a0-351a-47cc-8c4d-21fb29d5d41a` |
| Implementer | Codex, terminal `term_cd3c19e4-9328-4f99-bc26-8b87f195a5e4` — **a different terminal**, so the verifier-is-not-the-implementer rule holds |
| Lease | READ-ONLY. Nothing edited, no build run, no change to test, config, migration or compose |
| Repo state | `D:/Git/dugate/du-rework`, HEAD `d0b22104e3f9fcda095bc75c9588fac8afac38f3`, Node v24.21.0 |
| Verdict | **PASS on source, FAIL on the shipped artifact** — see §1 |
| Bound honoured | no `git add` / commit / push, no gate ticked, no ciphertext or secret printed, **zero ASCII double quotes in this file** |

---

## 0. Headline

The HTTP 204 repair is **correct and verified in `src`**, and it is **still broken in the `dist`
artifact that a workspace consumer actually loads**. Two green prior runs are both source-side, which
is exactly why neither noticed.

---

## 1. Verdict

| Check | Result |
|---|---|
| `pnpm --dir orchestrator/packages/egress test` | **PASS** — 35/35, 3 suites, exit 0. Proves the **source** repair |
| `tsc --noEmit -p tsconfig.json` in egress | **PASS** — exit 0, no diagnostics |
| My probe A, loading `dist/pinned-fetch.js` | **FAIL** — `status=1, signal=null`, `TypeError: Response constructor: Invalid response status code 204` at `dist/pinned-fetch.js:252` |
| My probe B, transpiling `src/pinned-fetch.ts` in memory | **PASS** — 14/14, `status=0, signal=null`, stderr empty |
| Combined | `DIST_STALE_SOURCE_FIXED = true` |

Both probes **self-terminated** (`signal=null`). Probe A died of an **uncaught exception** (exit 1),
which is the shape of the original defect, not a crash-by-signal.

---

## 2. Finding — the fix is two days newer than the artifact it belongs in

```text
src : 2026-10-10T17:23:02Z  20401B  sha256 8fd4b2116e868338ff150a69f51bf762ac5a4ce88bebfa823589625c48d4543a
dist: 2026-10-08T18:46:40Z  15454B  sha256 8ea2f0fa1acf...   (1 day 22h 36m older than the fix)
```

Enumerating every `Response` construction site in each file:

```text
src   2 sites
      :370   fulfill(new Response(null, responseInit));   <- null body for HEAD/204/205/304
      :375   fulfill(new Response(web, responseInit));    <- real body
      exactly ONE null-body decision, at :358

dist  1 site
      :252   fulfill(new Response(web, { status: responseStatus, ... }))
      ZERO occurrences of hasNoBody / 204 / 205 / 304
```

The source has the branch and does not crash. The artifact has only the body path and crashes. The
source repair is sufficient; the build simply predates it.

### The artifact is a live consumer path, not a dev leftover

```text
orchestrator/services/orchestrator/package.json:27    @du/egress : workspace:*
orchestrator/services/orchestrator/node_modules/@du/egress   <JUNCTION> -> packages/egress
packages/egress/package.json:6                     main : dist/index.js
```

So an orchestrator process that requires `@du/egress` in this workspace loads
`dist/pinned-fetch.js` and hits the crash. `dist/` is gitignored
(`du-rework/.gitignore:2:dist/`) and untracked, so the stale artifact is a local build product
rather than committed code — **but it is the file consumers actually read**, and rebuilding the
package resolves it. Per §6 of the dispatch spec I did **not** rebuild: fixing is the implementer's
call, not this verification's.

---

## 3. Why two green runs missed it

| Prior verification | What it loaded | Missed |
|---|---|---|
| DSH2 probe `07-probe.cjs:19` | `require(ROOT + packages/egress/src/pinned-fetch.ts)` | dist |
| `pnpm test` (both verifiers) | src, via `preset: ts-jest`, `testMatch: **/*.test.ts` | dist |
| Suite test `:106` | src, via ts-jest | dist |
| **My probe A** | `require(dist/index.js)` | **crashes** |
| **My probe B** | src, transpiled in memory | — |

Both prior verifiers and the suite transpile `src`; none requires `dist`. Jest is not at fault — it
does what it is configured to do. The real gap is that **no existing check exercises the artifact
consumers load**, so 35/35 green says nothing about shipped behaviour. DSH2 also bound its conclusion
to sha `8fd4b211…`, which still matches, so that receipt is not wrong — it is **incomplete**.

---

## 4. Spec §3 citations, re-verified against current bytes

```text
ok 126   if (body === null || body === undefined) return {};
ok 358   const hasNoBody = requestMethod.toUpperCase() === 'HEAD' || [204, 205, 304].includes(responseStatus);
ok 370   fulfill(new Response(null, responseInit));
```

No drift. I also confirmed there is exactly **one** `hasNoBody` decision and **two** `Response`
sites in src, so no other branch can construct a body for a null-body status.

---

## 5. Suite and typecheck, as run

```text
pnpm --dir orchestrator/packages/egress test        exit 0
  Test Suites: 3 passed, 3 total
  Tests:       35 passed, 35 total
  Time:        1.612 s

npx tsc --noEmit -p tsconfig.json                 exit 0   (no output)
```

Deliberate difference from the repo suite: that test enqueues a body of `ignored` against statuses
204/205/304. A real 204 carries **no body at all**, so both my probes write genuinely empty
responses with `Content-Length: 0` and zero payload bytes. The suite never exercised that wire shape.

---

## 6. Probe A — shipped artifact, crash reproduced

`01-probe-A.cjs` starts a real loopback `node:http` server emitting an **empty** 204
(`writeHead(204, { 'Content-Length': '0' })` then `end()`), loads `dist/index.js`, and issues a GET
through `createPinnedFetch({ allowPrivateNetworks: true, timeoutMs: 2000 })`. Launched as a separate
process so an uncaught throw takes the process down.

```text
PROBE_STATUS=1   PROBE_SIGNAL=null    -> the process exited, it was not signalled
PROBE_STDERR_BYTES=928
TypeError: Response constructor: Invalid response status code 204
    at fulfillResponse (orchestrator/packages/egress/dist/pinned-fetch.js:252:25)
PROBE_REACHED_END=false
```

Exit code 1 with `signal=null` is an **uncaught exception**, not a kill — the original defect
signature, live in the shipped file.

---

## 7. Probe B — the source repair is independently sufficient

`02-probe-B.cjs` registers a `require.extensions['.ts']` hook that transpiles `src` in memory using the
workspace TypeScript, then requires `packages/egress/src/pinned-fetch.ts`. Nothing on disk is written
or changed and the product file is untouched. Same 14 checks as probe A.

```text
PROBE_B_RESULT 14/14 checks passed
PROBE_B_STATUS=0   PROBE_B_SIGNAL=null   PROBE_B_STDERR_BYTES=0
PROCESS_SURVIVED_REACHED_END
```

Probe A crashes on the very wire shape probe B handles. Nothing in the fix is wrong; the only defect
is a stale build artifact.

Checks covered: 204, 205 and 304 resolve with `body === null` and no throw; HEAD resolves 200 with
`body === null`; a normal 200 still streams a byte-equal body; a second request issued on the same
fetcher after a null-body response completes, so the socket is drained rather than hung. Probe A also
demonstrates that constructing a `Response` with a body against status 204 throws in this Node build,
so the bug premise is real and not theoretical.

---

## 8. Dispatch accounting

The spec §4 records Owner as PENDING with no dispatch ID and no dispatch evidence. The prior occupant
of this receipt path had already recorded runtime request id `bb398965-8104-4043-bbea-10bb1ac285ac`
and runtime id `103b75ef-947d-4372-80bd-41010d8c6c7e` from `orca terminal list --json` (exit 0). I
re-ran the same listing (exit 0) and confirmed three distinct terminals: the implementer
`term_cd3c19e4…`, this verifier `term_c89675a0…`, and the dispatcher `term_be856c75…`. I did **not**
select an owner, did **not** send a dispatch, and record no dispatch id because none exists. This
receipt is written by the direct user instruction, not by an Orca dispatch.

---

## 9. Not verified / limits

1. **Offline loopback only.** No deployment, no real upstream, no HTTP/2, no proxy, no OS-level socket
   reuse measurement. The crash reproduces on loopback, which is sufficient to prove the artifact is
   defective, not sufficient to characterise every production path.
2. **I did not rebuild `dist`**, by design — the dispatch spec forbids running another lane's build,
   and §6 says a new finding is recorded, not fixed. Whoever owns the package must rebuild and re-run.
3. **Whether production is affected depends on the deploy pipeline.** `dist/` is gitignored, so a
   clean CI build compiles the fixed `src` and would be correct. The risk is confined to any deploy or
   local workflow that reuses a prebuilt `dist`. I measured this workspace, not a deployed image.
4. **The fail-closed error path** (`failResponse`) was confirmed by reading the code and by the
   suite's timeout/abort/destroy tests, not by forcing the `Response` constructor to throw through a
   status that permits a body.
5. Conclusions bind to `src` sha `8fd4b211…`. If another lane edits that file, this receipt must be
   re-run.

---

## 10. Confirmation

- Read-only: read source, ran the egress suite, ran typecheck, ran two probes in separate processes.
  **No product, test, migration, compose or config file was modified.** No build was run.
- No `git add`, no commit, no push; nothing staged. No gate ticked; this task is **not** self-accepted.
- No ciphertext, no secret, no token value printed.
- Self-scan: **0 ASCII double quotes**, verified by counting the character in the file.
- Scratch probe files live outside the repo, in `D:/Git/dugate/`, and are deleted at the end of the
  task; copies of the two probes are preserved under
  `coordination/reports/raw/verify-sec-04-pinned-fetch-2026-10-11/PROBE-A/` and `.../PROBE-B/`.
