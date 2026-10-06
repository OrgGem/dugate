# Independent Verification — Group A Reconciliation (A1..A7) per §13.2

- **Date:** 2026-10-07
- **Verifier:** DeepSeek (dsh) — independent verifier / reconciler (per `coordination/COORDINATOR-CONTRACT.md`; disjoint scope, never a second dispatcher)
- **Repo scope:** `du-rework` ONLY (legacy root untouched)
- **Reference:** `coordination/reports/claude-audit-review-r4-2026-10-06.md` §13.2 (P0, Group A stays OPEN — three gates: (i) exact-path mapping A1..A7, (ii) CB-01 mapping, (iii) A4 connector-side fail-closed proof)
- **Mode:** Every suite independently re-run by the verifier at HEAD `4308cc5` via `node node_modules/jest/bin/jest.js --runTestsByPath <path> --runInBand`. No prior receipt used as pass evidence.
- **Code freeze:** NO commit, NO push, NO stage. This report file is the only write.

## Environment

| Item | Value |
|---|---|
| OS / Shell | Windows / PowerShell (pwsh) |
| Node | v22.23.3 |
| Git HEAD | `4308cc5` (branch `codex/fix-workflow-builder`) |
| Working tree at run | dirty, 316 entries — pre-existing shared state (workers active) |
| Working tree delta by this run | +1 file: this report only |

---

## 1. Exact-path reconciliation map A1..A7 (gate i)

All values below are the verifier's OWN runs this session. Exit code 0 on every run; 0 failed, 0 skipped tests everywhere.

| Item | Exact spec paths (cwd `du-rework/<pkg>`) | Claimed | VERIFIED | Exit |
|---|---|---|---|---|
| **A1 focused** | `businesses/document-core/tests/disbursement-handler.test.ts` · `businesses/document-core/tests/p9-03-doc-compare-runner.test.ts` | 27/27 | **2 suites / 27 passed** | 0 |
| **A1 regression** | 8 suites: `p9-01-disbursement`, `disbursement-handler`, `p9-03-doc-compare`, `p9-03-doc-compare-handler`, `p9-03-doc-compare-runner`, `p9-03-doc-compare-registration`, `p745-carrier-impl-b2`, `p745-session-capture-inject` (all under `businesses/document-core/tests/`) | 153/153 | **8 suites / 153 passed** | 0 |
| **A2** | 6 suites: `p745-session-capture-inject`, `p745-session-action-wiring`, `extract`, `analyze`, `compare`, `ingest` (`businesses/document-core/tests/`) | 99/99 | **6 suites / 99 passed** | 0 |
| **A3** | `services/connector/tests/cr06-04-async-202-session.test.ts` · `cr06-04-session-ref.schema.test.ts` | 10 | **2 suites / 10 passed** | 0 |
| **A4** | `services/connector/tests/cr06-05-identity-enforcement.test.ts` | 19 + M1/M2 | **1 suite / 19 passed** (incl. all 6 fail-closed construction guards) | 0 |
| **A5** | 5 suites: `cr06-06-parameters-secret`, `p730-medium1-write-validation`, `p730-prof03-invariant1`, `aweb04-bff-profiles`, `submission-metadata-crypto-e2e` (`services/orchestrator/tests/`) | 5 suites / 88 | **5 suites / 88 passed** | 0 |
| **A6** | `packages/worker-sdk/tests/cr06-07-tri-state-policy.test.ts` | 4 | **1 suite / 4 passed** | 0 |
| **A6 focused** | `cr06-07-tri-state-policy` + `worker` + `p730-sdk-consume-pin-passthrough` (`packages/worker-sdk/tests/`) | ×3 → 33 | **3 suites / 33 passed** | 0 |
| **A7 CB-01** | `packages/contracts/tests/profile-callback.test.ts` | 16 | **1 suite / 16 passed** | 0 |
| **A7 CB-02** | `services/orchestrator/tests/cb-02-webhook-result-delivery.test.ts` | 23 | **1 suite / 23 passed** | 0 |
| **A7 CB-03** | `services/orchestrator/tests/cb-03-outbound-auth.test.ts` | 20 | **1 suite / 20 passed** | 0 |

