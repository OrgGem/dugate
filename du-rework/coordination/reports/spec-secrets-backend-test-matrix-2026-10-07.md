# SC-01 next phase — backend acceptance matrix and mock contract

Date: 2026-10-07. Owner: codex_arch (ARCHITECT & SPEC SPECIALIST).
Scope: du-rework only. Status: **SPECIFIED / DESIGN REVIEW PENDING**.
Implementation, independent verification and live acceptance: **NOT_RUN**.
No product code, migrations, public schemas, executable tests or global plan statuses changed. No commit or push.

## 1. Authority, scope and decision mapping

This supplements [the next-phase design](spec-secrets-backend-next-phase-2026-10-06.md), especially sections 3–10, and [Claude Reviewer section 13.6](claude-audit-review-r4-2026-10-06.md). The reviewer received the design but did not approve it; SC-01 stays OPEN and REVIEW-07 is unchanged.

The original section 10 lists seven lettered questions: its last question combines isolation policies and configured-vs-available. The reviewer enumerates these separately. This matrix therefore has **eight decisions**, without silently adding an approved design decision.

| ID | Review decision | Acceptance gate | Proposed implementation / independent evidence owner |
|---|---|---|---|
| D1 | Immutable generation CAS=0 + PG revision fence | One reserved generation, version 1 only; exactly one fenced catalog publication | Vault adapter + PG repository / concurrency tester |
| D2 | Uncertain response publish/reconcile | Metadata-only recovery cannot misattribute writes or resurrect cancelled mutations | Reconciler / crash-recovery tester |
| D3 | Mandatory idempotency, request MAC, replay horizon | No duplicate mutation, no secret fingerprint leak, explicit expiry/key-loss handling | Mutation repository + MAC adapter / security tester |
| D4 | Enable/revoke/update/purge are separate contracts | Current API cannot implicitly enable, revoke, edit external material or purge | Upstream routes / API contract tester |
| D5 | Plaintext cache off, authority checked every use | Revoked/stale/cross-boundary requests never gain access through cache or old pins | Resolver composition / runtime tester |
| D6 | Generation retention and provider-side revocation | No premature destruction; KV destruction is never represented as provider revoke | Maintenance / retention and provider tester |
| D7 | Catalog isolation and distinct machine identities | Tenant/service/purpose/consumer fencing and least-privilege capabilities hold | Auth + deployment policies / security reviewer |
| D8 | Configured differs from available; safe read projection | Material never returns through management reads, errors, logs, queues or browser | Projector + BFF/Portal / leak scanner and UI tester |

These owners identify boundaries, not actual dispatches or leases. Coordinator assigns non-overlapping packets after design review. Test IDs below are stable acceptance identifiers; each is **NOT_RUN** until evidence names an actual implementation candidate.

## 2. Shared fixture, oracle and evidence rules

Use synthetic tenants T1/T2, actors A1/A2, consumer C1/C2, catalog revision r=7, lease epochs e=10/11, generations G0/G1/G2, and deterministic time t0. No production credentials. Fixtures include a managed entry, an externally owned pinned link and an explicit latest link. Configure approved origin/mount/prefix centrally, not from submitted values.

Offline scheduler has named barriers: `prepared.commit`, `vault.sent`, `vault.persisted`, `vault.response`, `publish.beforePredicate`, `publish.commit`, `http.response`, `resolve.authority`, `resolve.read`, `gc.destroy`. Delay/release events explicitly; never use wall-clock sleeps to infer concurrency. Test every table row against real implementation adapters once available, not a mock that implements both action and expected answer.

Mandatory oracle fields: catalog revision/state/active generation; mutation state/epoch/result; generation ownership/lifecycle/version; audit/outbox count; normalized calls with action/principal/tenant/path-token/version/CAS; consumer dispatch count; safe HTTP DTO/status. Persistent journal/trace assertions must not include values, raw request bodies, MACs, authorization tokens or raw Vault errors. Fixture material exists only in ephemeral test memory and authorized fake Vault storage/receiver; call recorders redact it at capture time.

