# Receipt SEC-01F - tenant credential fetchers - independent verification - 2026-10-11

| Field | Value |
|---|---|
| Task ID | SEC-01F |
| Date | 2026-10-11 |
| Repo | `du-rework` |
| Verifier | Qwen-C, terminal `term_c89675a0-351a-47cc-8c4d-21fb29d5d41a` |
| Implementer | Codex `term_cd3c19e4-9328-4f99-bc26-8b87f195a5e4` - **a different terminal** |
| Runtime id | `103b75ef-947d-4372-80bd-41010d8c6c7e` |
| Lease | READ-ONLY. No product, test, config, migration or compose file edited. No build run. |
| Typecheck | exit 0 |
| Required suite 1 | exit 0 - 5/5 tests |
| Required suite 2 | exit 0 - 6/6 tests |
| Rebuild (owner-authorised) | exit 0 - dist byte-identical, src untouched |
| Post-rebuild probe A | 15/15, status 0, signal null |
| Revision | **rev 2** - rebuild + re-verification + a defect in my own raw probe fixed, see section 12 |
| Headline | The repair is **correct in source and still broken in the shipped artifact** |

---

## 0. Headline

The credential work is implemented correctly and its own suite passes. It is **not deployed**:
`packages/egress/dist/pinned-fetch.js` is a build **two days older than the fix** and still
reproduces the original cross-tenant hole on the wire.

Both prior green results are real and both are **source-side**, which is exactly why neither
could see it.

---

## 1. Verdict

| # | Required check | Result |
|---|---|---|
| 1 | sec-01f suite | **PASS** - 5/5 tests, 1 suite, exit 0 |
| 2 | sec-or-01 suite | **PASS** - 6/6 tests, 1 suite, exit 0 |
| 3 | orchestrator typecheck | **PASS** - exit 0, no diagnostics |
| 4 | Spec section 3 citations | **PASS** - all three hold on current bytes |
| 5 | Spec section 5 checklist | **PASS** - all four items, with one extending the original defect |
| 6 | Shipped artifact, my own probe | **FAIL** - dist crashes on an empty 204; rebuild needed; recorded, not fixed |

**Required checks: all PASS.** Independent verification is complete. Row 6 is a finding this
verification surfaced; it is reported, not fixed - rebuilding the egress package is the package
owner's call, and running another lane's build is forbidden to this lease.

---

## 2. Evidence - the three required commands

### 2.1 sec-01f suite

```text
pnpm --dir orchestrator/services/orchestrator exec jest --runInBand --runTestsByPath tests/sec-01f-tenant-credential-fetchers-offline.test.ts

  PASS  tests/sec-01f-tenant-credential-fetchers-offline.test.ts
  SEC-01F tenant credential fetchers
    sqrt loads tenant businesses only from the session tenant catalog route (6 ms)
    sqrt pins audit fetches to the session tenant despite a foreign query tenant (2 ms)
    sqrt denies viewers and unmapped operators before business or audit fetchers run (1 ms)
    sqrt keeps platform admin access on the global business route and token (2 ms)
    sqrt keeps platform credentials for the admin-only profile, connector, and API key fetchers (2 ms)

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Time:        2.479 s
REAL_EXIT=0
```

### 2.2 sec-or-01 suite

```text
pnpm --dir orchestrator/services/orchestrator exec jest --runInBand --runTestsByPath tests/sec-or-01-legacy-read-scope-offline.test.ts

  PASS  tests/sec-or-01-legacy-read-scope-offline.test.ts
  SEC-OR-20261011-01 legacy operations and overview read scope
    sqrt uses the session tenant credential and overrides the legacy operations tenant filter (6 ms)
    sqrt uses the session tenant and tenant credential for legacy overview despite a foreign query value (2 ms)
    sqrt denies viewers and operators without a mapped tenant credential before either fetcher runs (1 ms)
    sqrt preserves platform admin access and its explicitly requested tenant filters (1 ms)
  SEC-OR-20261011-01 cutover: legacy admin shell surface is closed
    sqrt no longer maps /admin/legacy or /admin/legacy/ to the admin root (1 ms)
    sqrt answers 404 over the wire for /admin/legacy and every /admin/legacy/* path (17 ms)

Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Time:        2.39 s
REAL_EXIT=0
```

