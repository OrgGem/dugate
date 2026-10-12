# ORV14-CONTINUITY-REHEARSAL — required pending source packet

Status: DISPATCHED to /root/orv14_continuity by actual collaboration.spawn_agent on 2026-10-11T21:11:43.009752+00:00. Root assigns a matching Luna6/max implementation owner after a current source lane releases capacity and the new contracts settle. This file is not dispatch proof.

Scope: du-rework, one-time legacy migration and cutover, canonical compatibility review §6 + CFGADM00..11/AOPS06/07. Preserve public legacy APIs and all dirty ORV11..14 work. No production credentials/data/window, no customer cutover, reset, commit/push or dependency reinstall.

Proposed exclusive write set (root confirms no live owner overlap before delivery):

- orchestrator/services/orchestrator/scripts/ldba-{03-production-adapter,context-provider,inventory,reconcile}.cjs and ldba-03-backfill.cjs; new unique continuation helpers permitted. Existing journals may be extended through NEW migration0057_legacy_continuity_evidence.sql if needed; no other migration writer.
- orchestrator/services/orchestrator/src/modules/legacy-migration/readiness.ts and app/admin/bff/legacy-migration.ts.
- New unique continuation/rehearsal helpers and owner tests, docs/48-orv14-migration-continuity-runbook.md, coordination/reports/orv14-continuity.md + raw/orv14-continuity/.
- Any storage/runtime/bootstrap/maintenance/Connector/Identity source is excluded; obtain actual producer/consumer hooks from its named owner. Do not become a second migration0049..0056 or Host maintenance/runtime writer.

Required behavior:

1. Reconcile legacy archived settings into the real new immutable tenant AI/prompt revisions, approved Connector credentials/recipes, storage generations and retention policies. Keep all17 inventory dispositions, with source-based api_secret_key retirement explicit and sanitized. Do not claim scoped settings revisions alone supply global17 parity.
2. Preserve imported operation/profile/key/user/Connector/workflow/result/audit/history identity, assignments and usable encrypted downloads. Existing pinned historical records may need explicit immutable legacy-generation mapping; never rebind them to the latest active generation or invent rich cost provenance.
3. Inventory and immutable journal cover new config/generation/grant/budget fields and checksums; preflight exposes missing/inconsistent/decryption/blob/identity/runtime holds, replay is idempotent, changed source or stale target rejects. MigrationReady must reflect verifiable capabilities and evidence; customer external inputs remain separately labeled, never hardcode production readiness true or false as substitute for real checks.
4. Use host owner's approved backup/restore and ingress/cutover interfaces: cross-plane dispatch/admission/usage fences, named targets, encrypted immutable bundle, config/key/secret/artifact version pins, new isolated restore generation with provider calls disabled. App rollback does not reverse DB writes.
5. Owner smoke on NEW isolated synthetic namespaces: legacy frozen export -> import -> configuration mapping -> inventory -> restore/replay -> API historical result/download/login/profile/default/identity checks. Emit counts/hashes/holds and exact producer/consumer provenance. No shared/preexisting namespace deletion; cleanup only positively owned resources.

Prerequisite handoff: backend globals/carrier, host storage/maintenance/restore, parity identity/Connector/grants, cost persisted budget/provenance signatures. Announce exact exports and consumer wires before implementation. Ask root for only genuinely missing lease/architecture decisions, continue independent source work.

Evidence: command/cwd/time/toolchain/namespace, source+build digests, raw output, passed/failed/skipped and exit, positive cleanup. Owner smoke is IMPLEMENTED only. A separate Luna verifier must execute independent migration/restore/cutover rehearsal and reviewer must approve final source/build before ACCEPTED.

Source handoff at dispatch preparation: Ops source lease is released by coordination/reports/orv14-ops.md. All other named owners remain active and product leaves are excluded. Continuity owner may develop mapping/inventory/readiness independently, freeze adapter signatures directly with Backend/Host/Parity/Usage, and rehearse once concrete adapters are ready; unsupported current dependency is an open requirement, not permanent deferral. Existing legacy bcrypt first-login support/password-reset mapping must be preserved and verified without needing customer plaintext password. Do not invent rich cost history for BASIC imported events.
