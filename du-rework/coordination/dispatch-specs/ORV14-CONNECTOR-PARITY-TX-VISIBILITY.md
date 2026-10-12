# ORV14-CONNECTOR-PARITY-TX-VISIBILITY

Actual followup delivered to `/root/orv13_usage` (original Luna6 max) after writer FINAL; live roster confirms running. Actual observed UTC: 2026-10-11T23:58:55.132337+00:00.

Requirement: CFGADM connector secret import/immutable draft completion; real first-write HTTP must return committed revision, with exact idempotent lost-ACK replay and no second Vault write.

Product RED: `raw/orv14-verification/secret-import-pg-vault-20261011-2353.log`, KV POST1, lost-ACK injection not reached, 401 completed draft missing revision. `finalizeIntent` opens DB transaction and `toIntentResult` reads revision via outside pool before commit.

Exclusive product lease: `orchestrator/services/connector/src/db/parity-repository.ts`, one new uniquely named owner regression. No writer/Host repository/invoke/outbox/central/shared contracts or build edits. Preserve existing dirty hunks. Review all transaction callsites; keep transaction-bound reads, strict crypto/CAS/currentauth/immutable pin/replay. Owner regression proves no outside pool read inside open transaction, first completion and completed replay. No broad owner tests without new concern.

Receipt `coordination/reports/orv14-parity-tx-fix.md` + unique raw; exact source hashes, cwd/commands/UTC/counts/exit, frozen/released. Independent primary reruns actual PG/Vault import/lost-ACK/rotation on new source; owner smoke not verification/acceptance.
