# LIVE-READY-PREP3 — live window runbook v2

- Packet: LIVE-READY-PREP3, coordinator dispatch 2026-10-05 02:33 +07:00.
- Owner: codex_tester_live.
- Mode: offline document preparation only.
- Status: runbook is prepared; live execution remains closed pending the window record, isolation, identity decisions, and blockers in this document.
- No live service, database, object store, Vault, browser, or provider was contacted. No source/test file changed. No commit, push, reset, or task-gate edit was made.
- Source set reviewed: LIVE-PLAN-REFRESH, LIVE-READY-PREP-2, the earlier eight-question window checklist, LIVE-TEST-PLAN §4, and bounded LIV03–LIV11 receipts.

## Preparation provenance

- Prepared 2026-10-05 02:50 +07:00 from repository HEAD `b088eececcb5f3df0b4edbe073a29401dafda624`.
- The workspace was already dirty, including mutable and untracked source/evidence inputs. This packet created this report only; the hashes below bind the relevant files as inspected and do not claim they are committed at the stated HEAD.

| Inspected input | SHA-256 |
|---|---|
| `coordination/reports/live-plan-refresh-2026-10-05.md` | `09BD11493F4A4EB45363065F1549C97A9E7D5DFB311891590FAB65F1BE32CAB8` |
| `coordination/reports/live-ready-prep2-2026-10-04.md` | `835299119462D9F173A1742FB209BEE2C72719A3F5BC26807A27CAED94756BB2` |
| `coordination/reports/live-test-prep-2026-10-04.md` | `148346871F4AAA4E629CE094E62C9E81CD8EBD879DBD3139A0F97D005F6A9CB6` |
| `tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md` | `0A093B6A2E68D338664292267353D3B69218EA0E5D8B1DDA0C142FEAEC69BCBE` |
| `scripts/dev-live.ps1` | `428A5F3AD1D1A9A56798DCBC9D1C5A2C570ECD1A086FC3F7C77702FD86615B11` |
| `scripts/dev.cjs` | `88955D28C68AA934694E0D9E1978F1903974BF6D31D1029DDE9C8CF32847FCE8` |
| `infra/docker-compose.live.yml` | `581484F606ADDEC631F9394D242A7204FE9C146124863005E7EA911884D5B929` |
| `tests/live-prep/scan-legacy-snapshot-counts.mjs` | `B90BD4037035A9B66C071C63CBADB1DA0451974AC566F150802A66EF36E37D21` |
| `tests/live-prep/dd03-count-only-runbook.md` | `CE3756E8A7AD635754FA37B6304F55D8AD0E251F6346FC9434AFD09DEC9DC751` |

## Purpose and operating boundary

This is the v2 operator runbook for one explicitly approved, non-production live window. It folds in five new cells from LIVE-PLAN-REFRESH:

- LIV-CW-01: real Vault credential workflow and connector chain.
- LIV-EM-01: ENCMETA result_ref and legacy-row window.
- LIV-CM-01: connector management ledger round-trip.
- LIV-SS-01: provider-side sessionRef evidence.
- LIV-PC-01: provider-observed prompt carrier evidence.

It retains the existing G-SEC, G-ENC, G-ADMIN-OPS, and G-DATA evidence cells and all eight questions from the 2026-10-04 window checklist. It reuses LIV03–LIV11 only for the assertions those receipts actually observed; historical service health or a previous green suite is not today's readiness proof.

V-CREDWORKFLOW is settled PASS for its offline implementation evidence. That does not settle real Vault identity, policy, connector-reader, or outage evidence; those remain live-only in LIV-CW-01.

The read-only/count-only rule applies to direct data inspection and evidence collection: no ad hoc SQL, no row values, snapshots, secrets, operation/task IDs, object keys, Vault data, queue keys, prompt bodies, or provider payloads in terminal output or receipts. The packaged DD-03 scanner returns four integer counts inside a read-only transaction with a 5-second statement timeout. It returns no IDs or JSON. Application acceptance flows may create persisted synthetic state only inside the specifically approved run namespace; test logic may hold sensitive values in memory, while receipts retain only statuses, aggregate counts, hashes, and pass/fail flags. Manual SQL writes, row exports, backfills, shared-resource cleanup, and secret display are out of scope.