Required evidence layers:

- **C**: canonical schema/projection/pure contract checks (packages/contracts); cannot establish repository/Vault semantics.
- **O**: actual Orchestrator service/adapters with deterministic fake stores, clocks, barriers and spies.
- **L**: isolated real PostgreSQL + exact deployed Vault version/edition, durable non-dev storage, real machine policies, restart/fault injection and applied migration state.
- **U**: Portal/browser DOM/network/storage evidence on the named candidate.

Each row specifies its minimum layers. O/C passing does not replace L/U. Record raw commands, cwd, runtime/Vault/PG versions, source/image digests, namespace, fixture/config/policy digests, passed/failed/skipped, process exit, functional verdict and sanitized event timeline. Destructive tests use disposable tenant paths and backups with a separate authorized maintenance/tester identity. No live runs occur in this packet.

## 3. Detailed acceptance matrix

### D1 — CAS=0 collision recovery and PG revision fence

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D1-01 O,L | Reserve G1, managed create/rotate, empty key; capture write | Server-owned immutable path; `options.cas=0`; mount `cas_required=true`; successful version exactly 1; published pin=1. No name/user-supplied path or same-path overwrite. |
| SC01-D1-02 O,L | Same mutation retries after response loss; reserved G1 already has healthy version 1 | CAS refusal does not overwrite or create version 2. Recover only under D2 ownership checks; at most one publication/revision increment/result/outbox event. Do not classify all Vault errors as CAS collisions. |
| SC01-D1-03 O,L | Key pre-exists without trusted reservation/ownership evidence, or metadata version >1/deleted/destroyed | Integrity conflict; no active-pointer change, no data GET by writer/reconciler, no overwrite, undelete or latest fallback. Random-path collision is not proof of this mutation's successful write. |
| SC01-D1-04 O,L | Two distinct rotate requests with expectedRevision=7, independent sessions | One reservation wins; other gets revision conflict or typed in-progress. Publish revision 8 once; loser produces no active material. If a loser write was already sent, track it as orphan. |
| SC01-D1-05 O,L | Pause publication, then disable/revoke/cancel or replace epoch with 11 | Predicate covers tenant, expected revision, allowed state, mutation ID and epoch. Old publisher affects zero rows; cannot reactivate secret. Candidate becomes recoverable orphan, not active. |
| SC01-D1-06 O,L | Fail PG transaction between catalog update and event/result write | All publication effects roll back atomically. Replay after recovery installs generation and result once. Vault call never holds an open PG transaction. |

### D2 — uncertain-response publication and reconciliation

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D2-01 O,L | Crash before PREPARED commit | No Vault write; no public configured result. Same request can reserve once on retry. |
| SC01-D2-02 O,L | PREPARED committed; crash before send loses transient literal | Recovery records AWAITING_RESUBMIT. No durable plaintext, fabricated payload or autonomous material write. Same-key/same-body client resubmission can resume under authority/fence. |
| SC01-D2-03 O,L | Vault commits G1; drop response | Record WRITE_UNCERTAIN; metadata-only reconcile confirms owned G1/version 1/healthy flags; publish only if PG fence still matches. No data read or second generation. |
| SC01-D2-04 O,L | Request still in flight; metadata initially returns not-found; release late write | One not-found observation does not settle failure. Keep journal, retry same G1 with CAS=0 only with transient resubmitted value, reconcile eventual success once. Bounded retries/backoff, no busy loop. |
| SC01-D2-05 O,L | Vault commit then PG unavailable; later PG restarts | No success response before durable publication; old rotation pointer remains active. Reconcile once after PG recovery; no duplicate generation/revision/outbox event. |
| SC01-D2-06 O,L | PG publishes; response lost; same request replay | Safe committed result replay; no writer call and no revision increment. Reauthorize caller; response is historical mutation result, not a claim that old ACTIVE state is current. |
| SC01-D2-07 O,L | Cancel wins; orphan scan sees no key; late write then appears | No resurrection. Subsequent sweep finds the late material; journal/path is not reused or prematurely discarded; destruction waits for D6 quiescence. |
| SC01-D2-08 O,L | Metadata denied/malformed/oversized or version 1 provenance untrusted | No publish; sanitized typed failure/pending quarantine as classified. Writer/reconciler data-read count zero; old active pin unchanged. |

