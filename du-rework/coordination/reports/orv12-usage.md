# ORV12-USAGE owner handoff

2026-10-11, `/root/api_compat`; shared uncommitted workspace. Owner smoke only; independent verifier/reviewer receive frozen source separately. No production or paid provider calls.

## Implemented contract

- Connector invocation completion and usage outbox insertion commit in one PostgreSQL transaction. Failure to persist billing metadata rolls back successful completion. Existing replay append retains the durable first event; divergent settlement for the same ID is rejected, while retry timestamp differences do not create another charge. Outbox stores only whitelisted billing fields. Dispatcher CR10 rejection containment already existed and remains unchanged.
- `UsageEvent` accepts optional provider/model/costStatus. Existing wire events remain accepted. Missing reported cost is explicitly `unpriced`, independent of measured tokens; explicit zero remains measured zero. Provider amounts must be nonnegative safe integers. No invented provider/model or prices. Atomic write invokes the same normalization/validation used by the HTTP sink.
- Usage ingress keeps operation/task validation, transaction-wide event dedup and divergent-payload rejection. Orchestrator project adds costStatus/pages/model; missing events remain pending. Legacy polling preserves unknown cost as null rather than turning it into measured zero. Summary exposes optional money status for new tagged events, and aggregate overflow fails closed.
- Legacy billing forwards the requested date window (inclusive root end-date semantics), queries the authorized key only, and derives period usage from ledger rows when present, otherwise historical operation columns. It never adds both for one operation. Billing balance adds priced ledger spend for new succeeded operations to imported `api_keys.total_used`; `legacy_history IS NULL` distinguishes new operations from imported historical balance. It does not mutate the historical key baseline. Billing usage period cost is distinct from lifetime balance. Legacy billing numeric totals represent known accrued priced spend; its frozen shape has no completeness flag. Unpriced placeholder values do not add spend.

## Owner checks

Cwd `/workspace/dugate/du-rework/orchestrator`; Node24.21.0, pnpm10.18.3, PATH `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin:$PATH`.

- `pnpm --filter @du/contracts build`: exit0, [raw](raw/orv12-usage/contracts-build.log).
- `pnpm --filter @du/orchestrator typecheck` and `pnpm --filter @du/connector typecheck`: exit0 each, [raw](raw/orv12-usage/typecheck.log).
- `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv12-usage-settlement.test.ts tests/usage-aggregation.test.ts tests/usage-contracts-integration-offline.test.ts tests/usage-drilldown.test.ts tests/legacy-http-mount.test.ts`: 74 passed,0 failed,0 skipped, exit0, [raw](raw/orv12-usage/orchestrator.log).
- `pnpm --filter @du/connector exec jest --runInBand tests/orv12-usage-outbox.test.ts tests/reliability-security.test.ts tests/runtime-foundations.test.ts tests/cr10-02-usage-dispatcher-rejection.test.ts tests/sec-enc-02-ledger-encryption.test.ts`:33 passed,0 failed,0 skipped, exit0, [raw](raw/orv12-usage/connector.log).
- Initial connector exact-body assertion failed because additive `costStatus: measured` appeared; expected shape updated explicitly, other values unchanged. [Red retained](raw/orv12-usage/initial-connector-red.log).

New owner boundary exercises real HttpUsageSink→ingest normalization/dedup against a small database double, measured zero versus unknown cost, key-guarded legacy projection, persisted-outbox conflict and metadata sanitization. Existing encryption suite protects completion storage. These checks do not replace actual local provider/PG proof; VFY independently runs that fixture.

## Explicit remaining boundaries

- Rich COST `UsageLedgerEvent` reconciliation/export still requires provenance not in the old runtime wire: stable attempt/step, connector revision, business/profile snapshot, duration, receivedAt and price basis. Existing consumer rejects incomplete rows rather than inventing those values. Closing it requires Connector invocation snapshot producer plus trusted Orchestrator operation/task enrichment and a versioned normalized ledger adapter. Parent explicitly kept this separate.
- No new pricing engine is inferred when provider omits money. Unpriced remains unpriced until a separate explicit settlement/correction protocol is implemented; divergent same-ID replacement is rejected.
- Spending admission gap was found during review and CLOSED in this packet: shared `readKeySpend` uses exact bigint microdollars for both balance and `assertKeySpendAvailable`; submission checks after replay and before INSERT. Positive exhausted limit yields legacy402; limit0 is unlimited. It compares known succeeded spend, not speculative unpriced future expense (matching legacy admission).
- Billing baseline assumes the importer stamps `legacy_history` on imported operations and imports historic total_used. Actual fixture must prove historical/new/duplicate/date/key combinations. Ledger-backed new key spend is computed from successful operations, matching the old success-only engine charge rule.

## Final spend follow-up and freeze

Shared helper `modules/usage/spend-admission.ts` fences key and tenant and uses exact decimal→BigInt conversion. Historical `legacy_history` prevents charging imported baseline again. Same helper feeds billing. Legacy document/workflow402 preserves root type/title/status/detail. Existing metadata-crypto submission fixture now supplies an explicit unlimited key row. Owner seven suites120pass, exit0 ([raw](raw/orv12-usage/spend-final.log)); orchestrator typecheck exit0 ([raw](raw/orv12-usage/spend-typecheck.log)). Command adds `tests/orv12-spend-admission.test.ts tests/submission-metadata-crypto-e2e.test.ts` to the five orchestrator suites above. An initial test tuple typing error and concurrently incomplete BFF source blocked two suites; both resolved, red kept. Independent live verifier caught UUID-versus-text SQL comparison in initial spend query; corrected explicit `$2::uuid` predicate before freeze. The raw independent red/green remains under verifier ownership. VFY reports actual local provider725→outbox→ledger→billing success, replay after402 and unlimited admission; that is their claim, not owner acceptance.