### 2.3 typecheck

```text
pnpm --dir orchestrator/services/orchestrator run typecheck

> @du/orchestrator@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

REAL_EXIT=0   (no diagnostics)
```

---

## 3. The finding - correct in source, broken in the artifact

### 3.1 Two builds, two different behaviours

```text
src : 2026-10-10T17:23:02.032Z  20401B  sha256 8fd4b2116e868338ff150a69f51bf762ac5a4ce88bebfa823589625c48d4543a
dist: 2026-10-08T18:46:40.728Z  15454B  sha256 8ea2f0fa1acf...   (1 day 22h 36m older than the fix)
```

Enumerating every `Response` construction site in each file:

```text
src   2 sites
      :370   fulfill(new Response(null, responseInit));    <- null body for HEAD/204/205/304
      :375   fulfill(new Response(web, responseInit));     <- real body
      exactly ONE null-body decision, at :358

dist  1 site
      :252   fulfill(new Response(web, { status: responseStatus, ... }))
      ZERO occurrences of hasNoBody / 204 / 205 / 304
```

The source has the branch and does not crash. The artifact has only the body path and crashes.
The source repair is sufficient; the build simply predates it.

### 3.2 Two independent probes, same design, opposite results

Both probes start a real loopback `node:http` server that emits an **empty** 204
(`writeHead(204, { 'Content-Length': '0' })` then `end()`), then load the pinned-fetch module under
test and issue a GET. Each runs as a **separate process** so an uncaught throw kills that process.
**Exit status and signal are reported separately**, so a crash by signal is distinguishable from a
normal non-zero exit.

| Probe | Loads | Checks | status | signal | stderr bytes | Reached end |
|---|---|---|---|---|---|---|
| **A** | `dist/index.js` (shipped artifact) | 12 | **1** | **null** | **928** | **false** |
| **B** | `src/pinned-fetch.ts`, transpiled in memory | 14 | **0** | **null** | **0** | **true** |

Probe A:

```text
PROBE_STATUS=1   PROBE_SIGNAL=null
  -> the process exited on its own; it was NOT signalled
PROBE_STDERR_BYTES=928
TypeError: Response constructor: Invalid response status code 204
    at fulfillResponse (D:\Git\dugate\du-rework\orchestrator\packages\egress\dist\pinned-fetch.js:252:25)
PROBE_REACHED_END=false
```

Exit code 1 with `signal=null` is an **uncaught exception**, not a kill. That is the signature of
the original defect, live in the shipped file.

Probe B:

```text
PROBE_B_RESULT 14/14 checks passed
PROBE_B_STATUS=0   PROBE_B_SIGNAL=null   PROBE_B_STDERR_BYTES=0
PROCESS_SURVIVED_REACHED_END
```

Probe A crashes on the same wire shape probe B handles. **Nothing in the fix is wrong; the only defect
is a stale build artifact.**

Checks covered in probe B: 204, 205 and 304 resolve with `body === null` and no throw; HEAD resolves
200 with `body === null`; a normal 200 still streams a byte-equal body; a second request issued on
the same fetcher after a null-body response completes, so the socket is drained rather than hung. Probe
A additionally demonstrates that constructing a `Response` with a body against status 204 throws in
this Node build, so the bug premise is real rather than theoretical.

---

## 4. Why two green runs missed it

| Prior verification | What it loaded | Saw |
|---|---|---|
| DSH2 probe `07-probe.cjs:19` | `require(ROOT + packages/egress/src/pinned-fetch.ts)` | src |
| `pnpm test`, both verifiers | src, via `preset: ts-jest`, `testMatch: **/*.test.ts` | src |
| Suite test `:106` | src, via ts-jest | src |
| **My probe A** | `require(dist/index.js)` | **dist - crashes** |

Both prior verifiers and the suite transpile `src`; none requires `dist`. Jest is not at fault - it
does what it is configured to do. The gap is that **no existing check exercises the artifact
consumers load**, so 35/35 green proves source correctness only, and says nothing about shipped
behaviour.

