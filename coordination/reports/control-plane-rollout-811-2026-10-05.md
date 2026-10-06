# CONTROL-PLANE-ROLLOUT-811 — 2026-10-05

**Task:** `task_2121d13eeb1f` / dispatch `ctx_2a4142b85be5f`
**Scope:** source-only rollout and observability design for the ENCMETA plaintext-read control plane. No source or tests were changed or run; no DB, Vault, or live deployment was accessed.

## Current source status

The agreed control plane is not implemented in this source snapshot: grep found no `MetadataReadPolicy`, `MetadataReader`, or `METADATA_PLAINTEXT_READ_MODE`. `runtime.ts:467-471` still returns raw input when crypto is absent and sends `true` to the reader when present; `metadata-crypto.ts:387-400` still returns a legacy string when no crypto exists or `allowPlaintext` is true. The existing literals and early returns still need the central policy/read façade implementation described in the earlier design receipts.

The auth counter now requires exactly all eight `METADATA_SLOTS` (`modules/encryption/metadata-auth-counter.ts:47-61,175-181`) and returns a slot breakdown, blocker total and `PASS`/`FAIL` (`:76-89,243-250`). A caller cannot trim this to just the two `result_ref` slots. The counter authenticates shape-passing envelopes under the actual context; plaintext and broken envelopes are blockers (`:185-205,243-250`). Result-ref backfill alone therefore cannot establish full metadata readiness if another slot remains plaintext or broken.

The observability package defines bounded `MetricsRegistry` counter/gauge/histogram interfaces and an `InMemoryMetricsRegistry` with snapshots for tests/diagnostics (`packages/observability/src/metrics.ts:1-28,126-180`). Grep found no production registry construction, metrics exporter, or `/metrics` endpoint under `services/orchestrator/src`. The `Logger` emits JSON through a console sink (`packages/observability/src/logger.ts:27,131-165`); request-context IDs can be added automatically (`:135-151`). Metrics must not be called operationally visible until they are connected to a deployment sink; per-request logs must not carry row values or identifiers.

## 1. Evidence to monitor for PRE-SWITCH §3 and A8

Keep three measurements separate: plaintext fallback *reads* are traffic; plaintext *rows* are outstanding data; the window countdown is policy state. One cannot substitute for another.

| Signal | Proposed metric | Source / use |
|---|---|---|
| Whether bounded compatibility is active | `du_encmeta_plaintext_window_open` gauge (`0/1`) | Read immutable boot policy state; `0` after explicit close or expiry. A mismatch between instances is a rollout fault. |
| Remaining open time | `du_encmeta_plaintext_window_expires_at_seconds` gauge; dashboard computes `max(0, expires_at - now)` | Same absolute `expiresAt` across all instances, validated by `createBoundedDualReadWindow` (14-day maximum; `legacy-payload-migration.ts:500-519`). Dashboard also shows expiry time and per-instance config version so drift is visible. |
| Actual plaintext fallback use | `du_encmeta_plaintext_fallback_reads_total{slot,purpose,decision}` counter | Increment only when a legacy plaintext value is actually returned; fixed enums only. Denials get `decision=denied` / a separate bounded reason counter. This proves whether callers still consume plaintext after the census snapshot. |
| Outstanding plaintext / broken records | `du_encmeta_unsealed_rows{slot,classification}` gauge from the latest full authenticated census; classifications `plaintext`, `sealed_broken_auth`, `sealed_broken_context`, `sealed_broken_other` | Populate from `countUnsealedWithAuth`'s per-slot results. Add `du_encmeta_auth_gate_last_run_timestamp_seconds` or a snapshot-age gauge so a stale green gate cannot look current. The plaintext count is not a substitute for the fallback-read counter. |
| Backfill progress | `du_encmeta_backfill_rows_total{state,kind}` counters or snapshot values (`migrated`, `verified`, `failed`) | Populate from the CLI's value-free result and before/after per-kind census; do not emit one metric per row. |

Metric labels must be closed, low-cardinality enums: `slot`, `purpose`, `decision`, `classification`, `kind`. Never label by tenant, operation/task/ref id, URL, result ref, key ref, ciphertext, digest, or window/run UUID. The metrics library limits label keys and already forbids common ID labels (`metrics.ts:1-3,35-50`); follow that rule for new names too.

**Exporter dependency:** because the current registry is in-memory and unused by the orchestrator, the implementation packet must either connect these instruments to the deployment's existing scrape/OTel sink or explicitly use structured census logs as the durable, log-derived metric source. If there is no confirmed sink, retain the CLI snapshots and logs as operational evidence and do not claim the gauges are available in production. Do not add a public metrics route just to satisfy this; any exposition must use the platform's private metrics path.

