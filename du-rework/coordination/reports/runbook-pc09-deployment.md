# PC-09 Deployment & Cutover Runbook — Profile Control Plane

| Field | Value |
|---|---|
| Audience | Operations / SRE running the Orchestrator deployment |
| Use when | Shipping the profile control plane (`0070`, `0071`) and converting profile groups to root-grant authority |
| Authority boundary | This runbook **procedures** a change; it does not grant permission to make it. A change ticket naming the tenant cohort, image digest and rollback owner is required before Phase 1 |
| Source of truth | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §PC-09, [`prep-pc09-cutover-spec.md`](prep-pc09-cutover-spec.md) §6, [`receipt-pc05-admission.md`](receipt-pc05-admission.md), [`receipt-pc03-service.md`](receipt-pc03-service.md) |
| Revision | 1.0 — authored from source at the PC-06 acceptance point |

---

## 0. Read this first

### 0.1 What this runbook can and cannot do today

**Can:** apply the additive schema, deploy a resolver-capable Orchestrator, prove a
cohort is conversion-ready, issue and revoke group keys, verify behaviour per
endpoint, and roll back before a cohort writes v2-only configuration.

**Cannot (yet):** there is **no operator entry point for conversion**. The
authorization transition lives in `convertGroupToGrantAuthority`
(`modules/profiles/profile-groups.ts`) and is reachable only from process code —
there is no `/convert` HTTP route, no CLI subcommand and no compose profile for it.
Phase 3 is therefore written as a **readiness drill plus a blocked mutation**, not
as a command you can run tonight. See §5.3 for the exact state and the two
acceptable ways to unblock it.

### 0.2 The one sentence this runbook exists to correct

`docs/12b-deployment-guide.md` says:

> *"For schema upgrades on an existing stack, stop the API and workers first, back
> up Postgres, run `… run --rm migrate`, then recreate the application services. Do
> not allow an older API to serve traffic while changing its schema."*

That rule is correct for **breaking** migrations. `0070` and `0071` are additive:
they add nullable columns, new tables and new indexes, and create no constraint an
older reader can violate. Applying them under a live older reader is safe, and the
phased cutover the plan requires **depends** on it. Follow §4.2 for the narrow,
true rule; do not follow the blanket prohibition, or you will cause the downtime
this plan was written to avoid.

---

## 1. Roles and preconditions

| Role | Owns | Must not |
|---|---|---|
| **Change owner** | ticket, cohort list, image digest, rollback owner | run the conversion (§5.3) |
| **DB operator** | backup, migration, verification SQL | edit migration files or hand-fix the ledger |
| **App operator** | image deploy, service restart, health gates | rotate or revoke keys to "fix" a deploy |
| **Security approver** | key issuance/revocation ticket | delegate the raw secret |
| **On-call** | monitoring during the window | declare success from a green test suite |

Preconditions — all must be true before Phase 1:

1. A PostgreSQL backup that has been **restored once** into a scratch database and
   queried (`SELECT count(*) FROM api_keys` succeeds).
2. The cohort list is written down: `tenant_id`, `group_id`, `group name`, current
   `access_version`, current `auth_authority`.
3. The image digest of the target Orchestrator is recorded **separately** from the
   source commit (§8 evidence).
4. `migrate:status` exits **0** on the current database (a pre-existing ledger
   problem must not be misread as a migration failure).
5. An `Idempotency-Key` scheme is agreed for the key operations in Phase 4
   (`pc09-<cohort>-<yyyymmdd>-<seq>`).

---

## 2. Inventory of what changes

### 2.1 Schema (both additive, forward-only)

| File | Adds | Safe with an older reader? |
|---|---|---|
| `0070_profile_control_plane_storage.sql` | `api_keys.key_mode`; `profile_groups.auth_mode`/`auth_authority`/`access_version`; table `profile_group_api_keys`; nullable `api_key_id` on three tables; `request_defaults`; re-scoped `profile_names_identity`; lookup indexes | Yes — every column is nullable or defaulted, the new table is unused by old code, and the index re-creation keeps its original name so the runner's drift guard stays green |
| `0071_resolution_fingerprint.sql` | `submission_keys.resolution_fingerprint` (nullable, CHECK `^sha256:[0-9a-f]{64}$`) | Yes — old inserts simply leave it NULL |