## Evidence reused and current qualifications

| Prior source | Reusable evidence | Boundary carried into this runbook |
|---|---|---|
| LIV03 services health | On 2026-10-04, Orchestrator 3000, Admin shell 3001, Connector 8091 passed 18/18 health checks across six rounds. PostgreSQL 5433, Redis 6380, MinIO 9003/9014, and Vault 8200 were reported healthy. | This is a dated snapshot, not a live check for the next window. Ports and owners must be rechecked read-only. Preserve the 8091 Connector and 9014 MinIO-console deviation; the old 8081/9004 mappings were occupied. Do not inspect or print process command lines. |
| LIV04 and LIV11 | The prior S3 pilot passed its stated multipart/limits/fencing/TTL cases. It used bucket du-artifacts-live2, while the application configuration named a different bucket. | Do not repeat the same pilot merely to restate its pass. It did not prove raw object-version byte continuity or plaintext byte-scanning in the application's configured bucket. A new bucket/prefix and exact count/status evidence are required for those claims. |
| LIV05, LIV05b, LIV11 | Prior Vault work confirmed a real dev Vault, but also documented non-root Transit denial (Finding A), only token auth observed (Finding B), worker/browser policy absent historically (Finding C), and an unattributed root-token residue (Finding D). | These findings remain historical until rechecked in the approved namespace. Root is not an acceptance identity. Do not rotate a shared key, upload policies to the shared mount, revoke the unattributed residue, or rerun the shared bootstrap script. |
| LIV06 | Prior live pipeline evidence is retained for its exact fixture/build/path only. | It does not stand in for the new file-upload, result_ref, credential-reader, sessionRef, or provider-observed carrier claims below. |
| LIV07–LIV10 and LIV11 | Browser/navigation evidence and later reconciliation are retained for the exact routes and screenshots recorded there. | They do not prove the selected current React route/build, two-tenant role matrix, full Admin mutation lifecycle, or provider request contents for this window. |
| LIVE-PLAN-REFRESH §4 | Adds the five LIV-CW/EM/CM/SS/PC cells and their implementation-side sources. | Expected behaviors are copied as live acceptance targets, not live evidence. In particular, connector-side credential reading remains a D5 gap; provider-side sessionRef and prompt capture require an actual observing provider/stub. |

### Infrastructure reuse and boot hazards found offline

The existing live Compose file defines only PostgreSQL, Redis, MinIO, and Vault. It pins the Compose project name, fixed container names (du-live-postgres, du-live-redis, du-live-minio, du-live-vault), and host ports. Starting another copy with only a different Compose project name does not isolate those fixed names or ports. It also has no Elasticsearch service. LIV03–LIV11 do not establish an Elasticsearch endpoint, version, or index.

The cited scripts/dev-live.ps1 exists and invokes scripts/dev.cjs with .env.live. Source inspection of dev.cjs found these behaviors:

1. On Windows it checks ports 3000, 3001, 8088, and 8091. If any are occupied, it runs stop-all.cjs before launch. That can stop a process not owned by this window.
2. It builds services if expected dist entrypoints are missing.
3. It invokes migrate-local.cjs on the selected env file; it can continue after reporting a migration warning.
4. It starts Orchestrator and Connector together, waits up to 10 seconds for Orchestrator /health, then starts the document-core worker. Admin shell is served by the Orchestrator on 3001.

Therefore scripts/dev-live.ps1 is runnable only after the exact .env.live target is privately verified as isolated, migration is explicitly approved for that disposable target, expected builds are pinned, and every occupied app port is proven to belong to this run or is free. If an unrelated or historical service owns one of those ports, stop before invoking the manager. Do not run docker compose up/down, init-live-infra.ps1, stop-all.cjs, or migration commands against the existing du-live stack as a shortcut. The historical init script mutates a fixed bucket/Vault setup and does not create the auth backend needed to settle Finding B.

The fixed ports and automatic port cleanup make the current scripts unsuitable for parallel windows on the same host. The default is one window at a time. If isolation requires another stack, the owner must provide a genuinely isolated stack/config and exact boot command; changing only the Compose project label is insufficient.