Emit structured, aggregate logs at boot and at operator milestones, not one log per successful fallback:

- `encmeta_plaintext_window_configured`: `mode`, `startsAt`, `expiresAt`, `maxDurationMs`, service version, and non-secret config fingerprint. Log once per process; compare all replicas.
- `encmeta_census_completed`: timestamp, covered slot set/count, per-slot `plaintext`, `sealedValid`, broken counts, unresolved count, and census/gate state.
- `encmeta_backfill_completed`: bounded-window id in the restricted receipt, scanned/migrated/verified/failed totals, before/after counts, exit state; never result-ref content or ciphertext.
- `encmeta_auth_gate_completed`: `gate`, `blockers`, per-slot counts, timestamp, crypto/key-config identity without key material.
- `encmeta_plaintext_window_closed` / `encmeta_plaintext_window_expired`: mode, expiry, config version, and last gate/census timestamp; no values or row IDs.

The console logger adds operation/task identifiers from request context automatically. Therefore do not emit per-row or per-request logs for allowed reads; use counters for that signal and aggregate logs from boot/CLI context. Redaction is a backstop, not permission to pass values or secrets to the logger.

For A8, keep the caveat **“encryption best-effort trong backfill window, legacy rows vẫn plaintext-readable”** while the window is open or a plaintext row remains. The evidence bundle is the current census/gate snapshot, configured expiry/mode, fallback-read counter delta, backfill receipt, and post-flip real-reader verification. A prior green snapshot, store-unit result, or low read count is not proof that no plaintext row remains. PRE-SWITCH §3 in `coordination/reports/plan-checkpoint-805-2026-10-05.section.md:31` remains: backfill + zero/known-reviewed leftovers → policy/default/outage/rotation + rollout/audit → flip → real-reader verify.

## 2. Rollout order without breaking the deployed service

1. **Baseline, no flip.** Verify every orchestrator writer replica has metadata encryption configured, can reach the same approved Vault key, and runs the envelope-aware reader/writer build. The current writer seals results only when `metadataCrypto` exists (`runtime.ts:826-838`); an old or unconfigured replica can create new plaintext after a backfill. Capture the full eight-slot census/gate output per slot, backup receipt, queue state and current error/read baseline. Do not label this state fully encrypted (A8).
2. **Clear execution-only plaintext before strict policy deployment.** The production `read-only-results` mode must reject legacy input/claim/replay/continuation/ingestion reads. Backfill or otherwise safely drain every non-result execution slot first; repair unresolved/broken rows. The full counter may still show expected plaintext `result_ref` blockers, but each of the other six slots must show zero plaintext and zero sealed-broken values before their readers become strict.
3. **Handle the shared result slot.** `tasks.result_ref` serves both the read-only child-list projection and join continuation (`runtime.ts:1220-1225` vs `:1832-1836`). Before deploying a policy that allows legacy values only for projections, complete/drain all pending `WAITING_CHILDREN` continuations that might consume plaintext child refs, or backfill those refs first. New completion writes must be sealed across the writer fleet. Otherwise the strict join path can fail while GET views remain compatible.
4. **Deploy policy-aware code with one bounded, explicit read-only-results window.** Roll out the new policy/read facade consistently to every replica with the same `startsAt`/`expiresAt` (no more than 14 days), policy mode `read-only-results`, and stable key config. The only plaintext allowance is the reviewed result projection purpose/slot set; every execution path denies. Compare startup logs/config fingerprint and window gauges across replicas before proceeding. Keep the existing release available for rapid rollback only if it can read the same envelopes and use the same keys.
5. **Census → backfill → full auth gate.** Run the read-only per-slot census; run the guarded, operator CLI backfill with its required bounded store window; run `countUnsealedWithAuth` with its required exact eight-slot coverage. Require `gate=PASS`, `blockers=0`, zero plaintext and zero broken envelopes in every slot, plus stable post-run census. The counter intentionally rejects a two-slot subset. If only the result-ref migrator is ready, keep the overall gate/window open and do not claim global control-plane completion until the other six slots are green.
6. **Close the mode only after evidence is reviewed.** Change the shared deployment config to `deny`, roll it to every replica, verify all instances report closed/expired countdown zero, and perform real-reader checks for public result GET, admin detail, child-list GET, worker claim/continuation and ingestion. Confirm no allowed-plaintext counter increase after cutover; any deny counter or read error triggers investigation. Refresh the full auth gate and census after the flip. Only then update A8 statements/claims and report the measured scope.

To keep live behavior available, stage policy code first only after execution-input preconditions are met, and use the bounded read-only window while legacy *result projections* are backfilled. Do not run a strict switch while plaintext execution data or pending child joins remain. If the required drain/backfill cannot be completed before rollout, postpone the policy deployment; do not widen the allowlist as a downtime workaround.

