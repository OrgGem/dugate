# P9-02 independent verification — 2026-10-02

## Scope and execution

Read the P9-02 packet and its §10 amendment, then inspected the LC-checker package and the current Orchestrator mount to verify the receipt's claims. All package commands ran in `du-rework/businesses/lc-checker`; no DB, Redis, S3, Vault, provider, or live registration was used. No source, task/gate row, or other lane was edited.

| Command | Exit | Observed result |
|---|---:|---|
| `npx jest --runInBand` — run 1 | 0 | 6/6 suites, 118/118 tests passed; 0 snapshots. |
| `npx jest --runInBand` — run 2 | 0 | 6/6 suites, 118/118 tests passed; 0 snapshots. |
| `npx jest --runInBand` — run 3 | 0 | 6/6 suites, 118/118 tests passed; 0 snapshots. |
| `npx jest --runInBand --json --silent` — per-suite count check | 0 | `worker-manifest` 24, `lc-checker` 35, `registry-tool` 6, `rules-registry` 21, `validation` 17, `legacy-facade` 15; total 118 passed, 0 failed. |
| `npx tsc --noEmit -p tsconfig.json` | 0 | No diagnostics. |
| `npx tsc --noEmit -p tsconfig.test.json` | 0 | No diagnostics. |

Raw Jest summaries from the three consecutive suite runs:

```text
Run 1 — exit 0
Test Suites: 6 passed, 6 total
Tests:       118 passed, 118 total
Snapshots:   0 total
Time:        2.046 s, estimated 6 s
Ran all test suites.

Run 2 — exit 0
Test Suites: 6 passed, 6 total
Tests:       118 passed, 118 total
Snapshots:   0 total
Time:        1.567 s, estimated 2 s
Ran all test suites.

Run 3 — exit 0
Test Suites: 6 passed, 6 total
Tests:       118 passed, 118 total
Snapshots:   0 total
Time:        1.509 s, estimated 2 s
Ran all test suites.
```

No tests were red, so there is no failure output to quote. The per-suite JSON check also exited 0 and matched §10.4's six-suite split and 118 total. The receipt's original §2–§3 count of 104 is superseded by §10; current run count is 118.

## Claim-by-claim