## Window record and the eight inherited questions

The previous eight questions were found in live-test-prep-2026-10-04.md §Questions to resolve before running live. LIVE-PLAN-REFRESH said that list could not be found, but the earlier prep receipt contains the numbered list below. V2 preserves all eight and adds only clarifications needed to make their answers actionable. No answer is inferred from historical .env files or old service state.

1. Window and target: What exact date/time bounds, operator, stop contact, non-production stack, service endpoints, current commit/build digests, and disposable/local status are approved? What exact boot command/target is authorized, given dev-live's automatic stop-all and migration behavior?
2. Vault auth and roles: Which auth backend will the test Vault use, who owns scoped Transit policy changes, and what is the approved writer/reader/encrypt/decrypt/rewrap role matrix? Is historical Finding-D residue explicitly excluded for a separate maintenance task?
3. Isolation and cleanup: Which dedicated PostgreSQL database/schema, Redis DB/prefix, MinIO bucket/prefix, Vault mount/key/path, Elasticsearch index, and synthetic tenant/account labels are approved? Which exact test-created resources may the named cleanup owner remove?
4. Admin auth and providers: Which Admin modes run (local, OIDC, or both), what exact React route/build is under test, and who supplies separate two-tenant admin/reader identities plus controlled OIDC/provider test services?
5. G-ENC contract: Is recipient decryption required for the selected output? Which upload/result routes and provider stub are authoritative? Must ARTIFACT_STORAGE_MIGRATION_WINDOW remain false for every acceptance case? If a true compatibility case is desired, is it a separate approved synthetic-only window with no backfill?
6. G-ADMIN-OPS contract: Which operation states and create/cancel/resume actions are approved, what audit outcomes are expected, and which tenant/role/CSRF matrix defines pass? Which reviewed aggregate query, if any, may emit counts without selecting audit values or IDs?
7. G-DATA contract: What retention/delete policy, migration source/target, restore RPO/RTO, and Elasticsearch version/index/event contract are accepted? Is Elasticsearch available in this same window, or does that cell need its own scheduled target?
8. Evidence layout: Does each cell get an individual raw receipt or a sanitized per-cell subdirectory under one coordinator-provided run ID? Proposed default: one approved run-ID directory with one subdirectory per gate/cell; keep only status/count/hash/exit evidence.

All eight remain OPEN until the coordinator/user records answers in the window record. The proposed evidence layout in question 8 is a default, not authorization to create the directory before approval.

## Namespace and identity matrix to fill before boot

Use a fresh non-secret run label such as <RUN_ID>; make the cell component explicit for resources that can run independently. Keep credentials and protected service files outside the repository and shell transcript. Do not copy the historical .env.live contents wholesale.

| Resource or identity | Required isolated value/placeholder | Required proof before test |
|---|---|---|
| Build | <ORCHESTRATOR_DIGEST>, <CONNECTOR_DIGEST>, <WORKER_DIGEST>, <ADMIN_ROUTE_BUILD> | Each is tied to the approved commit and receipt. If dev.cjs builds missing outputs, record the resulting digest before acceptance. |
| PostgreSQL | <PG_DATABASE_OR_SCHEMA>, <PG_APP_ROLE>, <PG_READ_ONLY_ROLE> | Application writes target only the dedicated namespace. DD-03 role is not owner/superuser and has only the approved SELECT grants. Verify target mapping privately; never print connection material. |
| Redis/BullMQ | <REDIS_INSTANCE_OR_DB>, <REDIS_PREFIX>, <CONNECTOR_QUEUE_PREFIX> | Prove Orchestrator, Connector, and worker use the same per-run namespace and cannot consume another worker's queue. Do not enumerate keys. |
| MinIO/S3 | <MINIO_ENDPOINT>, <RUN_BUCKET>, <RUN_PREFIX> | Dedicated empty test bucket/prefix with versioning status approved. Do not use the previous shared buckets as this run's namespace and do not list object keys/versions into output. |
| Vault KV v2 | <KV_MOUNT>, <RUN_PATH_PREFIX>, <KV_POLICY_REVISION> | Dedicated path/mount and the named non-root writer/reader identities. A write/read result records status and version count/number only; never record KV values. |
| Vault Transit | <TRANSIT_MOUNT>, <RUN_KEY>, <TRANSIT_POLICY_REVISION> | Dedicated key and distinct least-privilege identities. No mutation of du-app-encryption-key or shared key versions. |
| Elasticsearch, if G-DATA runs | <ES_ENDPOINT>, <ES_VERSION>, <RUN_INDEX> | Data owner confirms the service and isolation. It was not in the LIV03 compose stack or health matrix; without these inputs, DATA-LIVE-04 stays HOLD. |
| Tenant/connector/provider | <TENANT_A>, <TENANT_B>, <CONNECTOR_LABELS>, <PROVIDER_STUB> | Synthetic principals/data only. Store identifiers in runner memory; receipt shows labels and aggregate outcomes, not database IDs or request bodies. |
| Evidence | <APPROVED_RECEIPT_ROOT>/<RUN_ID>/<CELL> | Coordinator-approved location. Raw tokens, credentials, snapshots, prompt text, SQL rows, operation/task IDs, object keys, and browser secrets are prohibited. |