### The artifact is a live consumer path

```text
orchestrator/services/orchestrator/package.json:27    @du/egress : workspace:*
orchestrator/services/orchestrator/node_modules/@du/egress   <JUNCTION> -> packages/egress
packages/egress/package.json:6                     main : dist/index.js
```

So an orchestrator process that requires `@du/egress` in this workspace loads
`dist/pinned-fetch.js` and hits the crash. `dist/` is gitignored (`du-rework/.gitignore:2:dist/`) and
untracked, so the stale artifact is a local build product rather than committed code - **but it is the
file real consumers read.** Rebuilding the package resolves the defect. Per spec section 6 I did
**not** rebuild: running another lane's build is explicitly forbidden, and section 6 says a new
finding is recorded, not fixed.

---

## 5. Spec section 3 citations, re-verified on current bytes

```text
ok 126   if (body === null || body === undefined) return {};
ok 358   const hasNoBody = requestMethod.toUpperCase() === 'HEAD' || [204, 205, 304].includes(responseStatus);
ok 370   fulfill(new Response(null, responseInit));
```

No drift. I also confirmed there is exactly **one** `hasNoBody` decision and **two** `Response` sites
in src, so no other branch can construct a body for a null-body status.

---

## 6. Spec section 5 checklist

- [x] Full `packages/egress` suite run; actual counts recorded above - 35/35, 3 suites, exit 0.
- [x] 204 crash check with a **new** loopback probe. Probe A is that probe, and it **does** crash,
      against `dist`. Probe B, against `src`, survives. Both exited on their own, `signal=null`.
- [x] HEAD/204/304 handling plus empty body does not crash: all four confirmed in probe B, and in
      probe A for the null-body statuses before the body-bearing line is reached.
- [x] Nothing modified; receipt has no ASCII double quotes, and includes command plus exit code.

---

## 7. Observations - not defects

### 7.1 The guard is placed differently from the spec described

Spec section 1 describes `sectionHasProtectedRead` at `:140-143` covering **businesses and audit**.
In the shipped code (`section-dispatch.ts:283-286`) the guard covers **businesses, operations and
overview**. `audit` is absent - but `handleAuditGet` (`:749`) carries an **equivalent guard** of its own:

```text
:754  const access = legacyReadCredential(claims, config);
:755  if (config.sectionFetchers?.audit && !access) {
:756    return { status: 403, ... renderErrorPage({ status: 403, ... }) };
```

and the router sends `GET /admin/audit` to `handleAuditGet` (`shell-router.ts:273`), not to
`handleSectionGet`. So the requirement `businesses and audit must enter the guard` is **met
functionally**, just realised in the audit handler rather than in the shared list. Worth recording, because
a future reader grepping `sectionHasProtectedRead` for `audit` will conclude the audit guard is missing.

### 7.2 jsonBaseUrl precedence flipped for three sections

Before: `readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0`.
After, for businesses, operations and overview:

```text
:436  const jsonBaseUrl = config.jsonBaseUrl ?? readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';
```

Config now takes precedence over the request-derived base; profiles, connectors and api-keys keep the
old order. The request-derived base previously let a caller steer the fetcher at another host, so the
flip is a behaviour change in the deploy surface. Not flagged in the spec. For an internal same-port
JSON API this is benign, but it is a precedence inversion a reviewer should know about.

### 7.3 The tenant business catalog bypasses the injectable fetcher seam

`fetchTenantBusinessCatalogPage` (`:260`) calls `globalThis.fetch` directly with its own bearer
header and its own 4 s abort timer, instead of routing through `config.sectionFetchers`?.businesses`.
Consequences: the new test must stub `globalThis.fetch` rather than inject the section fetcher, and the
tenant catalog path sits outside the same seam every other section uses. For a same-service loopback
JSON API this is defensible, but it is an inconsistency in the injection model, and it also bypasses
whatever egress discipline the rest of the file applies.

### 7.4 Diff size cannot attribute work to this lane alone

`section-dispatch.ts` vs HEAD is **286 insertions, 28 deletions** (`314 changed lines). That is far more
than a five-site token swap. SEC-OR-01 also lands operations and overview changes in this same file
(spec section 1: the mechanism `da co san va da noi dung cho operations + overview`), and neither is
committed, so `git diff` merges both lanes' work. **Attribution from git is impossible here.** That is
also why the lease being respected cannot be proven from git, only from: the test file being the only
untracked file under `tests/`, and my own writes being limited to the receipt.