**Totals (verifier runs):** 31 suite-executions · **492 tests passed · 0 failed · 0 skipped · 0 non-zero exits.**
Unique suites across the map after de-duplicating overlaps (A1 regression re-runs `disbursement-handler`/`p9-03-doc-compare-runner`; A2 re-runs `p745-session-capture-inject`): **27 distinct files**, all green.

Additional A3 pass criterion — migration 009: confirmed present at `services/connector/src/db/migrations/009_connector_invocation_session_ref.sql`; `cr06-04-session-ref.schema.test.ts` exercises its replay-safe SQL read-only (adds nothing to the DB).

---

## 2. CB-01 location rationale (gate ii)

**Why CB-01 lives in `packages/contracts`, not `services/orchestrator`:**

- CB-01 is the **frozen contract layer**, not a runtime delivery path. Its subject matter — `CallbackAuthSchema`, `CallbackSecretRefSchema` (opaque managed-secret refs only), `CallbackDestinationAuthorizationSchema`, `ProfileCallbackPolicySchema`, `ProfileCallbackPolicySnapshotSchema`, `resolveEffectiveCallbackPolicy` — is declared and validated in `packages/contracts/src/profile-callback.ts` (exported consumers listed there include the orchestrator).
- The orchestrator **consumes** those schemas from `@du/contracts`: `services/orchestrator/src/modules/webhooks/webhooks.ts:6-23` imports `ProfileCallbackPolicySchema`, `ProfileCallbackPolicySnapshotSchema`, `authorizeCallbackDestination`, `type CallbackAuth`, etc. and runs them at delivery time (`parsePinnedCallbackPolicy` `:89-109`, `authorizeCallbackDestination` `:665`). So the "no `cb-01` file in the orchestrator-resolved 10-file/133-test set" finding in §13.2(b) is **expected**: the test for the contract's own schema semantics belongs beside its declaration in the package that owns the frozen wire shapes.
- The split mirrors the repo's architecture: `packages/contracts` = executable contracts/validators (P1), `services/orchestrator` = runtime/webhook engine (CB-02 result delivery, CB-03 outbound OAuth2 auth). CB-02 and CB-03 are the runtime half of the same feature family and rightly sit in the orchestrator; CB-01 is the schema half. The two halves are connected only through the `@du/contracts` import boundary, so a single consumer re-implementation cannot drift from the contracts tests.

**CB-01 is therefore MAPPED, not out-of-set — the §13.2(a)/(b) mapping gap is closed.**

---

## 3. A4 connector-side fail-closed proof (gate iii)

The carve-out `allowUnauthenticatedTestTraffic` lives at **`services/connector/src/http/server.ts`**, NOT in the orchestrator — consistent with the previously confirmed 0 grep hits in `services/orchestrator/tests`.

### Fail-closed implementation (read at HEAD `4308cc5`)

| Location | Behavior |
|---|---|
| `server.ts:67-75` | `ConnectorHttpDependencies.allowUnauthenticatedTestTraffic?: boolean` — JSDoc: "CR06-05 test-only carve-out … the explicit allowlist: a test harness opts in visibly instead of a missing verifier silently opening the server. **Production composition never sets it.**" |
| `server.ts:87-108` | `resolveIdentityVerifier()` — **fail-closed on every composition path**: (a) verifier wired → returned (`:90`); (b) flag `=== true` → **rejected unless a recognized test runtime** (`:92-97` throw, else `console.warn` + return `null` `:98-102`); (c) **neither configured → throw** (`:104-107`). |
| `server.ts:110-114` | `isRecognizedTestRuntime()`: `NODE_ENV === 'test'` OR `JEST_WORKER_ID` set OR `VITEST` set. |
| `server.ts:116-117` | `createConnectorServer()` resolves the verifier **once at construction** and passes it into the route — a missing verifier cannot be introduced later at request time. |