Vault role labels from LIVE-READY-PREP-2 must be completed with non-secret names before start:

| Function | Placeholder | Positive/negative capability evidence |
|---|---|---|
| Orchestrator KV writer | <ORCH_KV_WRITER_ID> | Own-prefix KV write/CAS allowed; read or out-of-scope access denied unless separately specified. |
| Connector KV reader | <CONNECTOR_KV_READER_ID> | Exact pinned read allowed; KV write, out-of-scope path, and unrelated Transit actions denied. |
| Transit encryptor | <TRANSIT_ENCRYPTOR_ID> | Encrypt only on the approved run key; other key/path denied. |
| Transit decryptor | <TRANSIT_DECRYPTOR_ID> | Decrypt only where the selected consumer contract requires it; wrong-role call denied. |
| Transit rotator | <TRANSIT_ROTATOR_ID_OR_NA> | Explicit owner decision; do not derive rotation permission from encrypt/decrypt. |
| Namespace provisioner | <VAULT_PROVISIONER_ID> | Provisions only the run namespace. Never injected into Orchestrator/Connector/worker. Root may be used only for isolated setup if separately approved, never as acceptance identity. |
| Worker/browser Vault identity | <WORKER_ID_OR_NA>, <BROWSER_ID_OR_NA> | Finding C owner marks required or N/A with rationale; if required, a separate narrowly scoped identity must be tested. |

Finding A/B/C/D outcomes in LIVE-READY-PREP-2 are historical. Do not treat a source policy file as proof it is loaded in Vault. Finding D remains untouched. Do not use root-only success as a pass.

## Boot order for an approved isolated window

This order is a dependency map, not an instruction to start the existing shared stack now.

| Order | Service/action | Ready check and safe evidence |
|---:|---|---|
| 0 | Record window ID, run ID, build digests, endpoints, role labels, cleanup owner, evidence path, and stop contact. Resolve all eight questions and the blockers below. | Complete signed window record. Missing target or namespace means STOP before any process start. |
| 1 | Reuse the already-provisioned infrastructure only if its owner confirms it is the approved isolated target. If cold, the infrastructure owner supplies a dedicated start procedure for PostgreSQL, Redis, MinIO, and Vault. Add Elasticsearch only if Q7 is answered with a verified dedicated endpoint. | Docker/service health and target port counts only. Historical mapping: PG 5433, Redis 6380, MinIO API 9003/console 9014, Vault 8200. Do not restart/reinitialize du-live containers from this prep. |
| 2 | Provision the run namespaces, policies, and identities through their owners. Apply DB migrations only to the dedicated disposable target and only when approved. Create the versioned bucket and Vault mounts/keys under the exact run prefix. | Owner attestation, namespace labels, policy revision, aggregate resource counts/status. No row, key, object, or Vault value enumeration. |
| 3 | Start the controlled provider/OIDC test stub when required by LIV-SS, LIV-PC, G-SEC, or Admin browser cases. Configure it to report only request count, status, and in-process equality/hash results. | Stub readiness and zero cross-run requests; no raw prompt, credential, or provider body saved to disk. |
| 4 | Start Orchestrator and Connector from the approved .env.live target. If using scripts/dev-live.ps1, first satisfy every stop/build/migration guard described above. The manager starts these two processes together. | Readiness requests report only status codes: Orchestrator GET /health, Admin shell GET /admin/login, Connector GET /health/ready. Check Connector independently; the manager waits only on Orchestrator. |
| 5 | Start document-core worker only after its exact Redis queue prefix, Vault identity, and MinIO namespace are verified. dev.cjs starts it after the Orchestrator health wait; if starting separately, use the owner-approved command. | Worker readiness and queue activity are reported as counts/status only; prove the worker cannot claim other runs' work. |
| 6 | Run approved API/functional cells serially on the shared host. Run browser cells last using fresh isolated browser profiles for each role/tenant. | One cell's status/count/hash/exit receipt at a time. No concurrent mutation of shared connector rows, queues, buckets, or Vault paths. |