There is **no down migration**. `0070` recreates `profile_names_identity` under its
original name specifically because `src/db/migrations.ts` treats every object a
recorded migration created as permanently required; dropping the name would fail
the startup schema gate on every subsequent boot.

### 2.2 Behaviour switches (not schema)

| Switch | Where | Default after this change |
|---|---|---|
| Resolver branch | `api_keys.key_mode` | Every key classified `LEGACY_STANDALONE` or `UNMANAGED_LEGACY`; `GROUP_MANAGED` only appears at conversion or group-key issuance |
| Group authority | `profile_groups.auth_authority` | `CHILD_PROJECTION` for every existing group — **nothing converts itself** |
| v2 API surface | `/api/v2/admin/profile-groups/**`, `/api/v2/profile-groups/**`, `/api/internal/admin-workbench/v2/**` | Present but inert until a cohort is converted and a group key is issued |

### 2.3 Error codes you will see, and what each means

| Code | HTTP | Meaning | Operator action |
|---|---|---|---|
| `PROFILE_GROUP_UNAUTHORIZED` | 403 | Key is `GROUP_MANAGED` but holds no ACTIVE grant, or the function is disabled/ambiguous | Check `profile_group_api_keys.state`; do **not** re-create child memberships |
| `PROFILE_CHANGED` | 409 | Fingerprint/refs drifted, or a `GROUP_MANAGED` key reached a `CHILD_PROJECTION` group (the defensive C3 state) | Re-run preview; if authority is wrong, the cohort is mid-cutover — stop and escalate |
| `PROFILE_GROUP_V2_REQUIRED` | 409 | A legacy write (v1 upsert/attach/self-service) hit a converted group | Expected after conversion; use the v2 routes |
| `IDEMPOTENCY_CONFLICT` | 409 | Same `Idempotency-Key`, different body **or** different fingerprint | Do not retry blindly; the first request is authoritative |
| `PRECONDITION_REQUIRED` | 428 | Group-key mutation sent without `If-Match` | Read the group, retry with the current `accessVersion` |
| `VERSION_NOT_ACTIVE` / `BUSINESS_SUBMISSIONS_PAUSED` | 409 | Business/version moved during admission | Retry once; if persistent, the version was switched — reload |

---

## 3. Phase 0 — Freeze and capture

**Window:** ~15 minutes, no user-visible change.

1. Freeze profile/group/key authoring for the cohort (announce; the plan's rollout
   step 1 requires it). Reads stay open.
2. Capture the dry-run inventory as evidence (§9.1). **Do not proceed** if any gate
   in §9.2 fails.
3. Record the baseline: key-mode distribution, authority distribution, key counts
   (§9.1 Q3/Q4).
4. Announce the window in the change ticket with the captured counts.

**Exit gate:** inventory captured and stored; every cohort either listed as
`READY` or excluded with a reason.

---

## 4. Phase 1 — Schema

### 4.1 Apply

```bash
# From the deployment directory (du-rework/), with the deployment env file
docker compose --env-file .env.docker config --quiet          # syntax gate, exit 0
docker compose --env-file .env.docker --profile migration \
  run --rm orchestrator-migrate migrate                       # exit 0
docker compose --env-file .env.docker --profile migration \
  run --rm orchestrator-migrate status                        # exit 0
docker compose --env-file .env.docker --profile migration \
  run --rm orchestrator-migrate verify                        # exit 0
```

`migrate` applies each pending file in its own transaction and writes one checksum
ledger row per file. `verify` re-runs the declared-object drift guard — a missing
object fails here, not at 03:00 the next morning.

Non-compose equivalent (native run):

```bash
node dist/migrate-cli.js migrate && node dist/migrate-cli.js status && node dist/migrate-cli.js verify
```

### 4.2 The bridge window, stated precisely

> An **older** Orchestrator may keep serving while an **additive** migration runs.
> It must not serve across a **breaking** migration. `0070`/`0071` are additive, so
> the bridge is allowed — and required, because the plan deploys readers before any
> writer emits v2 records.