Ownership prerequisite: same durable reservation/mutation/generation/tenant/backend-binding and trusted exclusive writer policy. KV metadata alone does not prove who wrote a value. A successful version=1 response or metadata recovery relies on that trust boundary; evidence of outside writes quarantines the path. Vault root/operator bypass is not solved by CAS.

### D3 — idempotency MAC and horizon

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D3-01 C,O | Missing/invalid idempotency key on create or rotate | Reject before reservation/Vault write. Proposed required-key HTTP/error delta must be frozen before API coding; it is not already in current DTO. |
| SC01-D3-02 O,L | Concurrent same scope/key/canonical body; different JSON key ordering | One mutation/generation; matching versioned keyed MAC, no raw-value/unkeyed-secret hash stored. Pending retries observe same mutation; committed retries return safe result. |
| SC01-D3-03 O,L | Same scope/key, change literal or provider/purpose/permissions/expectedRevision | Conflict before any additional write. Error does not echo either body, MAC or raw key. Canonicalization includes every semantically relevant write field. |
| SC01-D3-04 O,L | Same key, different tenant/actor authority/action/target | Explicit scope separation; no cross-tenant result disclosure or permission inheritance. Authorization is rechecked for replay after actor rights are removed. |
| SC01-D3-05 O,L | MAC key rotates; old key available, then unavailable | Verify using recorded key version. Missing verification key fails closed with proposed replay-unverifiable error; no duplicate mutation. Dedicated MAC key is not a Vault token/encryption key. |
| SC01-D3-06 O,L | Boundary t0+24h-epsilon, t0+24h, t0+24h+epsilon; process clock skew | Proposed horizon uses stored DB reservation time: inside replays; at/after expiry rejects new request execution explicitly. Recovery of already-sent writes continues through D2/D6; expiry never means abandon orphan tracking. |
| SC01-D3-07 O,L | Expired key/tombstone; attempt key reuse after retention; backup/restore | Never silently reexecute an indistinguishable expired key. Preserve digest tombstone or use an approved age-verifiable key/epoch scheme. Horizon is not journal deletion TTL. Restore retains MAC key versions needed to verify retained mutations. |

Freeze before implementation: canonical request serialization, scope encoding, authority identifier, hash/MAC algorithms/domain separation, key rotation storage, mandatory-key wire, exact errors, horizon origin and tombstone policy. 24h is a proposal, not acceptance of a configured value. Test configured horizon H using the same boundary cases. MAC comparisons should use timing-safe comparison of fixed-size decoded MACs; malformed lengths fail closed. Public response/audit never exposes MAC/digest.

### D4 — separate lifecycle contracts

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D4-01 C,O | Current create/rotate/disable/probe DTOs with enable/revoke/purge/update fields | Strict validation rejects unknown operations/fields before storage work; do not add endpoints implicitly in the backend implementation. |
| SC01-D4-02 O,L | Rotate DISABLED/REVOKED; replay previous successful rotate | No implicit enable; fresh rotate refused by state. Replayed safe historical result does not change current state/revision or grant use. |
| SC01-D4-03 O,L | Literal rotate on external vault_reference | Typed unsupported operation, zero external writes/deletes/destroy calls. Locator changes await separately reviewed schema. |
| SC01-D4-04 C,O,L | Consumer clears secret selection or catalog disable | Consumer binding clear is not catalog destroy/revoke; disable retains material. Another legitimate consumer's binding is not deleted. |
| SC01-D4-05 O,L | Restore tombstoned/revoked metadata; name/path reuse request | Stable identity and deny state persist. No recreation/undelete bypass. Enable/revoke/purge behavior itself needs separate authorized API acceptance if introduced. |

