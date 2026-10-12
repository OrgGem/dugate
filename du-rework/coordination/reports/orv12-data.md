# ORV12-DATA / STORAGE owner receipt — 2026-10-11

Owner `/root/migration`; base HEAD7e36a1e plus prior uncommitted ORV11 edits. No commit/push, customer DB or production cutover. IMPLEMENTED and owner-tested; independent real PostgreSQL/HTTP/S3 verification and reviewer own final acceptance. Prior [ORV11 runbook](orv11-data.md) remains applicable with SQL0047 additionally required.

## Effective mapping and provenance

- SQL0047 creates immutable `legacy_migration_runs` per tenant/sourceVersion, resumable `legacy_configuration_reconciliations`, and sanitized recorded inventory reports. Import rows and provenance commit in the same target transaction. Frozen source SHA covers the existing ordered JSON serialization of all nine source tables. Plan SHA covers canonical sorted-key JSON of planned write items, representing byte values by byteLength+SHA256; no plaintext source/credential/blob rows are stored in the ledger. Final receipt references this provenance; there is no circular receipt checksum.
- New `scripts/ldba-reconcile.cjs` supports inventory, record-inventory, preflight/diff and apply. Effective writes go only through authenticated `/api/v1/admin/actions` Settings revision create/validate/apply; no parallel ad hoc configuration SQL.
- Reviewed manifest binds sourceVersion/sourceSHA, archived-settings SHA, exact baseline target inventory SHA and SHA of the manifest file bytes. Every archived setting must have an explicit disposition. A changed source/archive, unclassified setting, conflicting prompt/pin choice, or target inventory drift blocks new reconciliation.
- Five legacy prompt keys can map only to explicitly chosen API key/endpoint/connection/default-step scope with reviewed processor semantics. Provider/model/base URL map to explicitly selected existing connector revisions, verifying connector config SHA and restricted JSON-pointer semantic evidence. Secrets/storage/deployment/unsupported settings require manual/deployment disposition and remain visible holds; no guessed customer defaults.
- Preserve nonchanged connector slots when producing full-map native Settings drafts. Pin changes require `expectedProfileRevision` in addition to settings `expectedActiveRevision`; runtime profile selector includes enabled business version filtering and matches native scope order. Native API validation owns connector capabilities, profile ownership, metadata encryption and business restrictions.
- Journal stores only nonsecret full-map pins for deterministic restart payload. Deterministic API idempotency keys cover manifest/scope/action; resumed apply checks active revision AND native `activeRevisionMatchesEffective`, exact prompt-value hashes and pins. Direct effective edits after apply raise a drift error; the tool never silently reapplies over them. Independent reviewer IR12-DATA01 addressed and owner regression included.
- Inventory reports nine-source counts, imported destination counts, target inventory/counts, profile/membership/connector policy issues, identity activation/SSO holds, historical callback/retrywindow holds, output references and actual blob SHA/size. Counts below imported minimums are flagged; counts alone are not exact source→target identity proof. Independent full-entity fixture verifies concrete IDs/bytes/policies. Inventory materializes at most100k rows per entity by default and256MiB aggregate imported blob bytes; exceeding explicit limits blocks, no truncation. Production sizing remains external.
- `--record-inventory` persists a sanitized report. New `readMigrationReadiness(db,tenantId)` gives tenant-fenced, bounded100-run DTO with counters/finite statuses only, never source settings, prompts, credential values or row bodies. SET owner mounts backend/BFF; UI owner consumes DTO. Status never asserts customer cutover ready.
- Independent fully populated source fixture exposed normal `x-api-key` wrongly rejected as a secret header *name* and a camelCase `createdAt` DTO written as SQL column. Both fixed: auth header name validates HTTP token syntax, credential value remains encrypted; SQL boundary maps `createdAt`→`created_at` without changing shared DTO.
- Local credential reader now explicitly requires `legacy_password_reset_required=false`; enabled/unlocked alone cannot authenticate an inconsistent pending-reset row. API owner wires actual username/password login; this receipt does not claim the prior password-reset CLI alone established HTTP login.

## Storage fix from independent S3 finding

Public upload stores a wrapper `{version,kind,tenantId,artifactId,objectVersion,ciphertextSha256,ciphertextSizeBytes,encryption}`; prior decrypt reader expected raw inner manifest and returned503. Reader now validates wrapper tenant/artifact/uploadToken against trusted DB facts, requires committed body and manifest versions, compares wrapper and actual ciphertext SHA/size to trusted DB values, then passes the inner manifest to the authenticated crypto facade. Malformed wrapper never falls back to raw parsing. Existing raw legacy manifest decryption remains covered.

Public/runtime download branches select/pass `storage_version_id`, `sha256`, `size_bytes` in addition to existing token/manifest pins. SET owner separately changed the sole bootstrap S3 reader to send requested VersionIds on body head/read and manifest read, rejecting absent/mismatched SDK returned versions. No ciphertext/plaintext fallback on authentication failure. These changes are necessary beyond merely stripping the wrapper.

## Commands and manifest

Cwd `du-rework/orchestrator/services/orchestrator`; use supported Node24.21.0. First apply SQL0047 with normal migrations and import/replay immutable snapshot under ORV11 proof. An older imported target without a ledger requires a fresh isolated rehearsal/import; do not fabricate provenance rows.

```text
LDBA03_TARGET_DATABASE_URL=<target URL supplied through secret management>
LDBA_TENANT_ID=<legacy-default tenant UUID>
LDBA03_SOURCE_VERSION=<frozen source tag>
```