What "additive" buys you, concretely: the old code never selects `key_mode`,
`auth_authority`, `access_version`, `request_defaults` or `resolution_fingerprint`,
never inserts into `profile_group_api_keys`, and only ever writes
`profile_names` rows with `api_key_id` set (which the narrowed
`profile_names_identity` still accepts).

### 4.3 Verify the schema (not just the command exit code)

Run §9.3 V1–V5. Expected: `key_mode` has **no NULL** rows, every group is
`CHILD_PROJECTION` with `access_version = 1`, the grant ledger is empty.

**Exit gate:** `migrate status` and `verify` exit 0, V1–V5 pass, and a single v1
`POST /api/v1/businesses/{businessId}/actions/{action}` on a legacy key still
returns 202.

---

## 5. Phase 2 → 3 — Deploy readers, then convert

### 5.1 Phase 2: deploy the resolver-capable Orchestrator

```bash
docker compose --env-file .env.docker pull orchestrator
docker compose --env-file .env.docker up -d --wait --wait-timeout 180 orchestrator
curl -fsS https://<host>/health            # {"status":"ok","db":true,"redis":true,"activeLeases":N,...}
```

Read the body, not just the status code: `/health` answers **200 even when
degraded** (transport fine, queue integrity `SUSPECT`), because the load balancer
must not drop a node that is actively reconstructing. The gate is
`status == "ok"` **and** `db == true` **and** `redis == true`.

Smoke gates (all must pass, in this order):

1. `/health` body: `status: "ok"`, `db: true`, `redis: true`.
2. v1 submit on a **legacy** key → 202, operation row pinned as before.
3. v1 submit on a **`GROUP_MANAGED`** key of an unconverted group → still 202 (its
   group is `CHILD_PROJECTION`; only the grant path is active for `GROUP_GRANT`).
4. One v1 write (`profile.upsert`) on a `CHILD_PROJECTION` group → succeeds.
5. The same write on a converted group (if any) → `409 PROFILE_GROUP_V2_REQUIRED`.

If (2) or (3) regress, roll back the image per §8 window A. Do not convert anything.

### 5.2 Phase 3: prove a cohort is conversion-ready (read-only)

Run §9.4 P1–P7 for one group. These mirror the seven proofs inside
`convertGroupToGrantAuthority`, in the same order, so a passing set means the
function will not block. Every query is read-only; run them on a replica if one
exists.

| Gate | Must return |
|---|---|
| P1 candidate key | exactly **1** candidate, `ACTIVE`, same tenant |
| P2 child membership | **0 rows** (each child has exactly one ACTIVE membership, and it is the candidate) |
| P3 shared key | **0 rows** |
| P4 foreign author | **0 rows** |
| P5 child ownership | **0 rows** |
| P6 child pointer | **0 rows** |
| P7 in-flight operation | **0 rows** |

A non-empty P7 is not a bug: conversion deliberately refuses while a child has a
live operation. Drain them (wait, or cancel per policy) and re-run.

### 5.3 The conversion mutation — currently blocked

`convertGroupToGrantAuthority(client, groupId, actor, tenantScope?)` is exported
and fully tested, but **no route or CLI calls it**. Verified by repository search:
the only non-test references are its own definition. The v2 admin surface stops at
`/keys` and `/keys/:keyId/revoke`; there is no `/convert`.

Two acceptable ways to unblock, in preference order:

1. **Ship the entry point (recommended).** A reviewed `POST
   /api/v2/admin/profile-groups/:groupId/convert` that locks the root, runs the
   same seven proofs, and returns `{previousAuthority, authority, accessVersion,
   grantedKeyId, revokedChildMemberships}`. Until it exists, conversion is a code
   change, not an operation.
2. **One-off controlled invocation by an engineer with database access**, using the
   service function itself — never a hand-written SQL reimplementation of it. A
   second implementation of an authorization transition is exactly the drift the
   seven proofs exist to prevent.

**Do not** assemble the conversion writes by hand (insert grant → update authority
→ revoke memberships → flip key mode). Each step is individually simple and
collectively unsafe: correct ordering, the `P1` candidate choice, the
`access_version` bump and the membership revocation must all commit together.

### 5.4 Phase 3: after conversion — verify the new shape