### D5 — cache-off authority checks

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D5-01 O,L | Repeated allowed use from two instances | Every use checks authoritative DB row and binding; plaintext cache TTL=0. No cached-value shortcut; managed reads use active G/version 1. |
| SC01-D5-02 O,L | Instance A resolves, instance B disables/revokes; delay invalidation event | Next use whose authority check starts after committed deny is rejected with zero material read/consumer dispatch. Outbox delivery is not the authority oracle. |
| SC01-D5-03 O,L | PG outage after prior success; Vault outage after authority pass | Deny use, no stale-cache/DB literal/latest fallback and no dispatch. Distinguish inaccessible DB from absence without leaking secrets. |
| SC01-D5-04 O,L | Rotate current generation; retry carries old policy snapshot with same secretId | Default use follows current authorized generation, while request policy remains pinned. A policy snapshot grants no right to bypass revoked state. Historical generation pins require a separate reviewed feature. |
| SC01-D5-05 O,L | Alter tenant, purpose (including generic), service, binding/revision on stale reference | Authoritative mismatch denies before Vault. Caller-provided metadata cannot widen rights; generic is not a wildcard. |
| SC01-D5-06 O,L | Pinned external version removed; external latest rotates without catalog revision change | Pinned lookup fails without latest fallback. Explicit latest resolves fresh at use, never cached by catalog revision; effective version recorded internally without material. |
| SC01-D5-07 O,L | Disable races an already-authorized in-flight use | Capture exact ordering. Proposed authority linearization is the successful DB check: an earlier authorized use may finish; every later check must deny. Do not claim immediate recall of issued credentials. Stronger pre-dispatch recheck requires an explicitly reviewed protocol. |

### D6 — retention and provider-revoke

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D6-01 O,L | Sweep current published/referenced or legally retained generation | Zero destroy calls regardless of age. Check authoritative dependencies, not the max-64 public usage subset. |
| SC01-D6-02 O,L | Orphan age around minimum 24h and outstanding send/reconcile lease | Below minimum or not quiescent: keep. Eligible only after configured retention, request timeout/lease and late-write reconciliation safety window. Age alone cannot authorize destruction. |
| SC01-D6-03 O,L | Destroy succeeds but response lost; restart maintenance worker | Durable DESTROY_PENDING; metadata confirms destroyed before DESTROYED. Idempotent retry, no data read/undelete/reuse. Soft-deleted is not destroyed. |
| SC01-D6-04 O,L | GC given external link/user path; writer/projector requests destroy | Zero external destruction. Maintenance identity is distinct; incorrect identities denied by actual ACL. |
| SC01-D6-05 O,L | Disable/revoke/destroy material after a provider accepted credential | Local resolve denied but already-issued/provider credential can remain valid. Report provider revoke NOT_DONE until provider-side evidence independently confirms it; no automatic equivalence with KV destruction. |
| SC01-D6-06 L | Restore PG/Vault snapshots at differing points; managed auto-delete setting drift | Mismatched/missing pinned generation fails closed, never latest. Validate approved retention/mount config and retained journals; backup confidentiality/retention separately enforced. |

Published retention and provider revoke ownership remain reviewer/security-policy decisions. Until approved, no automatic old-published-generation destruction. GC must use a transactional eligibility fence and a monotonic DESTROY_PENDING transition so a new dependency cannot attach after eligibility; consumer binding writers must reject retiring generations. Prove both interleavings live before enabling destructive maintenance. Outstanding Vault requests are not fenced by PG epoch; retain tracking through a reviewed upper bound or quarantine if quiescence cannot be proved.

