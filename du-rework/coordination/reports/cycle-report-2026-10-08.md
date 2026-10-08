# CYCLE REPORT — 2026-10-08 (coordinator agent, 30-min cycle step 5)

Mode: READ-ONLY synthesis. No commit, no push, no tick VERIFIED/ACCEPTED, no plan/task edits, no `docs/21-openapi.json` hand-edit. Do not hand-edit legacy root.

---

## (a) Plan status

| Item | State | Evidence |
|---|---|---|
| WFA-T26 lease-recovery | **OPEN — E2E FLAKY (new finding)** | Lane self-report red at step4, then step11 iterating. My 2-agent verify below: unit 7/7 consistently green; E2E **non-deterministic** (green & red on same revision). Lane cannot be ticked. |
| WFA-T27 cancel semantics | **IMPLEMENTED (lane self-report)** | `wfa-t27-cancel-state-2026-10-08.md` (07:59): root cause `runtime.ts` `failTask` overwrote `CANCEL_REQUESTED`→`FAILED`; fix adds `hasCancelSignal` branch → `CANCELLED`. Claims E2E green 3× (exit 0). **NOT yet independently 2-agent verified this cycle.** |
| F-7 browser strict-mode | **VERIFIED** | Receipt `f7-browser-strict-mode-2026-10-08.md`: fail-first 2 failed/5 passed → 4 scoped selectors → 7 passed / exit 0. Cross-checked VERIFY-4 + VERIFY-5. |
| 11 pre-existing red unit suites | **TRIAGED / OPEN** | `triage-pre-existing-red-2026-10-08.md`: 102 deterministic failures when run alone, root-caused into 1 fake-strict-DB cluster (58, `list-query.ts:563`), 1 product/security bug (`admin-shell-session-lifecycle:821` — event field silently dropped, needs 2-sided lease), 1 possible regression (`enc-meta-sentinel-runtime-refs`), ambient-env suites, 1 assertion drift. |
| WFA §8 independent review (schema exec/security) | **OPEN** | Never self-ticked ACCEPTED. |

---

## (b) 2-agent independent test result — VERIFY-6 WFA-T26

Same revision under test (both verifiers recorded `http-worker.integration.test.ts` SHA256 `B52AA970…` and same Node v24.21.0, same command).

| Verifier | Unit | E2E run | E2E exit |
|---|---|---|---|
| #1 Codex (`term_ca784044`) | 7/7 green, exit 0 | 1× PASS | 0 |
| #2 OC (`term_8a432ae3`) | 7/7 green, exit 0 | run 1 PASS | 0 |
| #2 OC (confirmation, ~2 min later) | — | run 2 **FAIL** | **1** |

**Cross-check conclusion: the WFA-T26 E2E test is FLAKY / state-dependent.** Unit is stable green. E2E passed twice and failed twice on the identical revision. Neither a single green nor a single red can settle T26.

**Actionable signature difference** (the discriminating diagnostic):
- GREEN run: worker log has `handler failed`=2, `LEGACY_WORKFLOW_CONNECTOR_FAILED`=2, `lease lost during heartbeat`=1, `fail report fenced`=1.
- RED run: `handler failed`=**3**, `LEGACY_WORKFLOW_CONNECTOR_FAILED`=**6**, otherwise same lease-lost=1, fenced=1.

The red interleaving has **one extra handler-failed retry round** (3 vs 2) and 3× the connector-failed frames. This points to a race in the lease-recovery/heartbeat window: whether the 3rd attempt lands before/after the lease sweep decides green (recovers) vs terminal FAILED. The fix must eliminate the red interleaving, not merely pass on some runs. The lane's earlier red (`step4-runner-receipt.log`, same `attempt:3, lease_epoch:4`, stack `legacy-schema-runtime.ts:803`) is consistent with the RED signature — real but not deterministic.

Raw evidence: `coordination/reports/raw/wfa-t26-verify-{codex,oc}-2026-10-08/`; receipts `verify6-wfa-t26-{codex,oc}-2026-10-08.md`.

---

## (c) Admin-portal feature suggestions (FOR COORDINATOR REVIEW — not added to plan)

Surveyed `orchestrator/apps/admin-web/src/features/*` and `router.tsx`. Each needs coordinator approval before entering plan/task list.

| # | Feature | Problem solved | File:line | Complexity | Risk |
|---|---|---|---|---|---|
| 1 | Tenant scoping in Profiles/Businesses | Tenant text input is free-form; `TenantSelect` used in 6 screens but NOT profiles/businesses → typo leads to wrong/missing tenant scope | `features/profiles/profiles-screen.tsx:88,429` | S–M | Low |
| 2 | Connector ID free-text → real `<select>` | Manual connector ID entry error-prone; suggestions already validated but still free text (datalist) | `features/connectors/connectors-screen.tsx:482-494`; data in `state.ts:159-165` | S | Low |
| 3 | OpenAPI staleness indicator | Bundled `docs/21-openapi.json` can silently lag deployed API; no build date/staleness signal | `features/api-docs/api-docs-screen.tsx:2,131-145` | S | Low |
| 4 | Workflows-disabled unblock guidance | Route shows disabled banner (Δ-DEV-03) but no link to unblock condition or owner → operator doesn't know what to wait for | `features/workflows/workflows-screen.tsx:8-32` | S | None (display only) |
| 5 | Legacy-shell link labeling | Bare "Legacy shell" `<a href="/admin">` is easy to miss / unclear which app it opens | `app-shell/app-shell.tsx:72` | S | Low |

---

## Next steps (proposed, pending coordinator approval)

1. **T26**: lane must root-cause the flaky interleaving (the 3rd handler-failed round that exhausts retry budget) — likely a test-timing or lease-epoch window issue; cannot be ticked on green runs alone.
2. **T27**: assign a 2-agent independent verify (the fix is important and landed); do not trust the lane's 3×-green self-report.
3. **WFA §8**: schedule the independent schema-exec/security review (release gate).
4. 11 red-suite triage items #1–#11: route per triage §5 (1 root-cause fix for the 58-test cluster, 2-sided lease for `admin-shell:821`, etc.).

No suggestion above has been written into the plan or task list.