The only app-manager invocation prepared by the existing repository is:

    Set-Location D:\Git\dugate\du-rework
    .\scripts\dev-live.ps1

This invocation is conditional, not yet authorized. It reads .env.live, may run a build, invokes the migration checker, and can call stop-all on occupied app ports. Do not paste the contents of .env.live into chat, a terminal transcript, or this report. If an isolated environment cannot satisfy those conditions on ports 3000/3001/8088/8091, the owner must provide a separate boot method; do not change ports by assumption because the manager health wait is hard-coded to localhost:3000.

## Safe-check list at window open

Check each item in order. Checks and outputs have not been run by this offline preparation.

- [ ] Window record is approved, in time bounds, and identifies this exact stack/build. The operator, stop contact, evidence path, and cleanup owner are reachable.
- [ ] Host/port ownership is checked without printing process command lines or environment. The four ports that trigger dev.cjs cleanup are accounted for. Any unknown process owner is STOP.
- [ ] If using existing du-live services, the owner confirms this namespace is exclusive enough for the listed test cells. Do not infer isolation from 127.0.0.1 or from a different Compose project name.
- [ ] Build digests match the approved record after any build. The service env file maps to the run-specific DB, Redis, S3 bucket, Vault mount/key, and provider stub. Record only variable names/boolean configured status; never echo values.
- [ ] Readiness probes are GET/status-only: Orchestrator /health, Admin /admin/login, Connector /health/ready, MinIO health, Vault /v1/sys/health, plus owner-approved PostgreSQL/Redis readiness checks. Do not save response bodies. Elasticsearch readiness is skipped/HOLD until its exact endpoint/version/index is approved.
- [ ] DD-03 census runs before any migration or application action that could change the target schema/data. Use tests/live-prep/scan-legacy-snapshot-counts.mjs only with its protected service alias, read-only login, explicit window marker, READ ONLY transaction, 5-second statement timeout, and exact four-count output. Follow tests/live-prep/dd03-count-only-runbook.md verbatim; never use ad hoc psql.
- [ ] Any non-zero DD-03 candidate count, nonzero command exit, timeout, unexpected output, schema mismatch, or ambiguous service alias is STOP/HOLD. Do not select candidate rows, snapshots, values, or IDs; do not retry against another database or backfill.
- [ ] Confirm G-ENC migration-window decision before boot: default acceptance profile is false. The LIV-EM true compatibility branch is not run unless explicitly separated and approved as a synthetic-only cell. No backfill/migration write belongs to LIV-EM-01.
- [ ] Vault auth backend and A/B policies are confirmed on the run namespace with non-root test identities. Finding C is either explicitly required and provisioned or N/A with rationale. Finding D residue is untouched.
- [ ] Bucket versioning and prefix ownership are confirmed without listing object keys/version IDs. Redis DB/prefix and queue consumer ownership are confirmed without enumerating keys.
- [ ] Admin mode, CSRF, tenant/role credentials and provider/OIDC stubs match the selected matrix. Browser contexts are fresh and screenshots are checked for secret/PII exposure before save.
- [ ] Provider request capture is computed in memory. Receipt stores only request count, expected/actual equality flag, and digest; never persist raw sessionRef or prompt body.
- [ ] Raw output uses only approved status/count/hash/exit artifacts. Suppress exception bodies and service diagnostics if they may include configuration, credentials, snapshots, IDs, or provider payloads.