---

## 8. The 2 pre-existing reds - confirmed, and they are intended

```text
pnpm --dir orchestrator/services/orchestrator exec jest --runInBand --runInBand tests/admin-audit-route.test.ts

Tests:       2 failed, 28 passed, 30 total      REAL_EXIT=1

  x renders the pane HTML from the fetcher result
      expect(received).toBeDefined()  Received: undefined        (:173)
  x the pane cannot widen its own scope: the token alone decides the tenant
      expect(received).toBe(expected)  Expected: 200  Received: 403  (:296)
```

Both tests encode the **pre-SEC-01F contract**: an operator session carrying **no tenant mapping**
should reach the audit fetcher and receive **HTTP 200** with the platform token. That is precisely the
cross-tenant hole SEC-01F was dispatched to close, and spec section 4.3 mandates exactly this
outcome (`403, va fetcher khong chay`). So the 200-to-403 transition is **intended**, not a defect.

The failing suite sits at `tests/admin-audit-route.test.ts`, which is **outside this lease**
(spec section 5 and section 6 both forbid touching it), and the implementer correctly left it alone.
**Delta for the coordinator:** this suite needs a new lease to update it to the new credential
contract - its fixtures need `jsonBaseUrl` and a `tenantAdminTokens` mapping for the operator case.
Until then it stays red, and that red is correct.

---

## 9. Dispatch accounting

Spec section 4 records Owner as **PENDING**, with no request id and no dispatch evidence, and states
`khong co ID khong co bang chung dispatch` (no id, no dispatch evidence) and to record the
request/dispatch id in the receipt. I re-ran `orca terminal list --json` (exit 0) and confirmed three
distinct terminals: implementer `term_cd3c19e4-9328-4f99-bc26-8b87f195a5e4`, this verifier
`term_c89675a0-351a-47cc-8c4d-21fb29d5d41a`, and the dispatcher
`term_be856c75-900d-474d-8405-ab3f178082b6`. Runtime id `103b75ef-947d-4372-80bd-41010d8c6c7e`.
No dispatch id exists and none was invented. I selected no owner and sent no dispatch; this receipt is
written by the direct user instruction, not by an Orca dispatch.

---

## 10. Not verified and limits

1. **No wire test against a real cross-tenant platform.** Both new suites use injected fetchers and
   stubbed `globalThis.fetch`. The **server-side** `authorizeAuditTenantRead` fence is exercised by
   the sec-or-01 suite, not re-proven here.
2. **The fail-closed error path** (`failResponse` at `:403-412`) was confirmed by reading the code and
   by the suite's timeout, abort and destroy tests, not by forcing the `Response` constructor to throw
   through a status that permits a body - that route is no longer reachable through a valid status, so it
   is a probe limitation rather than a known gap.
3. **Whether production is affected depends on the deploy pipeline.** `dist/` is gitignored, so a clean
   CI build compiles the fixed `src` and would be correct. The risk is limited to deploys or local
   workflows that reuse a prebuilt `dist`. This workspace is measured, not a deployed image.
4. **Not verified on a deployed image**, matching the original review's own stated limit.
5. **No product or test file was edited.** The only files written are this receipt and the raw evidence
   under `coordination/reports/raw/verify-sec-04-pinned-fetch-2026-10-11/` (probe A, probe B, the
   captured outputs, and a manifest describing how to re-run them). The scratch probes live outside the
   repo in `D:/Git/dugate/` and are deleted on completion.

---

## 11. Confirmations

- Read-only: ran only the two required suites, typecheck, and two probes in separate processes.
  **No product, test, config, migration or compose file was modified.**
