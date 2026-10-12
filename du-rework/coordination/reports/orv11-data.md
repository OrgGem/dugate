# ORV11-DATA owner handoff — 2026-10-11

Scope: `du-rework/` only. Base HEAD `7e36a1e`; working tree edits, no commit/push. Owner `/root/migration`. IMPLEMENTED with owner checks; independent DB/runtime verification and acceptance pending. No customer database or real cutover performed.

## Implemented contracts

- `0044_legacy_cutover.sql`: nullable `profile_bindings.endpoint_slug` (NULL generic; exact legacy selector preserved), `operations.legacy_history`, non-effective `legacy_app_settings` archive, local identity reset marker and retained external-identity metadata.
- Importer writes `profile_api_keys` ACTIVE memberships with deterministic source creation timestamps after bindings. Role values map ADMIN/USER/VIEWER to runtime admin/operator/viewer. Parameters remain exactly preserved; API owner normalizes legacy parameter aliases on runtime read.
- Production slug resolver maps six `action:subcase` forms to enabled registry actions; `workflows:<name>` and `workflows:schema:<slug>` map named/schema actions. Ambiguous enabled action versions still refuse import.
- Source uses bounded in-memory materialization (NOT streaming/chunked apply); production row/blob sizing is a separate mandatory gate. Source reads all nine tables once using one dedicated PostgreSQL `REPEATABLE READ READ ONLY` transaction, stable primary-key ordering and explicit row ceiling. Exceeding ceiling refuses the entire snapshot; no truncation/delta. Snapshot digest plus table counts are reported. Same adapter remains frozen; create a new adapter/process for a new source snapshot.
- Execute no longer accepts `LDBA_ALLOW_UNVERIFIED_TIMEZONE`. Evidence file must match separately supplied SHA256, exact source version and complete frozen source-data digest; reviewed independently sourced UTC observations must match actual source row/timestamp values. Only proven UTC is currently supported; non-UTC requires a separately specified conversion, not relabeling.
- RUNNING/PENDING/QUEUED/WAITING_USER_INPUT rows reject with DRAIN_REQUIRED. No task/checkpoint/queue item is fabricated. Complete/cancel/resume and finish these in legacy before freezing. Terminal results retain original IDs, output content/data/history. Historical callbacks are retained but not redelivered; pending historical delivery needs reconciliation.
- Live historical input refs map through verified FileCache rows to `{artifactId,role:'input'}`. Output paths become actual `legacy-filecache/<id>` storage keys, with verified size/MD5 source bytes and SHA256 target blob. Missing undeleted file/output mappings fail. Already deleted file history remains retained without fabricated output.
- Non-workflow AppSettings are preserved unchanged in an archive with explicit effective-configuration reconciliation omissions. Five legacy sensitive setting keys must retain valid legacy ciphertext format; plaintext refuses import. Archive has no new public/admin read endpoint and is NOT an active settings store.
- Local user IDs and assignments are retained disabled/locked, with a syntactically valid unusable verifier and reset-required marker. No bcrypt verifier or plaintext password is imported. External identity metadata is retained; external-provider accounts cannot use the local reset activation path. Trusted operator CLI provisions a new password via stdin, conditionally activates only a still-disabled reset-required identity, clears its marker, increments version and audits atomically.
- Reviewed per-profile connector pins may be supplied by manifest; exact profile/endpoint/business/version/action scope and manifest digest are checked. Target validation/application verifies each pin has a global or same-tenant revision. Empty pins on enabled profiles produce explicit cutover reconciliation omissions; the importer does not guess connector semantics from a legacy chain.
- Encrypted connector/schema replay authenticates stored AND freshly prepared envelopes and compares plaintext; schema reuse also verifies tenant/slot/revision AAD and plaintext SHA. Only then are existing encrypted bytes reused. Changed/corrupt ciphertext, missing decrypt keys/seams or changed definitions fail immutable replay.

