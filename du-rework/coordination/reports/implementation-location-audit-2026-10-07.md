# Implementation location audit

Read-only on product/export state. No refresh, copy, build, cutover or commit.

## Source authority and actual build

- Canonical editable source remains `du-rework/services/orchestrator`, `services/connector`, `apps/admin-web`, `packages` and `businesses`. Portal folder naming migration is still separate.
- `migration-candidates/orchestrator` is a generated isolated repo boundary, not the active implementation authority or production cutover. Its README explicitly says refresh from canonical source with scripts/export-orchestrator-candidate.cjs. The exporter sets root to parent du-rework and copies a scoped allowlist into this candidate.
- Recent r4.1 five-image bake used a frozen canonical du-rework snapshot (commit 4308cc5 plus approved overlays), NOT the migration-candidates/orchestrator Docker context. Root du-rework Dockerfile COPYs services/packages/apps/businesses. Therefore success of this image bake is not standalone MIG-04 candidate parity evidence.
- Node24/build/export work does not by itself mean repo/source cutover was completed. Master migration MIG-04/VFY-06/REVIEW-07 still require independent exact candidate/isolation gates.

## Observed drift

- Candidate inventory generatedAt: 2026-10-06T05:54:40.707Z; entries: 824.
- 68 inventory paths differ after normalizing CRLF/LF. This includes documented export transformations (e.g. ingress test helper imports); not every difference is a defect. Genuine functional drift includes main.ts, create-app.ts, submission/retry/profile services, Connector composition/identity/invoke and OpenAPI.
- 23 canonical source/migration files absent from candidate. Examples:
- `packages/worker-sdk/src/storage-policy.ts`
- `packages/contracts/src/encryption-persistence.ts`
- `packages/contracts/src/profile-callback.ts`
- `packages/contracts/src/secret-catalog.ts`
- `services/orchestrator/migrations/0035_webhook_result_delivery.sql`
- `services/orchestrator/migrations/0036_profile_callback_policy.sql`
- `services/orchestrator/src/modules/artifacts/artifact-encryption.ts`
- `services/orchestrator/src/modules/secrets/vault-resolver.ts`
- `services/orchestrator/src/modules/webhooks/oauth2-client.ts`
- `services/orchestrator/src/modules/webhooks/outbound-auth.ts`
- `services/orchestrator/src/modules/webhooks/result-projection.ts`
- `services/orchestrator/src/app/admin/bff/secrets.ts`
- `services/connector/src/db/invocation-crypto.ts`
- `services/connector/src/vault/approle.ts`
- `services/connector/src/vault/reader.ts`
- `services/connector/src/vault/runtime.ts`
- `services/connector/src/db/migrations/009_connector_invocation_session_ref.sql`
- `apps/admin-web/src/routes/secrets.tsx`

- Current tracked changes are in canonical rework/legacy, with no dirty entries under migration-candidates. This is a live snapshot, not an attribution of every change to a particular agent.

## Legacy implementation scope

The fair-share dispatch at root `coordination/reports/dispatch-fair-share-worker-2026-10-06.md` leases `worker.ts`, `app/api/internal/profile-endpoints/route.ts`, `app/profiles/page.tsx` and root tests. Those belong to legacy Next.js/BullMQ, not the new Orchestrator/Portal/worker services. Its receipt cannot close du-rework migration or establish that the new platform has that feature. Whether the separate legacy feature itself was authorized must be checked against its user packet; do not call all root modifications unauthorized without evidence.

## Consequence and next action

Recent source edits under canonical du-rework are in the correct pre-cutover location. The extracted candidate is stale and must not be used to claim that latest source changes shipped there. Refresh under the named MIG-04 export/build lease after freezing approved hunks, inspect additions/removals and generated Dockerfile/helper transforms, regenerate inventory and independent-build with parent source absent. Do not edit both trees independently. The current exporter copies additions but does not prune stale destination files: owner must classify destination-only files and preserve intentional candidate tooling before any cleanup, rather than blindly deleting.

If fair-share is intended for the new platform, assign a separate scoped migration/implementation packet mapping legacy semantics to new Runtime/Orchestrator/Portal/worker paths; do not copy legacy files into candidate. Existing WT-01..04 dispatch specs correctly name du-rework service/Portal paths, but TBD owner/ASSIGNED text is not delivery proof.

Raw comparison: [comparison.json](raw/implementation-location-audit-2026-10-07/comparison.json). No existing source, candidate, tasks or leases changed by this audit.