### D7 — isolation and machine identity

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D7-01 C,O,L | Cross-tenant secret ID, mutation ID, name, generation or replay key lookup | Non-disclosing denied/not-found; zero Vault calls. Composite FKs/scoped SQL reject cross-tenant joins even under platform admin without explicit authorized tenant. |
| SC01-D7-02 O,L | List/metadata permission without use; use without correct service/purpose/binding | Listing never grants use. Correct actor/tenant alone insufficient; deny all missing axes before material access. |
| SC01-D7-03 L | Actual writer, reconciler, projector, runtime reader, maintenance identities | Writer writes CAS=0 but cannot GET data; reconciler metadata-only; projector cannot GET data; reader cannot mutate; maintenance cannot expand outside assigned managed paths. Record positive and negative capabilities. |
| SC01-D7-04 C,O,L | Link arbitrary origin/redirect/namespace/mount/traversal or disallowed prefix | Registry and scope reject before outbound access; redirects not followed. Namespace/edition capability verified for exact deployment; no user token/URL routing. |
| SC01-D7-05 O,L,U | Unauthenticated/unauthorized BFF or upstream mutation; missing CSRF; token renewal failure | Auth/CSRF deny without mutation/material calls. Upstream independently authenticates; browser never gets Vault token. Runtime auth renewal fails closed, no root-token fallback. |
| SC01-D7-06 O,L | Concurrent usage-reference insertion/removal and disable | Authoritative consumer write and usage binding are transactional; stale bounded read usage cannot authorize resolve/purge. Restart proves bindings/deny state durable. |

### D8 — configured vs available, no-readback

| Test ID / layers | Setup and stimulus | Required outcome / negative assertions |
|---|---|---|
| SC01-D8-01 C,O | Inject material/token/envelope/unknown fields at every nested persistence/provider/error level | Actual projector creates allowlisted DTO; canonical strict read/list parsing succeeds for safe output or fails closed. No spread/raw-relay fallback; response byte scan clean. |
| SC01-D8-02 C,O,L | Published configured entry; Vault down; DISABLED/REVOKED; PREPARED create | Published/linked configured state does not become false due to outage/disable. Pending managed create is not public success/configured. Configured never asserts usable; resolver enforces state/backend authority. |
| SC01-D8-03 O,L,U | Create/rotate rejection, Vault malicious error, probe success/failure, replay | Response/log/APM/audit/queue/artifact/browser storage scans exclude material and encoded variants; errors fixed/bounded, pointer-only validation. Probe gives value-free storage reachability, not provider-auth certification. |
| SC01-D8-04 C,O,L | 65+ usage references; name/metadata deliberately resembles a secret | Deterministic bounded usage output <=64; destructive decisions use full dependencies. Threat test distinguishes accidental value propagation from intentionally submitted labels; no claim that allowlisted user labels cannot contain secrets. |
| SC01-D8-05 O,L,U | Canary raw/JSON-escaped/base64/URL-encoded variants and scanner positive-control injection | Approved transient material channels excluded precisely; all other artifacts scanned. Injected forbidden canary is detected; clean scan without positive control is insufficient proof. |
| SC01-D8-06 C,O,L | Literal lengths at write/runtime limits incl UTF-8 multibyte | Freeze unified size semantics; accepted value must be resolvable. Existing 64KiB write vs 8192-character resolver mismatch must be resolved before acceptance, not silently truncated. |
| SC01-D8-07 L,U | Restart/redeploy, logical PG dump, Vault backup, Portal refresh | No literal hydration/storage in Portal or PG metadata/journal/outbox. Real authorized runtime still resolves after durable restart. Vault backup is secret-bearing protected storage, not expected to be a plaintext-free metadata artifact. |

For live canary scans, disable production-style body capture and inspect actual collectors/audit configuration. Audit masking alone is not proof. A separate tester identity may read material for positive control; it must not grant writer data-read capability.

## 4. Read-only mock contract / test specification structure

This report is the requested **spec equivalent** for a future `packages/contracts/tests/secret-catalog-backend-matrix.test.ts`. No passing mock test is introduced to imply the unimplemented backend works. Keep dependencies directional: contracts tests cannot import Orchestrator implementation or depend on PG/Vault; executable O/L tests belong to their service/integration suites.

Proposed layout after the implementation/test packet gets its lease:

```text
packages/contracts/tests/secret-catalog-backend-matrix.test.ts
  existing schemas, safe response fixtures, strict nested projection, matrix IDs
  no network, no DB, no runtime backend implementation imports
services/orchestrator/tests/secret-catalog-backend-matrix.test.ts
  actual service/repository/adapter + deterministic fake ports + barriers
services/orchestrator/tests/secret-catalog-reconcile-matrix.test.ts
  crash windows, late write, fencing, idempotency
tests/integration/secret-catalog-backend-live.spec.ts       # proposed path
  real PG/Vault, independent namespaces, policy/restore/GC evidence
tests/browser/admin-web/secret-catalog-no-readback.spec.ts # proposed path
  real candidate Portal, safe route capabilities, DOM/network/storage scans
```

Read-only means the specification and observation view have no backend side effects. Future O tests may mutate isolated in-memory fake state to exercise real orchestration. C tests must not pretend to execute PG transactions or Vault writes. Future live tests are separately authorized disposable-resource tests, not read-only tests.

Proposed harness-only types (not a frozen production API):

```ts
type DecisionId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8';
type EvidenceLayer = 'C' | 'O' | 'L' | 'U';
type TestId = `SC01-${DecisionId}-${string}`;
type Barrier = 'prepared.commit' | 'vault.sent' | 'vault.persisted'
  | 'vault.response' | 'publish.beforePredicate' | 'publish.commit'
  | 'http.response' | 'resolve.authority' | 'resolve.read' | 'gc.destroy';

interface SanitizedCall {
  readonly operation: 'reserve' | 'publish' | 'authorityCheck' | 'vaultWrite'
    | 'vaultMetadata' | 'vaultData' | 'destroy' | 'dispatch' | 'event';
  readonly principal: 'writer' | 'reconciler' | 'projector' | 'reader' | 'maintenance';
  readonly tenantAlias: 'T1' | 'T2';
  readonly generationAlias?: 'G0' | 'G1' | 'G2';
  readonly cas?: 0;
  readonly version?: number;
  // Never body, value, token, raw locator, MAC or upstream exception.
}
interface Observation {
  readonly revision: number;
  readonly state: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  readonly activeGeneration: string | null;
  readonly mutationState: string; // freeze internal lifecycle with repository packet
  readonly outboxCount: number;
  readonly calls: readonly SanitizedCall[];
  readonly safeResponse: unknown; // validate canonical schema before recording
}
interface InspectionPort {
  snapshot(): Readonly<Observation>; // deep-frozen detached view, no fake state access
}
interface MatrixCase {
  readonly id: TestId;
  readonly decision: DecisionId;
  readonly layers: readonly EvidenceLayer[];
  readonly initialFixture: string;
  readonly interleaving: readonly string[];
  readonly expected: readonly string[];
  readonly forbiddenCalls: readonly SanitizedCall['operation'][];
}
```

The future runner should `describe.each(cases)`/`it(case.id)` and drive an injected **real SUT adapter**, then assert `InspectionPort.snapshot()` against an independently specified oracle. Reject missing SUT; do not return canned successful outcomes. Fake Vault storage models key-exists/CAS/version/deletion independently of publication logic; PG fake enforces predicates and atomic rollback, and throws on unmatched SQL. Mock CAS failures are semantic outcomes; the live adapter classifies exact deployed HTTP responses, not an assumed 412.

Snapshot is deep-frozen and detached. Test A cannot mutate Test B or seed a result by editing the observation. Reset deterministic clock/randomness/store per test; sequences use seeded generation IDs without weakening production randomness. Redact calls before serialization, not just at receipt export. Leak scanner positive control stays a synthetic fixture and emits only the detection verdict.

Suggested C-suite contract assertions: valid managed/link DTOs; write values rejected from reads at top/nested levels; list entry validation; usage bound; accepted states/services/purposes; explicit latest/pinned modes; no new public pending state; invalid read rejection without returning Zod input/body. Existing contracts are the oracle for current wires; mandatory-key and new error semantics require separate approved deltas.