`APPLIED` means rows were written, not release readiness. Report includes `cutoverReady:false` and explicit gate text. Settings/profile omissions, external identity mapping, legacy idempotency reconstruction, drain, independent runtime verification and source freeze remain cutover gates. Historical idempotency values are retained for audit; missing original submission fingerprints are not fabricated. Cutover must drain the legacy client retry/idempotency window or explicitly fence client retries and reconcile original operation IDs before enabling new submissions. Without that fence/reconciliation, an old-key resubmit can become a new operation; full cross-cutover idempotency compatibility is NOT claimed.

## Exact changed files

Relative to `du-rework/`:

- `orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs`
- `orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs`
- `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs`
- `orchestrator/services/orchestrator/migrations/0044_legacy_cutover.sql` (new)
- `orchestrator/services/orchestrator/src/modules/auth/admin-local/repository.ts`
- `orchestrator/services/orchestrator/src/modules/identity/legacy-reset-cli.ts` (new)
- `orchestrator/services/orchestrator/tests/ldba-03-backfill-offline.test.cjs`
- `orchestrator/services/orchestrator/tests/ldba-03-production-adapter.test.cjs`
- `orchestrator/services/orchestrator/tests/ldba-03-runner-skip.test.cjs`
- `orchestrator/services/orchestrator/tests/orv11-legacy-reset-input.test.ts` (new)
- this receipt and `coordination/reports/orv11-data.raw.log`.

## Owner evidence

Cwd `/workspace/dugate/du-rework`, Node `v24.21.0`, pnpm `10.18.3`; toolchain PATH `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin:$PATH`. Synthetic isolated fixtures only.

| Command | Result | Exit |
|---|---|---|
| `node --test orchestrator/services/orchestrator/tests/ldba-03-*.test.cjs` | Final 54 passed, 0 failed, 0 skipped (prior appended runs 53; not additive) | 0 |
| `pnpm --dir orchestrator/services/orchestrator typecheck` | clean | 0 |
| `pnpm --dir orchestrator/services/orchestrator exec jest --runInBand --runTestsByPath tests/admin-local-user-repository.test.ts tests/admin-local-users-cli.test.ts tests/orv11-legacy-reset-input.test.ts` | 25 passed, 0 failed, 0 skipped | 0 |

Raw: [orv11-data.raw.log](orv11-data.raw.log). Separate exploratory `legacy-identity-adapter.test.ts` could not compile because `bcryptjs` is unavailable in this workspace (existing test dependency); 20 other tests in that invocation passed. Its raw `/tmp/orv11-data-identity.txt` is not claimed as green. Independent verifier informed. Existing LDBA08/09 Docker harness expectations model pre-drain mixed active states/old controlled skips; not rerun or represented as current acceptance. Current independent PostgreSQL rehearsal owns final gate.

## Concrete one-time migration runbook

1. On isolated clone first: apply all migrations including0044; register exact enabled businesses/connectors; seed exactly one tenant named `legacy-default` (normal tenant tooling). Preserve a source DB/object-store backup and target backup. Drain source jobs/HITL; stop source writes. A source version identifies that frozen backup, never an arbitrary mutable live database.
2. From `du-rework/orchestrator/services/orchestrator`, use Node24.21 and environment below (actual secrets via deployment secret management; never put them in reports):

```text
LDBA_A1_PASSED=1
LDBA03_SOURCE_VERSION=<frozen-backup-version>
LDBA_A1_SOURCE_VERSION=<same-frozen-backup-version>
LDBA03_SOURCE_DATABASE_URL=<read-only-source-url>
LDBA03_TARGET_DATABASE_URL=<isolated-target-url>
LDBA03_SOURCE_SCHEMA=<legacy-schema>
LDBA03_ADAPTER_MODULE=<absolute-path>/scripts/ldba-03-production-adapter.cjs
LDBA_SKIP_POLICY=fail
LDBA03_MAX_ROWS_PER_TABLE=100000
LDBA03_FILECACHE_OBJECT_DIR=<materialized-source-object-root>
CONNECTOR_ENCRYPTION_KEY=<base64-target-32-byte-key>
DU_ENCRYPTION_METADATA_ENABLED=true
LDBA03_METADATA_SEAM_MODULE=<absolute-trusted-key-provider-module>
LDBA03_METADATA_KEY_REF=<target-key-ref>
```