Run §9.5 C1–C5. Expected: authority `GROUP_GRANT`; `access_version` incremented by
exactly 1; the candidate key is `GROUP_MANAGED`; its child memberships are
`REVOKED`; exactly one ACTIVE grant exists.

Then per endpoint (`ingest`, `extract`, `analyze`, `transform`, `generate`,
`compare`):

1. **v1 body** (no fingerprint) on the group key → 202, operation pins the child
   profile and revision. The v1 contract is unchanged by design.
2. **v2 preview → submit** on the same action → 200 with `resolutionFingerprint`,
   then 202 with an `Idempotency-Key`; `submission_keys.resolution_fingerprint` is
   populated.
3. **Legacy write firewall**: `profile.upsert` on the converted group → 409
   `PROFILE_GROUP_V2_REQUIRED`.

**Exit gate for the cohort:** 6/6 v1, 6/6 v2, firewall 409, and the C1–C5 shape
checks. Record the `accessVersion` you observed; it is the `If-Match` value for any
key operation in Phase 4.

---

## 6. Phase 4 — Key migration and rotation

### 6.1 Model in one paragraph

A group is authorised by rows in `profile_group_api_keys`, not by child
memberships. `GROUP_MANAGED` means "resolve through the root grant and never fall
back". `LEGACY_STANDALONE` keeps its old membership/self-service behaviour,
including when every membership is revoked. `UNMANAGED_LEGACY` is a key that never
had a profile or group; it stays on the legacy no-profile path. After `0070` every
key carries one of these three values or the row is invalid — a NULL mode is an
authorization error, not a fallback.

### 6.2 Issue a group key

```bash
GROUP=<groupId>; VER=<accessVersion from GET>
curl -fsS -X POST "https://<host>/api/v2/admin/profile-groups/$GROUP/keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "If-Match: $VER" \
  -H "Idempotency-Key: pc09-$GROUP-$(date +%Y%m%d)-1" \
  -d '{"note":"pc09 cutover cohort A"}'
```

Response: `{ grant: { apiKeyId, prefix, status, grantedAt, grantedBy }, secret, secretAvailable }`.
`secret` appears **once** and is never stored; hand it to the client through the
approved channel. The call bumps `access_version`; re-read the group before the
next mutation.

### 6.3 Revoke a grant (key stays ACTIVE)

```bash
curl -fsS -X POST "https://<host>/api/v2/admin/profile-groups/$GROUP/keys/$KEYID/revoke" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -H "If-Match: $VER" -H "Idempotency-Key: pc09-$GROUP-revoke-$KEYID" \
  -d '{"expectedAccessVersion":'"$VER"'}'
```

Effect: that group's access stops immediately; the API key remains valid for any
other authority it holds. This is **not** a key revoke.

### 6.4 Rotate or globally revoke a key

These two live on the internal parity surface, not the v2 group surface, and their
bodies are strict: an unknown field is a 422. Note that `rotate` carries
`idempotencyKey` **in the body**, while `revoke` takes `expectedVersion` only.

```bash
# Rotate: new key id; carries only the same-group grant (or the legacy memberships)
curl -fsS -X POST "https://<host>/api/internal/parity/api-keys/$KEYID/rotate?tenantId=$TENANT" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"expectedVersion":'"$KEYVER"',"idempotencyKey":"pc09-rotate-'"$KEYID"'"}'

# Global revoke: key inactive everywhere AND every active grant tombstoned in one tx
curl -fsS -X POST "https://<host>/api/internal/parity/api-keys/$KEYID/revoke?tenantId=$TENANT" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"expectedVersion":'"$KEYVER"'}'
```

`$KEYVER` is `api_keys.version` from the key row (§9.5 C3), not the group's
`access_version` — the two counters are independent and mixing them yields a 409.

Rotation never adds a function, a profile or a group; it copies the current
authority only. A rotation must not be used to move a key between groups — that is
refused by the grant ledger's one-group-per-key invariant.

### 6.5 Legacy standalone keys during cutover

Do nothing. A `LEGACY_STANDALONE` key on a `CHILD_PROJECTION` group keeps working
through child memberships. It stops working for that group at the moment the group
converts, because conversion revokes those memberships — so **the group's key must
be issued and distributed before conversion, not after** (§5.3 ordering).

