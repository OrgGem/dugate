# LIVE-READY-PREP-2 — offline preparation receipt

- **Packet:** LIVE-READY-PREP-2 (offline), run `run_069ecd6957cd`, task `task_cf6424e5dbc5`, dispatch `ctx_022b86640fab`.
- **Spec:** `coordination/dispatch-specs/2026-10-04-1935-LIVE-READY-PREP2.md`.
- **Owner:** `codex_tester_live`.
- **Prepared:** 2026-10-04 19:42 +07:00 (Asia/Bangkok).
- **Scope:** package the DD-03 legacy snapshot census for a future approved PostgreSQL window; prepare Vault Findings A–D role/crypto matrix; update the previous window-open checklist into an operator sequence.
- **Boundary:** offline only. No PostgreSQL, Redis, MinIO, Vault, application endpoint, or other service was contacted. The scan was not run and no credential/configuration value was read. No product source was changed. No commit, push, or reset was run.
- **HEAD:** `b088eececcb5f3df0b4edbe073a29401dafda624`; this is the shared worktree base only, not a digest of its dirty contents. No application build digest was produced.

## Deliverables

- Added [`scan-legacy-snapshot-counts.mjs`](../../tests/live-prep/scan-legacy-snapshot-counts.mjs), a fixed-query `psql` wrapper that only accepts one row of four integer counts and withholds all client output on errors or unexpected output.
- Added [`dd03-count-only-runbook.md`](../../tests/live-prep/dd03-count-only-runbook.md) with window inputs, protected service configuration, exact invocation, result interpretation and stop conditions.
- Updated [`live-test-prep-2026-10-04.md`](live-test-prep-2026-10-04.md) to replace its generic window checklist with the required-input block and ready-to-run sequence. Added a pointer in [`tests/live-prep/README.md`](../../tests/live-prep/README.md).

The query retains the DD-03 sample's four candidate counts. It projects neither snapshot JSON nor operation/task IDs; JSON fields are predicate inputs only, and `o.id` appears only inside `EXISTS` to correlate a task, never as returned data. The script launches `psql` without a shell, suppresses psql stderr, requires an explicit `--run`, service alias, approved-window marker, and external `PGSERVICEFILE`/`PGPASSFILE`, and prints only the four labeled integer counts on success. Its child gets only an allowlist of connection configuration plus `PGCONNECT_TIMEOUT=5`, preventing unrelated libpq environment variables from silently selecting a different target. Any nonzero client exit or non-count stdout is withheld and reported as a generic failure. This is a candidate census, not full schema validation or proof that any field is plaintext.

## Findings A–D and identity/crypto preparation

Historical findings below are setup facts from the earlier LIV05b/LIV11 reports, not current live status. Each must be rechecked against the approved isolated Vault namespace and current build during its window.

| Finding | Historical evidence and current preparation | Live-only check / gate |
|---|---|---|
| **A — Transit non-root** | LIV05b found `orchestrator-writer` and `connector-reader` had no Transit capabilities; scoped encrypt/decrypt calls were denied and only root could use the key. Policy ownership and least privilege remain an implementation/security decision. | In a dedicated mount/key, use the exact non-root identities below. Assert intended encrypt/decrypt succeeds and wrong-role/cross-role calls are denied. If rotation is required, assign a separately scoped rotator. Root-only success, wildcard policy, or shared-key mutation is HOLD. |
| **B — auth backend** | LIV05b/LIV11 observed only `token/`; the historical setup did not prove AppRole/Kubernetes machine identity. | Vault owner chooses a supported auth method and mount, or explicitly approves a token-only test model. Obtain short-lived scoped identities through that path and verify role separation/denial. Do not enable an auth backend on shared dev Vault from this prep. |
| **C — `worker-browser` policy** | The policy file existed in the repository but was absent from the historical dev Vault. The earlier report says worker/browser may not need Vault identities. | Owner first marks **required** or **N/A with rationale**. If required, test upload/rendered policy and positive/negative capabilities only in the approved isolated namespace. Historical absence alone is not a failure. |
| **D — root-token residue** | LIV05b recorded one root-policy token that could not be attributed/revoked safely; LIV11 also found accessors but did not establish safe ownership of that residue. | Leave shared historical residue untouched during this window. No broad accessor revoke, token guessing, key rotation, or Vault restart/recreate. Any reconciliation needs its own approved maintenance scope and an exact attributable identity. A fresh test namespace must track any new disposable token by owner/accessor from creation through revoke. |

Role/identity placeholders to complete with non-secret labels before opening the window:

| Function | Placeholder | Required mapping/evidence |
|---|---|---|
| Orchestrator KV writer | `<ORCH_KV_WRITER_ID>` | Auth method/mount, policy revision, scoped KV create/update allowed; KV read and out-of-scope access denied as designed. |
| Connector KV reader | `<CONNECTOR_KV_READER_ID>` | Auth method/mount, policy revision, pinned read allowed; write, out-of-scope, and unapproved Transit access denied. |
| Transit encryptor | `<TRANSIT_ENCRYPTOR_ID>` | Owner-designated service identity; encrypt on the isolated key allowed; unrelated key/path denied. |
| Transit decryptor | `<TRANSIT_DECRYPTOR_ID>` | Owner-designated service identity; decrypt only where the producer/consumer contract requires it; wrong-role call denied. |
| Transit rotator, if required | `<TRANSIT_ROTATOR_ID_OR_NA>` | Owner decision and narrowly scoped capability. Do not infer rotation rights from encrypt/decrypt. |
| Vault provisioner | `<VAULT_PROVISIONER_ID>` | Isolated-namespace setup identity and removal scope; never injected into application runtime. Root, if needed for disposable fixture provisioning, is not an acceptance identity. |
| Worker/browser Vault identity, if required | `<WORKER_ID>` / `<BROWSER_ID>` or `N/A` | Owner's Finding-C decision, distinct policy mapping and only the minimum approved operations. |

Keep token values, SecretIDs, passwords and client credentials in the approved secret channel. The receipt should contain only identity labels, auth method/mount, policy revision, capability outcomes and sanitized counts/statuses.

## DD-03 scan contract and run sequence

The packaged scan requires all of the following before execution:

1. User/Coordinator opens a window and records its ID, time bounds, operator, target non-production stack, current build digest and approved evidence path.
2. The DB owner confirms the exact database/schema and a dedicated non-owner read-only login with only required `SELECT` grants on `operations` and `tasks`. Confirm the service alias points to this target privately.
3. Configure a protected `pg_service.conf` and `PGPASSFILE` outside the repository through the approved secret process. Do not put passwords in an argument, `.env`, report, raw capture or shell transcript.
4. Confirm the expected columns/relations from the approved schema contract. Do not inspect rows to discover the schema.
5. Run the exact PowerShell command in `dd03-count-only-runbook.md`. It starts `BEGIN TRANSACTION READ ONLY`, sets `statement_timeout='5s'`, runs the fixed aggregate query, and issues `ROLLBACK`. Do not add psql echo/debug flags or substitute SQL.
6. Record only namespace label, time, literal command, literal process exit code and the four aggregate counts. Any nonzero count, error, timeout, ambiguous target or parser rejection is STOP/HOLD. Do not inspect individual rows or perform rewrite/delete/backfill; route remediation to a separately reviewed owner packet.

The runbook contains exact placeholders and the four output labels. The script does not print the database alias, window ID, connection configuration, snapshot content or IDs. Live existence of old-shape PostgreSQL rows and actual server transaction behavior remain **unverified** by this offline receipt.

## Updated window-open checklist

The checklist in `live-test-prep-2026-10-04.md` now has ready-to-fill user/Coordinator fields for the window, target/build, PostgreSQL service/role, isolated DB/Redis/MinIO/Vault/ES namespaces, secret channel, evidence path and cleanup owner. It then gives an ordered preflight, Finding A–D gates, exact DD-03 command and stop rules, lane execution conditions, and closeout requirements. Items that need user/Coordinator input are visibly marked and remain open; this packet does not infer the missing values from historical reports.

## Offline validation and literal results

Working directory: `D:\Git\dugate`; shell: Windows PowerShell `5.1.19041.6456`; Node `v22.16.0`. No live endpoint or database client was invoked.

| Command | Result | Literal exit code |
|---|---|---:|
| `node --check du-rework/tests/live-prep/scan-legacy-snapshot-counts.mjs` | Syntax valid; no output. | `0` |
| `node du-rework/tests/live-prep/scan-legacy-snapshot-counts.mjs --help` | Printed usage/precondition summary; no connection attempted. | `0` |
| `node du-rework/tests/live-prep/scan-legacy-snapshot-counts.mjs` | Guard refused execution: `DD03 scan not run: pass --run only inside an approved live window.` | `2` (captured as `$LASTEXITCODE`) |

The direct PowerShell native-command wrapper reports a generic nonzero status for the third command; the literal Node status was captured immediately as `SCRIPT_EXIT_CODE=2`. No `psql` command was run. Offline checks passed: syntax/help `2`; expected no-run guard `1`; failures `0`. Live scan cases invoked: `0`; live passed/failed/skipped: `0 / 0 / 0` (not run, pending a separate window). Live exit code and raw-output path: N/A.

## Questions to close before live execution

1. What approved window ID/time bounds, exact non-production stack, PostgreSQL namespace and current build digest should the operator use?
2. Which protected PostgreSQL service alias and read-only role/grants will the DB owner approve, and where is the sanctioned external `PGSERVICEFILE`/`PGPASSFILE` provisioned?
3. Which Vault auth method/mount is supported for this build, and which security owner approves the non-root Transit capability split and policy revision for A/B?
4. Does `worker-browser` require a Vault identity for this build? If yes, which owner supplies the isolated policy upload and allowed/denied operations; if no, who records the N/A rationale?
5. Is Finding-D residue explicitly out of scope for this test window? Any cleanup/reconciliation needs a separate owner, exact target and maintenance approval.
6. Which non-secret role labels, isolated Vault mount/key, test tenant labels, receipt directory and cleanup owner should be entered in the checklist before start?

**`Δ-DEVIATION: NO`** — deliverables and offline-only scope match the packet. The user/Coordinator inputs above are explicit open prerequisites, not deviations. No live test was run or gate status changed.