The approved DD-03 invocation, with window-supplied placeholders, is:

    $env:DD03_WINDOW_APPROVED = '1'
    $env:DD03_WINDOW_ID = '<APPROVED_WINDOW_ID>'
    $env:PGSERVICEFILE = '<PROTECTED_PATH_OUTSIDE_REPOSITORY>'
    $env:PGPASSFILE = '<PROTECTED_PATH_OUTSIDE_REPOSITORY>'
    node tests/live-prep/scan-legacy-snapshot-counts.mjs --run --service '<APPROVED_READ_ONLY_SERVICE_ALIAS>'
    $scanExit = $LASTEXITCODE

Only the four documented integer counts, timestamp, namespace label, command, and literal exit code may enter the sanitized receipt. Clear the four env variables after the scan without echoing them.

## Offline-provable versus live-only

| Cell | Offline-provable evidence | Live-only evidence still required |
|---|---|---|
| G-SEC / SEC-LIVE-01..05 | Contracts, policy parsing/mapping, action authorization order, fail-closed behavior, mocked writer/reader paths, response redaction, and unit/browser harness assertions. | Actual selected auth backend, distinct non-root identities and policy revisions, allowed/denied Vault capabilities, real Admin login/CSRF/tenant boundaries, and upstream provider non-call on denial. Historical Finding A/B remain blockers. |
| G-ENC / ENC-LIVE-01..03 | Envelope seal/open/tamper behavior, result_ref and snapshot resolvers, legacy-shape fail-closed fixture, storage version-pinning logic, offline fixture hashes, and worker/action contract tests. | Current DB census (counts only), actual MinIO stored bytes/version behavior, actual worker/Connector path, recipient decryption if selected, true outage/tamper behavior on disposable resources. Live backfill is separate. |
| G-ADMIN-OPS / ADMIN-LIVE-01..04 | Admin action schemas, RBAC/CSRF/idempotency ordering, connector/admin proxy contract, route rendering and mocked browser journeys. | Selected real Admin mode and current route/build; two real test tenants/roles; approved mutations against synthetic rows; status/audit-count deltas and real browser evidence. |
| G-DATA / DATA-LIVE-01..04 | Retention/migration code paths and schemas, S3 adapter semantics, collector retry logic, deterministic unit fixtures. | Exact object-version bytes, retention/delete effects, snapshot migration and restore into isolated targets, and Elasticsearch collector delivery/retry on the approved ES deployment. ES service/version is not yet identified. |
| LIV-CW-01 | The preceding VERIFY-CREDWORKFLOW receipt: local Jest 29.7 suites 12/12 x3, 9-suite regression 89/89, TSC 0; fake Vault fetch, fake revision store, fake connector, and scripted pg. | Real KV2 CAS versions, real machine identity, policy denies, Vault outage handling, real connector-side pinned reader/provider call, and audit/DB sink counts. D5 reader remains a gap until its live path exists. Do not accept root-token vault-live.test.ts smoke as role-matrix evidence. |
| LIV-EM-01 | Offline encryption/decryption, result_ref resolution, R1/R2/R3 context pinning, tamper and cross-tenant failure tests. | Actual legacy row existence and schema counts, app route round-trip and permitted compatibility read. Never infer old rows from fixtures. True migration compatibility requires separate approval; no rewrite/backfill in this cell. |
| LIV-CM-01 | Connector-management proxy, DTO, action, idempotency, redaction, and error mapping through offline fakes. | Real service ledger across upsert/activate/disable/retire/test, persistence/idempotency behavior, CAS conflict with zero audit delta, and real auth/header scope. |
| LIV-SS-01 | Request-carrier types and adapter forwarding shape under offline tests. | A provider that actually accepts the synthetic non-null sessionRef; JSON and multipart captured requests and matching canonical hash. Current historical mock did not process sessionRef, so a capture-capable provider is a prerequisite. |
| LIV-PC-01 | Static carrier wiring, profile/exact/_default precedence, prompt pinning and retry/child/HITL offline semantics. | Observed provider request proving A stays pinned after B publishes, including cleared-exact behavior. Store only equality/hash/count outcomes; do not save the raw prompt in a receipt or durable artifact. |