| Receipt claim | Verdict | Independent evidence |
|---|---|---|
| §5 Δ-P9-02-A — state is persisted across the fan-out and resumed with its join | **CONFIRMED** | The worker loads persisted state and feeds it with the decoded join into `advanceLcChecker`, then writes state before spawning children (`businesses/lc-checker/src/worker.ts:79-94,399-423`). Tests cover the persisted pending join (`tests/worker-manifest.test.ts:101-108`) and the plan → OCR join → visual join → completion sequence (`:153-172`). |
| §5 Δ-P9-02-B — identity guard runs against raw input before normalization | **CONFIRMED** | `normalizeLcCheckerInput` invokes the guard on the raw record before copying recognized fields (`businesses/lc-checker/src/lc-checker.ts:106-141`). The test rejects `apiKeyId`, `api_key_id`, `userId`, `tenantId`, `role`, and `adminToken` with `IDENTITY_FIELD_REJECTED` (`tests/lc-checker.test.ts:174-183`); worker-level rejection is also covered (`tests/worker-manifest.test.ts:251-253`). |
| §7 F1 — live registration and activation have not been performed | **UNCONFIRMED** | This task did not contact a live Orchestrator. The registration test injects `fakeFetch` and simulates register/enable/activate responses (`businesses/lc-checker/tests/registry-tool.test.ts:10-24,32-45`), so it proves only the offline tool path, not deployment state. |
| §7 F2 — `POST /api/v1/docs/workflows` is not mounted | **REFUTED** | The current server invokes `handleLegacyRoute` before canonical routes and returns every non-null compat response (`services/orchestrator/src/server.ts:1745-1767`). `parseLegacyDocsPath` recognizes `workflows` (`services/orchestrator/src/compat/legacy-http-mount.ts:191-200`); the handler currently claims non-action workflow paths and returns HTTP 503 with “The legacy workflow facade is not available on this deployment.” (`:391-408`). There is no `lc-checker` wiring in `services/orchestrator/src`. Thus the route path is mounted/claimed, but the LC-checker workflow is not operational; the receipt's “no such route” statement is stale. |
| §7 F3 — no legacy UI is present in `du-rework` | **CONFIRMED, repository scope** | A file inventory of `du-rework` returned no `.tsx`, `.jsx`, `.vue`, or `.html` files. This verifies the receipt's statement about this repository only; it does not inspect the separate legacy UI. |
| §7 F4 — rules remain provisional pending domain-owner sign-off | **CONFIRMED for current code status; external sign-off UNCONFIRMED** | Rules declare `LC_RULESET_STATUS = 'PROVISIONAL'` (`businesses/lc-checker/src/rules/rules-data.ts:6-10`); the status type says confirmation requires a domain-owner signature (`src/rules/rule-types.ts:12-13`) and the README preserves provisional status (`README.md:80-89`). No external owner/signature system was checked. |
| §7 F5 — no live E2E has verified queue, DB, artifact store, and connector together | **UNCONFIRMED as a historical claim; confirmed NOT RUN in this verification** | This run used only the offline suite and typechecks. The worker tests use an in-memory harness and fake ports/checkpoints (`businesses/lc-checker/tests/fakes.ts:113-153`); the registration test uses fake fetch (`tests/registry-tool.test.ts:10-24`). No live E2E was attempted. |
| §7 F6 — join handling uses `joinSummary`; authoritative continuation contract remains outside this package | **CONFIRMED for package behavior; external ownership UNCONFIRMED** | Worker reads `ctx.input.joinSummary`, builds the matching join, and advances with the saved state (`businesses/lc-checker/src/worker.ts:399-408`). The three-delivery fake-harness test exercises both joins (`tests/worker-manifest.test.ts:153-172`). This offline evidence cannot establish ownership of the platform-wide authoritative contract. |
| §7 F7 — no domain-owned golden corpus exists in the lane; examination quality remains unmeasured | **CONFIRMED for lane inventory; external corpus UNCONFIRMED** | The lane inventory contains source, unit tests, and fake payloads, but no golden/document corpus; tests use fake connector responses (`businesses/lc-checker/tests/fakes.ts:113-153`). Presence or absence of domain samples outside this repository was not checked. |
| §9 connector-cap issue was escalated, then superseded by §10 | **CONFIRMED as receipt history; approval provenance not independently verifiable** | The connector contract still caps a call at 4 artifacts and 10 MiB (`packages/contracts/src/connector.ts:8-9,48-54`), and the §10 receipt explicitly supersedes the §9 deferral. The two-pass implementation is present in the LC-checker stage machine below. This tester did not independently verify the external product-owner instruction recorded in the receipt. |
| §10.1 — demand-driven five-stage examination | **CONFIRMED** | Stage type is `ocr | screen | visual | adjudicate | report` (`businesses/lc-checker/src/primitives.ts:16-24`); tests cover the three-delivery plan/OCR-join/visual-join path (`tests/worker-manifest.test.ts:153-172`) and skip the visual round when none is requested (`:175-178`). |
| §10.2 — alternatives rejected and rationale | **UNCONFIRMED by tests** | This is product/design rationale, not a behavior claim that an offline unit fixture can establish. The recorded alternatives and rationale are present in the receipt; no comparative live-corpus evidence was run. |
| §10.3 — screening rules are validated, completeness is machine-derived, and unanswered checks remain visible | **CONFIRMED for tested package behavior** | Screen validation enforces its request shape and maximum (`businesses/lc-checker/src/validation.ts:155-207`); the state machine derives outstanding visual checks and refuses an unsound clean verdict (`src/lc-checker.ts:576-636,707-718`). Tests cover unanswered checks and refusal to report `COMPLIANT` (`tests/lc-checker.test.ts:413-443`, `tests/worker-manifest.test.ts:225-232`) and prompt visibility (`tests/rules-registry.test.ts:170-186`). |
| §10.4 — rebuild persists before children, matches joins by stage, records missing child results, and now has 118 tests | **CONFIRMED** | State is saved before `spawnAndWait` (`businesses/lc-checker/src/worker.ts:399-423`); pending stage is resolved by `ocr`/`visual` join token (`src/lc-checker.ts:258-267`); absent child results become explicit failed outcomes (`src/worker.ts:180-213,216-231`). The three consecutive Jest runs all passed 118/118, and the per-suite count check matched §10.4. |
| §10.5–§10.6 — falsifiers require real corpus evidence; reopen on golden corpus | **UNCONFIRMED empirically; consistent with current lane inventory** | No domain-owned golden corpus was present in the lane inventory or used by these tests. Therefore the listed quality falsifiers and the examination's empirical quality remain untested; the conditional statements themselves cannot be resolved by this offline run. |

## Verdict

**VERIFIED=No.** The three offline Jest runs, both typechecks, and the §5 implementation claims pass independent verification; however, the receipt's F2 assertion that no workflow route exists is refuted by the current server mount. The route is claimed but returns 503 rather than executing `lc-checker`, so the concrete blocker is the inaccurate F2 status and the workflow remaining unavailable. Live registration, live E2E, domain-owner sign-off, and domain corpus claims remain outside this offline verification. No P9-02 gate was ticked.