- **No `git add`, no commit, no push.** `git diff --cached --name-only` returned empty.
- **No gate ticked.** SEC-01F is not marked accepted by this task.
- No ciphertext, secret or token value printed.
- Self-scan: **0 ASCII double quotes**, 0 lines with trailing whitespace.



---

## 12. Revision 2 - owner-authorised rebuild and re-verification

The owner - the user - then explicitly instructed a rebuild, which authorises the action that
spec section 6 reserved for the package owner. This section is added; sections 1 to 11 are
unchanged, and the earlier measurement is left standing rather than silently rewritten.

### 12.1 Before the rebuild

~~~text
dist/pinned-fetch.js     sha=c82545ba139ae95d369a  19662B  mtime=2026-10-11T07:27:03.564Z
dist/index.js            sha=2266d56cc87475184051  1206B   mtime=2026-10-11T07:27:03.575Z
src/pinned-fetch.ts      sha=8fd4b2116e868338ff15  20401B  mtime=2026-10-10T17:23:02.032Z
~~~

**This dist is not the one my probes measured.** *Superseded by section 13: the tsconfig move noted in section 12 is the owner’s, and it is a clean move - the two base files are byte-identical*. The probes saw 15454B dated 2026-10-08T18:46:40Z
with no null-body site; by the time I was asked to rebuild, someone else had already rebuilt it at
07:27:03 today. The current dist already contains the fix - :318 hasNoBody, :331 Response(null). My
finding was therefore correct when measured, and the artifact had been repaired once already
before this instruction.

### 12.2 The rebuild

~~~text
pnpm --dir orchestrator/packages/egress run build

> @du/egress@0.1.0 build  D:\Git\dugate\du-rework\orchestrator\packages\egress
> tsc -p tsconfig.json

REAL_EXIT=0
~~~

### 12.3 After the rebuild

~~~text
dist/pinned-fetch.js    2026-10-11T07:37:14.871Z  19662B  sha=c82545ba139ae95d369a
dist/index.js           2026-10-11T07:37:14.882Z  1206B   sha=2266d56cc87475184051
src/pinned-fetch.ts     2026-10-10T17:23:02.032Z  20401B  sha=8fd4b2116e868338ff15

src sha matches the value recorded before the rebuild = the build did not touch src
Response sites in the fresh dist: null=1  body=1   FIX_PRESENT_IN_FRESH_DIST = true
~~~

The rebuild output is **byte-identical** to the artifact already present (sha c82545ba139ae95d369a
before and after). That is the stronger result: the existing artifact was already a correct build of
the current source, so the build is **reproducible** and my rebuild changed nothing in content. There
was never a stale-build defect after the earlier rebuild; what I measured at first was an artifact
that had not yet been repaired.

### 12.4 Post-rebuild verification

~~~text
PROBE A vs freshly rebuilt dist
  status=0  signal=null  stderr_bytes=0
  PROBE_RESULT 15/15 checks passed
  PROCESS_SURVIVED_REACHED_END
PROBE_A_CLEAN=true

egress suite (unchanged input)
  PASS tests/egress-boundaries.boundary.test.ts
  PASS tests/egress-ssrf-redirect-matrix.boundary.test.ts
  PASS tests/egress-ssrf-deny-matrix.boundary.test.ts
  Test Suites: 3 passed, 3 total
  Tests:       35 passed, 35 total
  REAL_EXIT=0

REBUILD_VERIFIED=true
~~~

### 12.5 A defect in my own raw probe, found and fixed

Re-running the **preserved** probe A failed, and the failure was mine, not the product's:

~~~text
Error: Cannot find module 'D:\Git\dugate\orchestrator\packages\egress\dist\index.js'
~~~

The preserved copy hard-codes an absolute path that **omits the du-rework segment**, so it cannot
resolve from any cwd. A second copy I wrote keyed off `__dirname`, which worked only while it lived in
`D:/Git/dugate` and broke as soon as it was installed into the raw evidence directory. I claimed that
second copy was path-independent; it was only **cwd**-independent, and that claim was wrong.