## 3. Closure authority and rollback

**User-gated decision:** the named service/data owner must approve the close after reviewing the full gate/census and rollback plan; a release operator applies the config change and records the approval/change reference. An agent, timer, admin UI user, or green unit test cannot independently authorize closure. The policy expiry is nevertheless fail-closed: when the approved window expires it denies legacy plaintext automatically, even if nobody completed the planned close. Expiry is a safety bound, not approval to extend or a substitute for the gate.

Never silently extend an expired window. If the gate is red at expiry, plaintext projections fail closed and the incident owner must make a fresh user-approved bounded-window decision (still projection-only) after a new census; there is no `allow-all` rollback. Do not change/remove the active or historical Vault decrypt keys during the window or rollback. Prefer rollback to a crypto-capable, policy-aware release with the same key configuration. Reopen a result-only window only when a real reader failure is proven to be a known legacy result row, a fresh census records it, and the user authorizes a new expiry. A broken envelope/AAD or Vault-key failure is not fixed by allowing plaintext.

## 4. Operations that must wait for the full auth gate

Offline implementation and test work can proceed before the gate. These live actions must not:

- flip the policy to `deny` / close the compatibility window;
- remove the reader compatibility branch or roll out a default-deny build to instances that still need non-result plaintext;
- claim control-plane/result-ref at-rest encryption is complete, remove the A8 caveat, or close PRE-SWITCH/G-ENC evidence;
- drop the prior decrypt key, rotate-and-retire a key version, or remove the tested crypto reader path;
- delete/retire legacy backup material or run cleanup that prevents verified rollback;
- accept a shape-only count or result-ref-only sample as the eight-slot authenticated gate.

Closure requires all eight slots because `assertFullCoverage` enforces that set exactly and the gate is `PASS` only when plaintext and all authenticated-open failures are zero. If an owner proposes a reviewed exception instead of zero, record it as an explicit user decision and keep the gate/A8 status visibly open; the current counter does not encode exceptions.

## 5. Smallest implementation-ready checklist and leases

| Packet | Minimum lease | Offline acceptance / prerequisite |
|---|---|---|
| **P1 — policy + reader telemetry** | New `services/orchestrator/src/modules/runtime/metadata-read-policy.ts`; `modules/runtime/metadata-crypto.ts`; `modules/runtime/runtime.ts`; `modules/operations/ingestion-consumer.ts`; `http/routes/public.ts`; `modules/operations/mappers.ts`; `http/route-context.ts`; `app/bootstrap/create-app.ts`; `server.ts`; `modules/encryption/boot-options.ts`; `main.ts`. | Enum parser/default/14-day expiry; policy created once and injected with or without crypto; callsites consume typed purposes; tests prove only result projections may allow legacy rows; early raw/no-key bypasses denied; per-read metrics contain only fixed labels. No source window flip. |
| **P2 — visible metric export + structured lifecycle logs** | New metadata telemetry adapter under `services/orchestrator/src/modules/encryption/` or `modules/runtime/`; `packages/observability/src/metrics.ts` only if the chosen sink requires it; platform metrics exporter/integration lease (currently absent from orchestrator source). | One instance's window expiry/open state is externally visible; counters/gauges survive process observation; logs are aggregate/value-free; no public `/metrics` exposure; all replica configs can be compared. Decide exporter with deployment owner before claiming production metric coverage. |
| **P3 — full census/gate evidence and backfill orchestration** | `services/orchestrator/src/modules/encryption/metadata-auth-counter.ts`; `legacy-payload-migration.ts`; new `src/result-ref-migration-cli.ts`; `services/orchestrator/package.json`; restricted receipt/log schema. Coordinate leases on the already separately designed backfill files. | Full eight-slot authenticated gate reports per-slot counts; backfill/census snapshots are durable and value-free; locks/window/default/abort behavior meet the prior BACKFILL-WIRING-DESIGN receipt. Gate must stay red on any plaintext/broken row. |
| **P4 — cutover runbook and approval record** | `coordination/reports/control-plane-rollout-811-2026-10-05.md` plus the owning deployment runbook/approval record (no source file). | Captures all-replica version/config, baseline and post-cutover gate/census, actual-reader checks, rollback target and user approval/change id. Only the designated service/data owner approves close; operator executes. |

## Source check record

- Re-grepped current policy literals, boot composition, reader/writer paths, metadata auth gate, metrics/log APIs, and production metric usage.
- Read the existing metrics registry, logger, full-coverage gate and PRE-SWITCH §3/A8 conditions.
- No tests, live services, database, Vault, source files, or deployment settings were modified or exercised.