---

## 7. Phase 5 — Verification and monitoring

### 7.1 What the database can and cannot tell you

Denials (401/403/409) happen **before** any durable write — that is a design
property, verified by the matrix suite. So:

- `operations` proves that **accepted** traffic is pinned correctly;
- it can never show you a denial count. Denial rate comes from HTTP logs/metrics
  by error code;
- the proof that a denial wrote nothing is a count comparison across a request
  (§9.6), not a gap in a table.

### 7.2 Dashboards / alerts for the cutover window

| Signal | Source | Alert threshold |
|---|---|---|
| `PROFILE_GROUP_UNAUTHORIZED` rate | HTTP logs by `code` | any sustained rise after conversion = grant or membership mistake |
| `PROFILE_CHANGED` rate | HTTP logs | burst right after a config publish is expected; sustained = clients pin to a stale preview |
| `IDEMPOTENCY_CONFLICT` | HTTP logs | any = a client is reusing keys incorrectly; investigate, do not "fix" by disabling idempotency |
| 5xx on `/api/v2/**` | HTTP logs | any |
| `access_version` movement | §9.1 Q4 sampled each minute | unexpected movement outside a ticket |
| New `admin_audit_events` for `profile_group.*` | §9.7 | an event with no matching ticket = stop |

### 7.3 Post-cutover soak (per cohort)

Before converting the next cohort: one full cycle of all six endpoints with zero
`PROFILE_GROUP_UNAUTHORIZED` and zero unexplained `PROFILE_CHANGED`, for an interval
the operator sets and records in the ticket. Do not convert a second cohort inside
another cohort's soak.

---

## 8. Phase 6 — Rollback and disaster recovery

### 8.1 Which window are you in?

| Window | State | Safe action | Forbidden |
|---|---|---|---|
| **A** schema only | `0070/0071` applied, no cohort converted, no v2 config written | Revert the image to the previous tag; the new columns are ignored | — |
| **B** v2 config written, not converted | Groups still `CHILD_PROJECTION`; v2-created revisions exist | Image revert is *technically* safe but the old reader cannot see `request_defaults` → configs silently look empty. Prefer forward-fix | Assuming the old UI shows the v2 config |
| **C** converted | `GROUP_GRANT`, grants exist, memberships revoked | Restore the Phase-0 backup into a replacement instance, **or** forward-fix | Downgrading `auth_authority`, deleting grants, re-creating child memberships |

There is no down migration. A "downgrade" that dropped `0070`'s objects would trip
the same drift guard that protects every startup.

### 8.2 Restore procedure (window C)

1. Stop Orchestrator and workers (they must not write to the target).
2. Restore the Phase-0 backup to a new database.
3. Point the stack at the restored database, run `migrate status` (exit 0), start.
4. Verify with §9.3, then with §9.5 for the cohorts that existed before conversion.
5. Reconcile: every operation admitted after the backup is **lost** unless the
   write-ahead logs were retained. State that explicitly in the incident record.

### 8.3 Emergency key actions (not schema rollback)

| Situation | Action | Effect |
|---|---|---|
| One group must stop accepting traffic | Revoke every grant on it (§6.3) | 403 for that group; the key stays valid elsewhere |
| A key may be compromised | Global revoke (§6.4) | 401 everywhere, grants tombstoned in the same transaction |
| A bad config revision shipped | `POST /api/v2/admin/profile-groups/:groupId/rollback` | Moves the config pointer only; **never** re-activates a revoked grant |

---

## 9. Appendices

> Every SQL block below was executed against a **PostgreSQL 16** database built by
> the real migration chain (`0001…0071`, 68 files) during the authoring of this
> runbook: **exit 0, zero errors**. The zero-UUID placeholders return empty result
> sets instead of failing, so an operator can run the whole appendix end to end and
> then substitute the real ids. Nothing here writes.
### 9.1 Dry-run inventory (Phase 0, read-only)