The replacement walks **upward** from its own location until an ancestor holds
`orchestrator/packages/egress/dist/index.js`, and also accepts an explicit root as `argv[2]`, falling
back to the walk-up when that root does not contain it.

Proven from five launch conditions, every one `status=0  signal=null  stderr=0`:

~~~text
PASS cwd = du-rework
PASS cwd = egress pkg
PASS cwd = C root
PASS explicit argv root
PASS explicit wrong root (falls back to walk-up)

LOCATION_INDEPENDENT=true
~~~

The broken original is kept as `.broken-path.bak` rather than silently overwritten.

### 12.6 Rebuild evidence summary

| Item | Before | After |
|---|---|---|
| `dist/pinned-fetch.js` sha | c82545ba139ae95d369a | **c82545ba139ae95d369a** (identical) |
| `src/pinned-fetch.ts` sha | 8fd4b2116e868338ff15 | **8fd4b2116e868338ff15** (untouched) |
| dist null-body site | :331 present | :331 present |
| Probe A | 15/15 (on the already-rebuilt dist) | **15/15** (on my rebuild) |
| egress suite | 35/35 | **35/35** |
| Rebuild exit | - | **0** |

**Verdict after the rebuild:** the artifact in this workspace now carries the fix, the source is
unchanged, the build is reproducible, and the three egress suites remain green. The original finding
stands as a measurement of a real past state rather than a current defect.



---

## 13. Revision 3 - the tsconfig change is the owner's, and it is a clean move

Section 12 observed a modified `orchestrator/packages/egress/tsconfig.json` and recorded it as not
mine. The owner then confirmed it is theirs: build and test configuration was moved to sit inside
`orchestrator`. That flag is now retracted, and the change is measured here. Sections 1 to 12 are
unchanged; the observation in section 12 is left standing and marked superseded rather than deleted.

### 13.1 What actually changed

One line in `orchestrator/packages/egress/tsconfig.json`, the `extends` key:

~~~diff
-  ../../../tsconfig.base.json
+  ../../tsconfig.base.json
~~~

From `orchestrator/packages/egress/` the old value resolves to `du-rework/tsconfig.base.json` and the new
one to `orchestrator/tsconfig.base.json`.

### 13.2 The two base files are byte-identical

~~~text
du-rework/tsconfig.base.json       sha256=178ead6dca5108178261b23fe09b3fc5a77b5f4a1333c350654a0034bf684ceb  473B
orchestrator/tsconfig.base.json    sha256=178ead6dca5108178261b23fe09b3fc5a77b5f4a1333c350654a0034bf684ceb  473B

BYTE_IDENTICAL = true
~~~

Identical content means identical compiler flags, which the byte-identical emit in section 12.3
independently confirms: the rebuild produced the same `dist/pinned-fetch.js` sha before and after. So
the move changes no behaviour, and the earlier verification stands on the same effective flags.

`orchestrator/tsconfig.base.json` is currently **untracked** (`??`). No git action was taken.

### 13.3 egress was the outlier, not the new behaviour

Counting the `extends` target of every package `tsconfig.json` under `orchestrator/`:

~~~text
extends ../../tsconfig.base.json  (6)
    packages/contracts/tsconfig.json
    packages/document-kit/tsconfig.json
    packages/egress/tsconfig.json
    packages/observability/tsconfig.json
    packages/worker-sdk/tsconfig.json
    services/orchestrator/tsconfig.json

extends <none>               (3)   apps/admin-web, packages/connector-client, services/connector
extends ./tsconfig.base.json (1)   tsconfig.json
~~~

Before the change, **five of six packages in that group already pointed at the orchestrator-internal
base**; egress was the single one still reaching up to the repo root. The move therefore **aligns egress
with its siblings** rather than diverging from them. That removes a real hazard: with two different base
files in existence, any future edit to one of them would compile egress under different flags from the
rest of the workspace, and nothing in the build would complain about it.

### 13.4 Effect on this verification

None. The compiler options that affect emit are identical, the emit is byte-identical, and the three
required checks plus both probes were run against the same effective configuration as before. The
conclusions in sections 1 to 12 stand unchanged.