- `node scripts/ldba-reconcile.cjs --inventory` — read-only sanitized JSON, returns source/archive/baseline digests and setting key/value hashes.
- `node scripts/ldba-reconcile.cjs --record-inventory` — records the sanitized current report for admin readiness; no effective setting mutation.
- Prepare reviewed manifest below. For model/provider, inspect connector configuration through authorized management tooling and choose explicitly; the inventory intentionally does not dump configuration secrets.

```json
{
  "version": "ldba-effective-config-v1",
  "tenantId": "<tenant UUID>",
  "sourceVersion": "<frozen source tag>",
  "sourceSha256": "<inventory source SHA>",
  "archivedSettingsSha256": "<inventory archive SHA>",
  "baselineInventorySha256": "<inventory target SHA>",
  "reviewedBy": "<reviewer>",
  "scopes": [{
    "apiKeyId": "<existing key UUID>",
    "endpointSlug": "generate:summary",
    "expectedActiveRevision": null,
    "expectedProfileRevision": 1
  }],
  "mappings": [{
    "sourceKey": "ai_generate_prompt",
    "sourceValueSha256": "<inventory setting value hash>",
    "disposition": "settings-revision",
    "targets": [{
      "apiKeyId": "<same key UUID>",
      "endpointSlug": "generate:summary",
      "connectionId": "<selected connection UUID>",
      "stepId": "_default",
      "semanticEvidence": "<reviewed evidence this selected processor consumes this prompt>"
    }]
  }, {
    "sourceKey": "s3_bucket",
    "sourceValueSha256": "<inventory setting value hash>",
    "disposition": "deployment",
    "reason": "<explicit approved deployment mapping/reconciliation requirement>"
  }]
}
```

For `ai_model`/`ai_provider`/`openai_base_url`, targets instead include selected `slot`, `connectorId`, integer `revision`, `connectorConfigSha256`, `configPointer` (provider/model routing paths only), `expectedConnectorValue`, and reviewed `semanticEvidence`, plus the API key/endpoint. Semantic expectedValue is an explicit reviewed correspondence, not automatic inference. Canonical hashes use exported `hash(value)` from `ldba-inventory.cjs`. All archive keys must appear exactly once, including explicit dispositions for encrypted secrets.

Set `LDBA_RECONCILIATION_MANIFEST=<private manifest file>` and `LDBA_RECONCILIATION_SHA256=<separately approved SHA256 of file bytes>`.

- `node scripts/ldba-reconcile.cjs --preflight` — checks bindings/semantic evidence, prints hashes and selected targets as diff without prompt/config values; no writes. Runtime server validation runs after draft creation on apply, not falsely represented as part of read-only preflight.
- Add `LDBA_ADMIN_ORIGIN=<HTTPS admin origin>` and `LDBA_ADMIN_BEARER=<admin token from secret management>`, then `node scripts/ldba-reconcile.cjs --apply`. HTTP only allowed for loopback synthetic environments; redirects are refused. Native RBAC/audit/CSRF-independent bearer action authorization and CAS still apply.
- Rerun identical manifest to resume after interruption; deterministic native idempotency prevents duplicate application. Changed target effective values produce a drift error, requiring a newly reviewed manifest. `--record-inventory` then refreshes dashboard evidence. External dispositions remain holds after mapped fields apply.

## Owner evidence

Cwd `/workspace/dugate/du-rework`; Node24.21.0 and pnpm10.18.3. Raw [orv12-data.raw.log](orv12-data.raw.log).

| Command | Result | Exit |
|---|---|---|
| `node --test orchestrator/services/orchestrator/tests/ldba-03-*.test.cjs orchestrator/services/orchestrator/tests/ldba-orv12-reconcile.test.cjs` |62 passed,0 failed,0 skipped|0|
| `pnpm --dir orchestrator/services/orchestrator typecheck` |clean|0|
| `pnpm --dir orchestrator/services/orchestrator exec jest --runInBand --runTestsByPath tests/orv12-migration-readiness.test.ts tests/artifact-read-decrypt-offline.test.ts tests/admin-local-user-repository.test.ts tests/orv11-legacy-reset-input.test.ts` |59 passed,0 failed,0 skipped|0|

Storage-focused suite alone42passed (subset, not additive). Independent VFY has reported fully populated nine-table PostgreSQL import+fresh-adapter encrypted connector/schema replay+9MiB output PASS; final HTTP mapping/local login/S3 receipts belong to VFY, not owner acceptance.

## Exact ORV12 owner paths

- scripts: `ldba-03-backfill.cjs`, `ldba-03-production-adapter.cjs`, `ldba-context-provider.cjs`; new `ldba-inventory.cjs`, `ldba-reconcile.cjs`.
- new migration `0047_legacy_migration_runs.sql`.
- new read module `src/modules/legacy-migration/readiness.ts`.
- `src/modules/auth/admin-local/credential-reader.ts`.
- `src/modules/encryption/artifact-read-decrypt.ts`.
- `src/http/routes/public.ts` only artifact-download SELECT/type/ref fields; prior broader diffs belong ORV11 OPS.
- `src/http/routes/runtime.ts` only artifact blob GET lookup/type/ref facts.
- tests: new `ldba-orv12-reconcile.test.cjs`, `orv12-migration-readiness.test.ts`; extended `artifact-read-decrypt-offline.test.ts`.
- this receipt/raw. SET owns bootstrap/versioned reader, Settings lifecycle and routes/BFF; API owns actual auth; UI owns dashboard.

All production data, source timezone observations, customer provider credentials/SSO, retrywindow closure, sizing and final switch remain explicitly outside synthetic fixture proof. No report equates row counts, archival or a zero exit status with full customer readiness.