```sql
-- Set these ONCE per psql session, from the change ticket. The zero UUIDs are
-- placeholders: replace them, or the queries simply return empty results.
-- Values are set WITHOUT quotes: every use below is :'name', which adds them.
\set group_id         00000000-0000-0000-0000-000000000000
\set group_id_1       00000000-0000-0000-0000-000000000000
\set group_id_2       00000000-0000-0000-0000-000000000000
\set candidate_key_id 00000000-0000-0000-0000-000000000000
\set business_id      pc09-core
\set key_id           00000000-0000-0000-0000-000000000000
\set idempotency_key  pc09-evidence-key

-- Q1 key-mode distribution (after 0070: NULL means an unclassified key → STOP)
SELECT coalesce(key_mode,'<NULL>') AS key_mode, count(*) FROM api_keys GROUP BY 1 ORDER BY 1;

-- Q2 group authority distribution (before any conversion: everything CHILD_PROJECTION)
SELECT auth_authority, count(*), min(access_version), max(access_version)
  FROM profile_groups GROUP BY 1 ORDER BY 1;

-- Q3 grant ledger state (before cutover: empty)
SELECT state, count(*) FROM profile_group_api_keys GROUP BY 1 ORDER BY 1;

-- Q4 per-cohort baseline (store the output as evidence)
SELECT g.tenant_id, g.group_id, g.name, g.auth_authority, g.active_revision, g.access_version,
       (SELECT count(*) FROM profile_group_members m
         WHERE m.group_id=g.group_id AND m.group_revision=g.active_revision) AS members,
       (SELECT count(*) FROM profile_group_api_keys k
         WHERE k.group_id=g.group_id AND k.state='ACTIVE') AS active_grants
  FROM profile_groups g
 WHERE g.group_id IN (:'group_id_1', :'group_id_2')
 ORDER BY g.tenant_id, g.group_id;
```

The exhaustive 16-query set (ambiguity, shared keys, tombstone traps, cross-tenant
authors, in-flight operations, name collisions) is in
[`prep-pc02-migrations-spec.md`](prep-pc02-migrations-spec.md) §7 — run all of it at
Phase 0 and attach the output.

### 9.2 Conversion gate summary

| Gate | Query | Pass |
|---|---|---|
| No unclassified key | Q1 | no `<NULL>` row |
| No group silently already converted | Q2 | every cohort row is `CHILD_PROJECTION` |
| Grant ledger empty for the cohort | Q3 (filtered by cohort) | 0 |
| No ambiguous group key | §9.4 P1 | exactly 1 candidate |
| No shared key | P3/P4 | 0 rows |
| No child drift | P2/P5/P6 | 0 rows |
| No in-flight operation | P7 | 0 rows |

### 9.3 Schema verification (Phase 1)

```sql
-- V1 the new columns exist and are nullable/defaulted as designed
SELECT table_name, column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND ((table_name='api_keys' AND column_name='key_mode')
     OR (table_name='profile_groups' AND column_name IN ('auth_mode','auth_authority','access_version'))
     OR (table_name='profile_bindings' AND column_name='request_defaults')
     OR (table_name='submission_keys' AND column_name='resolution_fingerprint'))
 ORDER BY table_name, column_name;

-- V2 the ledger recorded both files
SELECT sequence, filename, checksum_provenance
  FROM schema_migrations WHERE sequence IN (70,71) ORDER BY sequence;

-- V3 no key is unclassified
SELECT count(*) AS unclassified FROM api_keys WHERE key_mode IS NULL;

-- V4 no group changed authority by itself
SELECT count(*) AS converted FROM profile_groups WHERE auth_authority='GROUP_GRANT';

-- V5 the grant ledger is empty
SELECT count(*) AS grants FROM profile_group_api_keys;
```

V3 must be `0`, V4 must be `0`, V5 must be `0` before any conversion.

### 9.4 Conversion readiness P1–P7 (read-only; psql variables)