Before green: for each O group demonstrate a deliberate isolated mutation makes a behavioral assertion fail (remove CAS, omit publication predicate, promote metadata 404 to failure, bypass MAC comparison, allow rotate to enable, return stale cache, GC active generation, broaden generic purpose, spread raw row). This is test-sensitivity evidence, not a substitute for live proof. Never mutate the shared working tree for failing-first evidence.

## 5. Contract decisions still needing reviewer answers

| Topic | Proposed criterion | Required approval before implementation |
|---|---|---|
| Trusted collision ownership | Only reserved immutable path + exclusive writer evidence can support metadata-only publication | Approve trust assumptions/quarantine behavior; cannot prove value identity from metadata alone |
| Pending HTTP wire | Typed 503 + Retry-After/correlation ID; no unreviewed 202/status endpoint | Freeze names/bodies/rate limits and retry semantics in canonical contracts/OpenAPI |
| Replay horizon | H=24h from durable reservation; at H expired for new client execution, not for recovery | Approve anchor, clock, pending behavior, tombstone retention/age-verifiable key strategy |
| Runtime revoke guarantee | DB authority-check linearization, cache TTL=0; prior in-flight use may finish | Approve exact promise; distinguish local denial from provider-side revocation |
| Destructive retention | Orphan minimum 24h plus proven quiescence; published retention unset until reviewed | Approve outstanding-request bound, dependency fence, GC ACL and provider-revoke owner |
| Size limits | Accepted write always fits runtime; reject rather than truncate | Reconcile current bytes/chars limits and adapter bounds, include PEM/multibyte cases |
| New lifecycle operations | Enable/revoke/link-update/purge remain separate packets | No route/schema extension under existing create/rotate scope |
| Configured status | Configuration durability independent of current availability | Freeze any capability/health DTO separately; no schema overloading |

No invented final error codes are imposed by this document. Use existing HTTP conventions for current behavior; proposed expired-key/replay-unverifiable/in-progress/integrity errors require reviewed wire contracts. Unknown Vault transport result is not a successful mutation; unknown material ownership is not safe to publish.

## 6. Completion table and handoff

| Deliverable | State | Evidence |
|---|---|---|
| Eight-decision mapping and concrete test matrix | SPECIFIED | This document, 52 named cases |
| Read-only mock contract and future suite layering | SPECIFIED | Section 4; no executable mock/SUT added |
| Reviewer design verdict | PENDING | Section 5 answers owed; original section 13.6 is receipt only |
| Backend implementation and C/O checks | NOT_RUN | Future leased owners and tester |
| Real PG/Vault policy/crash/restore/leak proof | NOT_RUN | Independent L packets |
| Portal no-readback and production composition | NOT_RUN | U + runtime consumer packets |
| SC-01 closure / REVIEW-07 change | OPEN / UNCHANGED | No acceptance claim from this spec |

Coordinator should request eight explicit APPROVED/CHANGES_REQUIRED decisions and then lease implementation modules separately from independent tests. Each receipt maps these IDs to an exact candidate; rejected/skipped cases remain open. A contracts-only mock run cannot close SC-01.

## 7. Source checks and external references

Read-only inspection: original design sections 3–10, reviewer section 13.6, canonical `packages/contracts/src/secret-catalog.ts`, and existing runtime design. Only this report was added; no backend tests/build/live actions were run for this spec. Structural document checks do not establish functional PASS.

Vault semantics checked against official documentation on 2026-10-07: [KV2 API](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2) documents CAS, versioned reads and deletion/destruction; [Vault audit devices](https://developer.hashicorp.com/vault/docs/audit) covers audit handling. These API primitives do not establish PG/Vault atomicity or write ownership. Verify exact deployed version behavior live; do not hardcode a mock HTTP status as the production CAS contract.

Document validation: Python read-only structural check from `D:/Git/dugate` on 2026-10-07: exit 0; 52 unique case IDs across D1?D8 (6/8/7/5/7/6/6/7), balanced code fences and local source links resolve. This is document validation only, not 52 executed tests.