A green offline cell never substitutes for its live-only column. A skipped live case is not a pass.

## Cell execution order, safe assertions, and stops

1. Run the approved count-only DD-03 scan before app boot or migration when checking legacy PostgreSQL shape. This is only a candidate census, not complete schema validation.
2. If the census and namespace checks pass, start the approved app stack. Verify readiness by status codes only.
3. Run LIV-CW-01 and LIV-CM-01 serially with isolated connector/tenant/Vault labels. Confirm KV metadata version increments without reading KV values. Test wrong CAS and scoped policy denies. If the connector cannot read the pinned version through its own identity, record D5 as BLOCKED/LIVE GAP; do not substitute a human/root KV read.
4. Run LIV-EM-01 on synthetic inputs and the approved legacy policy. Keep migration window false for default acceptance. No data rewrite/backfill or direct row inspection.
5. Run the selected G-SEC and G-ADMIN-OPS identity/auth/browser cases. Use only the exact action/state matrix approved in questions 4 and 6. Verify side-effect and audit deltas by aggregate count or application return status; no audit row values/IDs.
6. Run G-ENC and G-DATA storage/worker cases only on their separate synthetic prefixes and exact approved acceptance contract. For restore, use only an approved synthetic snapshot and a distinct clean target.
7. Run LIV-SS-01 and LIV-PC-01 when the approved provider stub can consume/capture them. Evaluate captures in memory; receipts retain request count, equality flag, and digest only.
8. Before close, reconcile only aggregate counts/statuses against this run's baseline. Cleanup exact run-owned resources only through the named owner. Unknown residue, shared token, shared key, unknown version, or unexplained count delta means STOP and leave it for the owner; never broad-delete or reset shared services.

Global STOP conditions: wrong/unverified build; unapproved window; missing isolated namespace; port conflict with unknown owner; app manager would stop unrelated processes; migration would touch shared/non-disposable data; root-only Vault path; A/B capability missing; unapproved migration-window true; nonzero DD-03 candidate counts; provider not capturing required field; secret/value/ID output; cross-tenant success; unexpected audit/count delta; or cleanup target cannot be named exactly.

## Items still blocking ready-to-execute status

These are actionable inputs, not a reason to infer defaults:

1. The current Compose stack is fixed-name/fixed-port and has no ES. Provisioner must identify an isolated target or state that the existing stack is a dedicated exclusive sandbox, then supply a safe startup command and namespace mapping.
2. The app manager can stop existing DU ports and invokes the migration CLI. The window owner must approve the exact .env.live target and confirm occupied ports are owned by the run before scripts/dev-live.ps1 is used.
3. Vault Finding A/B need an approved non-root Transit policy and auth method. Finding C needs required/N/A disposition. Finding D remains outside test cleanup.
4. The credential reader D5 path, provider sessionRef capture, and provider prompt capture each need a live-capable consumer/stub; none can be replaced by a Vault CLI read or offline test.
5. Elasticsearch is not present in the recorded LIV03 stack and its endpoint/version/index are unanswered; DATA-LIVE-04 remains HOLD.
6. G-ENC's previous instruction to keep migration window false conflicts with LIV-EM-01's true compatibility branch. Default to false; do not run the true branch without a separate decision/window.
7. The old plan invokes vault-live.test.ts, while previous prep classifies its cases as root-token smoke. It is not sufficient for non-root role acceptance; use the separately approved role matrix and record this smoke only as component evidence if permitted.

## Offline preparation result

- Reviewed: source docs/scripts and bounded prior receipts only.
- Live service checks: 0.
- Live test cases: 0.
- Queries issued: 0.
- Credentials or env files read: 0.
- Namespace or service provisioned: 0.
- Receipt status: PREPARED / LIVE WINDOW STILL REQUIRED.
- Δ-DEVIATION: NO. The boot/namespace/role/ES findings above are explicit execution blockers discovered while producing the requested safe runbook; they do not change any gate status.