```sql
-- Uses the psql variables set at the top of §9.1.

-- P1: exactly one ACTIVE tenant key is a member of every child in the active revision
WITH children AS (
  SELECT DISTINCT m.profile_id
    FROM profile_groups g
    JOIN profile_group_members m ON m.group_id=g.group_id AND m.group_revision=g.active_revision
   WHERE g.group_id = :'group_id'
), candidates AS (
  SELECT k.id
    FROM api_keys k
   WHERE k.tenant_id = (SELECT tenant_id FROM profile_groups WHERE group_id = :'group_id')
     AND k.status = 'ACTIVE'
     AND NOT EXISTS (
       SELECT 1 FROM children c
        WHERE NOT EXISTS (
          SELECT 1 FROM profile_api_keys pm
           WHERE pm.profile_id=c.profile_id AND pm.api_key_id=k.id
             AND pm.state='ACTIVE' AND pm.tenant_id=k.tenant_id))
)
SELECT count(*) AS candidate_keys, array_agg(id) AS candidates FROM candidates;

-- P2: every child holds exactly one ACTIVE membership (and it must be the P1 candidate)
WITH children AS (
  SELECT DISTINCT m.profile_id
    FROM profile_groups g
    JOIN profile_group_members m ON m.group_id=g.group_id AND m.group_revision=g.active_revision
   WHERE g.group_id = :'group_id'
)
SELECT c.profile_id, count(pm.api_key_id) AS active_memberships, array_agg(pm.api_key_id) AS keys
  FROM children c
  LEFT JOIN profile_api_keys pm ON pm.profile_id=c.profile_id AND pm.state='ACTIVE'
 GROUP BY c.profile_id
HAVING count(pm.api_key_id) <> 1;

-- P3: the candidate is not ACTIVE on any profile outside this group
--     (substitute the single id returned by P1)
SELECT pm.profile_id
  FROM profile_api_keys pm
  LEFT JOIN profile_names n ON n.profile_id=pm.profile_id
 WHERE pm.api_key_id = :'candidate_key_id'
   AND pm.state='ACTIVE'
   AND (n.group_id IS NULL OR n.group_id <>  :'group_id');

-- P4: the candidate authored no other group's revision
SELECT group_id FROM profile_group_revisions
 WHERE api_key_id = :'candidate_key_id' AND group_id <> :'group_id';

-- P5: every member's registry row is owned by the group
SELECT m.profile_id, n.group_id
  FROM profile_groups g
  JOIN profile_group_members m ON m.group_id=g.group_id AND m.group_revision=g.active_revision
  LEFT JOIN profile_names n ON n.profile_id=m.profile_id
 WHERE g.group_id = :'group_id'
   AND n.group_id IS DISTINCT FROM :'group_id';

-- P6: every child pointer equals its pinned revision
SELECT m.profile_id, m.binding_revision, a.revision AS active_revision
  FROM profile_groups g
  JOIN profile_group_members m ON m.group_id=g.group_id AND m.group_revision=g.active_revision
  LEFT JOIN profile_active_revisions a ON a.profile_id=m.profile_id
 WHERE g.group_id = :'group_id'
   AND a.revision IS DISTINCT FROM m.binding_revision;

-- P7: no non-terminal operation is attached to a child
SELECT o.id, o.state, o.created_at
  FROM operations o
 WHERE o.deleted_at IS NULL
   AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','EXPIRED')
   AND o.profile_id IN (
     SELECT m.profile_id
       FROM profile_groups g
       JOIN profile_group_members m ON m.group_id=g.group_id AND m.group_revision=g.active_revision
      WHERE g.group_id = :'group_id');
```

### 9.5 Post-conversion verification (Phase 3)

```sql
-- Uses the psql variables set at the top of §9.1.

-- C1 authority flipped and the version moved
SELECT group_id, auth_authority, access_version, active_revision
  FROM profile_groups WHERE group_id = :'group_id';      -- GROUP_GRANT, previous+1

-- C2 exactly one ACTIVE grant, pointing at the converted key
SELECT api_key_id, state, granted_at, granted_by
  FROM profile_group_api_keys WHERE group_id = :'group_id' ORDER BY granted_at;

-- C3 the key is group-managed
SELECT id, key_mode, status FROM api_keys
 WHERE id IN (SELECT api_key_id FROM profile_group_api_keys WHERE group_id = :'group_id');

-- C4 the old child memberships are revoked tombstones
SELECT profile_id, state, revoked_at
  FROM profile_api_keys
 WHERE profile_id IN (
   SELECT profile_id FROM profile_group_members
    WHERE group_id = :'group_id' AND group_revision = (SELECT active_revision FROM profile_groups WHERE group_id= :'group_id'))
 ORDER BY profile_id;

-- C5 the operations admitted after conversion pinned the child, not the group
SELECT action, api_key_id, profile_id, profile_revision, count(*)
  FROM operations
 WHERE business_id = :'business_id' AND created_at > now() - interval '30 minutes'
 GROUP BY 1,2,3,4 ORDER BY 1;
```