### Live confirmation during this verification

- The A4 run (`cr06-05-identity-enforcement.test.ts`, 19/19) includes explicit guards: "resolveIdentityVerifier throws when neither verifier nor carve-out is configured", "**carve-out is rejected outside a recognized test runner even when the flag is set**", "createConnectorServer without verifier or carve-out refuses to construct", "composition override path without verifier or carve-out refuses to construct" — all PASS.
- Independently, the A3 run (`cr06-04-async-202-session.test.ts`) emitted the carve-out activation banner through the real seam:
  `console.warn [connector] CR06-05 test-only carve-out active: serving non-health routes without service identity; this must never happen in production.` with `at resolveIdentityVerifier (src/http/server.ts:98:13)` `at createConnectorServer (src/http/server.ts:117:28)` — proving the flag only activates under the test harness and visibly warns.
- M1/M2 mutation evidence (from the owner receipt `cr06-05-identity-enforce-2026-10-06.md`, byte-exact-restored): M1 (return `null` instead of throwing when no verifier + remove test-runner guard → 4 failed/19, killing exactly `resolveIdentityVerifier throws`, `carve-out rejected outside test runner`, `createConnectorServer refuses`, `composition override refuses`); M2 (remove `?? config.serviceIdentityVerifier` fallback → 1 failed/19, killing `enforces the verifier inherited from composition config`). Both target the exact fail-closed code cited above; the mutations are destructive test edits so they were not re-run by this verifier under code freeze.

**A4 is now closed on the connector file with its fail-closed proof — §13.2(c) resolved.**

---

## 4. Integrity assertions

1. **Independence:** All 31 suite-executions were run by the verifier at HEAD `4308cc5`; zero counts copied from worker receipts. Per-suite `Test Suites`/`Tests` lines and `EXITCODE=0` captured from live output.
2. **Functional verdict, not just exit code:** Failed = 0 and skipped = 0 on every run; for A4 the individual guard case list was read (see §3); for A3 the live carve-out banner was observed.
3. **Scope:** Runs confined to `du-rework/{businesses/document-core, services/connector, services/orchestrator, packages/worker-sdk, packages/contracts}`. Legacy root untouched.
4. **No code mutation:** No product code, tests, migrations, configs or manifests written; the M1/M2 mutations recorded in the owner receipt were NOT re-executed by this verifier (temporary source edits violate the verifier/freeze discipline) — the guards they kill were instead confirmed by direct source read plus the passing 19-test suite.
5. **Code freeze:** No `git add`/`commit`/`push`/`stash`/`reset`. The 316 pre-existing dirty entries preserved untouched.
6. **Cosmetic:** PowerShell `NativeCommandError` wrappers are jest stderr progress; summaries + `EXITCODE=0` confirm success. Malformed `GIT_CONFIG_*` shell env neutralized read-only.

## 5. Status & limits

- **Group A (A1–A7) dispatch-reconciliation gate:** the three §13.2 conditions are now met — (i) exact per-path mapping with verified counts in §1, (ii) CB-01 mapped to `packages/contracts` with architectural rationale in §2, (iii) A4 fail-closed proof at `services/connector/src/http/server.ts` in §3. Group A as a **reconciliation gate is CLOSED** by this receipt.
- **Not re-claimed here:** `ACCEPTED` per-task verdicts still require the standing reviewer gate (`claude-audit-review-r4-2026-10-06.md` re-review / Claude Code `APPROVED`) — this receipt is the independent `VFY` evidence layer, not a substitute.
- **Limits:** mutation runs M1/M2 were not re-executed (freeze discipline, see §4.4); live/DB/network-facing runs (PostgreSQL connector suites, real provider, real token server) were not part of this dispatch — all evidence here is offline unit/contract; checkpoints hashes from A1's wire change were already asserted by the owner receipt and were out of the re-run scope of this reconciliation packet.