Metadata module exports `wrapDek(dek,keyRef)` and `unwrapDek(wrapped):Promise<Buffer>`, matching the runtime metadata key contract. Returned decrypted buffer is zeroed after use; providers should return owned buffers. A wrap-only seam can import a first definition but cannot safely authenticate replay.

3. `node scripts/ldba-03-backfill.cjs --preflight > <private-preflight-report.json>` provides `sourceSnapshot.sha256` and counts (even if row transformation later blocks). Resolve every source/transform failure before execution. Create a reviewed timezone evidence JSON binding that digest:

```json
{
  "sourceVersion": "<frozen-backup-version>",
  "sourceDataSha256": "<reported-complete-source-SHA256>",
  "timezone": "UTC",
  "reviewedBy": "<responsible-reviewer>",
  "observations": [{
    "table": "Operation",
    "sourceKey": "<actual-operation-id>",
    "field": "createdAt",
    "naive": "<exact-source-text-timestamp>",
    "utc": "<independently-confirmed-ISO-UTC-time-ending-Z>",
    "reference": "<independent-log-or-source-deployment-evidence-reference>"
  }]
}
```

Do not generate a fake reference or assume server timezone proves historical data. Supply `LDBA03_TIMEZONE_EVIDENCE_FILE=<absolute-file>` and separately approved `LDBA03_TIMEZONE_EVIDENCE_SHA256=<sha256-of-file-bytes>`. Changed source invalidates proof. Repeat preflight then execute using the same frozen source; never use the removed bypass.

4. If needed, provide reviewed `LDBA03_PROFILE_BINDINGS_FILE` plus `LDBA03_PROFILE_BINDINGS_SHA256`. Example shape:

```json
{
  "sourceVersion": "<frozen-backup-version>",
  "reviewedBy": "<reviewer>",
  "profiles": {
    "<legacy-ProfileEndpoint-id>": {
      "endpointSlug": "extract:invoice",
      "businessId": "document-core",
      "businessVersion": "<registered-version>",
      "action": "extract",
      "connectorBindings": {"reasoning": {"connectorId": "<registered-id>", "revision": 1}}
    }
  }
}
```

Importer checks scope/pin existence; runtime contract/capability checks and executing the actual legacy request still must verify semantic mapping. Settings archive must be mapped into effective connector/profile/deployment configuration; archival itself never satisfies behavior compatibility.

5. `node scripts/ldba-03-backfill.cjs --execute > <private-import-report.json>`. Run again from a fresh process against the exact snapshot before any target user/config mutation: no duplicate rows; encrypted rows replay identically only after authenticated comparison. Source delta or changed target immutable rows is a conflict requiring a fresh rehearsal/target restore; this is not CDC/upsert.
6. After successful import/replay, build orchestrator. For each approved **local** migrated account, feed a newly provisioned password securely over stdin to `node dist/modules/identity/legacy-reset-cli.js <tenant-id> <user-id>`. Password is never an argv/env argument. One successful activation clears the marker; wrong tenant, non-imported/external/already-enabled accounts refuse. External providers require explicit identity configuration reconciliation. Once activated, re-import into that mutated target correctly conflicts; replay test belongs BEFORE operational mutations.
7. Independently verify old API key -> exact profile/subcase policy -> real business worker -> result by old/new ID; fetch historical output and compare actual bytes/hash; verify reset login and assignment scope, callback reconciliation, settings behavior, and workflow profiles. Count/source hashes alone are insufficient. Review omissions, no unsupported state/file silently discarded.
8. Production cutover only after the same clone rehearsal gates pass: final backup, drain/freeze, final proof tied to that exact source, import, reconcile/activate, smoke, route clients to new deployment. Keep old deployment read-only and backups until acceptance. Rollback before new target writes can restore routing to the frozen legacy deployment; rollback after new writes requires an explicit data reconciliation decision (no automatic reverse sync).