### 9.6 Denial-leaves-no-row proof (per endpoint, per cohort)

```sql
-- before the denied request
SELECT count(*) AS ops_before FROM operations WHERE api_key_id = :'key_id';

-- (issue the request that must be denied: e.g. v2 submit with a stale fingerprint)

-- after: the count must be identical, and the idempotency scope untouched
SELECT count(*) AS ops_after FROM operations WHERE api_key_id = :'key_id';
SELECT count(*) AS markers FROM submission_keys
 WHERE api_key_id = :'key_id' AND key = :'idempotency_key';
```

### 9.7 Audit trail

```sql
SELECT created_at, actor, actor_role, action, resource, severity
  FROM admin_audit_events
 WHERE created_at > now() - interval '24 hours'
   AND action LIKE 'profile_group.%'
 ORDER BY created_at DESC;
```

Expected actions: `profile_group.create|replace|rollback`,
`profile_group.grant.issue`, `profile_group.grant.revoke`. Every row must have a
ticket behind it. Group-key grants record `granted_by`/`revoked_by` on the ledger row
as well, so the two views must agree.

### 9.8 Evidence assembly

| Level | Artefact | Must not be substituted for |
|---|---|---|
| Source | commit sha, `migrate status/verify` output, suite tallies | image |
| Image | registry digest, build log, bundled migration count | source |
| Running | `/health`, `schema_migrations` rows 70/71, C1–C5 output, one v1 + one v2 request per endpoint | image |

The plan is explicit: a green suite is not an image, and an image is not a running
container.

---

## 10. Known gaps and open risks

| # | Gap | Impact | Mitigation |
|---|---|---|---|
| 1 | **No conversion entry point** (no `/convert` route or CLI) | Phase 3 mutation cannot be executed by operations at all | §5.3 — ship the route or run a controlled service-function invocation; never hand-write the writes |
| 2 | `12b-deployment-guide.md` still forbids live-reader migration in general terms | An operator following the stale rule stops the stack unnecessarily, or worse, treats a *breaking* migration as safe after reading this narrow exception | Replace that sentence with §4.2's wording **in the same release** as this runbook |
| 3 | `0070`/`0071` have no down migration | A mistaken conversion cannot be undone by schema | §8: backup, or forward-fix; conversion is one-way per group by design |
| 4 | Denials are invisible in the database | DB-only monitoring reports "all good" while every request 403s | §7.1: monitor HTTP error codes; the DB proves absence, not frequency |
| 5 | Group upgrade ordering | If conversion runs before the replacement key is distributed, the group stops accepting traffic | §6.5: issue and distribute the key first, convert second |
| 6 | `submission_keys.resolution_fingerprint` is nullable | A v1-era row can never match a v2 fingerprint | Expected; a NULL is never treated as a match |

---

## 11. One-page checklist

```
[ ] Change ticket: cohort ids, image digest, rollback owner
[ ] Backup taken AND restored once into a scratch database
[ ] migrate:status exit 0 before any change
[ ] Phase 0: §9.1 Q1-Q4 captured; every gate in §9.2 green
[ ] Phase 1: migrate/status/verify exit 0; §9.3 V1-V5 pass
[ ] Phase 1: one v1 submit on a legacy key still 202
[ ] Phase 2: image deployed; /health green; v1 submit OK on legacy AND grouped-unconverted keys
[ ] Phase 3: §9.4 P1-P7 green for ONE group
[ ] Phase 3: replacement group key issued and distributed BEFORE conversion
[ ] Phase 3: conversion executed through the service function (never hand-written SQL)
[ ] Phase 3: §9.5 C1-C5 pass; 6/6 endpoints v1 + 6/6 v2; firewall 409
[ ] Phase 4: key operations recorded with Idempotency-Key + If-Match
[ ] Phase 5: error-code dashboards watched; audit events match the ticket
[ ] Soak interval recorded; next cohort only after it passes
[ ] Evidence: source, image and running-container artefacts stored separately
```
