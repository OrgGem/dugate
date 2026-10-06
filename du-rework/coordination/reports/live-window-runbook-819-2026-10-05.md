# LIVE-WINDOW-RUNBOOK-819 - receipt (runbook for the maintenance-window + real-Vault groups)

> **RESUME POINT (qwen_5, 2026-10-05)** - task LIVE-WINDOW-RUNBOOK-819 (task_c6fffb25e8f7),
> dispatch ctx_d953693b3237. **DOC-ONLY: nothing was executed.** No test run, no container, no DB, no Vault,
> no source edit, no commit, no tick. This file is a procedure, not a result.

---

## 0. The one structural decision: Vault is its OWN group

**On this project the real key provider IS Vault.** That single fact forces the split, because:

- Vault has its own namespace, mount, path prefix, policy and token lifecycle, independent of PostgreSQL.
- A Vault failure and a DB failure look different and abort differently.
- A window can be opened for PostgreSQL **without** Vault, and vice versa - lumping them makes both
  unschedulable.

So: **a test that runs "offline" but still calls a real Vault does NOT belong to the offline group.** It
belongs to the Vault group and needs its own prerequisites. Grouping it with offline tests is exactly the
mistake that makes a suite look green while never having touched a key provider.

---

## 1. Grouping (from `skipped-tests-triage-816`)

| Group | What | Needs |
|---|---|---|
| **G0 - offline** | the majority: every suite that runs in CI today | **nothing.** No window, no Vault. Not covered here |
| **G1 - PostgreSQL / Redis / S3 window** | Class A: `admin-action-rbac-live`, `admin-audit`, `admin-base-routes`, `admin-error-boundary`, `admin-keyset-explain`, `admin-shell-live-pane`, `artifact-grant-fencing`, `artifacts-fencing-pg`, `blob-wire-binary`, `data-02-04-live-s3`, `ingress-bounded`, `migrations`, `webhook-reclaim-fence.live` | an open maintenance window + real PG/Redis/S3 |
| **G2 - real Vault** | `vault-live.test.ts` **plus any G1 test whose path resolves a credential through the key provider** | Vault server, mount, scoped policy, non-root token - **separate from G1** |
| **G3a - own schema** | `admin-local-users-migration` (`DU_LOCAL01_LIVE_MIGRATION=1`) | a dedicated private schema, not the shared window |
| **G3b - throwaway PG16** | `gate-authenticate-808-pg16` (`GATE_AUTH_PG_URL`) | a disposable container, **not** the project DB - the lowest-risk live group |
| **G4 - UNCLASSIFIED** | Class C conditional `skipIf` in ~15 offline suites | **read first.** The triage flagged these as unread; they cannot be scheduled until each condition is read |

---

## 2. Runbook - G1 (PostgreSQL / Redis / S3 window)

### 2.1 Environment conditions (all must hold before step 1)

1. **A window is granted by the USER** (see section 5 - not granted yet).
2. Dedicated database/schema and roles; **never** the shared dev database. The runbook in
   `live-window-runbook-803` already carries the isolation checklist - reuse it, do not restate it.
3. A restorable backup exists and a **named cleanup owner** is recorded.
4. `DU_LIVE_INFRA=1` is set **only** inside the window, never exported globally.
5. Synthetic tenants/ids only. **No real data** (section 6).

### 2.2 Order (each step is a stop-gate for the next)

| # | Step | Operator-required? | Revertible? |
|---|---|---|---|
| 1 | Capture the pre-window state: row counts, migration status, build digest | yes - a human records it | n/a (read-only) |
| 2 | `admin-base-routes` + `admin-audit` + `admin-keyset-explain` (read-mostly admin surfaces) | no | yes - read-only |
| 3 | `migrations` + `admin-local-users-migration` (G3a schema) | **yes** - a human confirms the pending list before applying | **partly** - migration 0032 has NO down migration; rollback is restore-from-backup + hand-run inverse + delete the ledger row |
| 4 | `artifact-grant-fencing` + `artifacts-fencing-pg` + `blob-wire-binary` | no | yes |
| 5 | `data-02-04-live-s3` + `ingress-bounded` | yes - a human confirms the bucket/prefix is the disposable one | yes, if object versions are preserved |
| 6 | `webhook-reclaim-fence.live` | no | yes |
| 7 | `admin-error-boundary`, `admin-shell-live-pane`, `admin-action-rbac-live` | no | yes |

### 2.3 Stop conditions (abort immediately)

- Any write to a database that is not the window database.
- Any real tenant id, prompt, response body or row value in output or evidence.
- A migration whose pending list is not fully understood.
- A count or status that disagrees with the pre-window capture.
- **Any secret in any output** - abort and treat as an incident.

---

## 3. Runbook - G2 (real Vault)

### 3.1 Why it is separate

Vault is this project key provider. A G2 run needs its own mount, path prefix, policy revision and a
**non-root** token - and its own stop conditions. It must not be scheduled as "the rest of G1".

### 3.2 Environment conditions

1. A dedicated KV v2 mount/path for the run, and a Transit key if the path uses one.
2. Distinct non-root machine identities for writer / reader / encryptor / decryptor.
3. The effective policy revision recorded, and own-prefix-allow / other-prefix-deny proved with metadata
   calls only.
4. Synthetic secrets held **in memory**; nothing persisted to disk or to a receipt.

### 3.3 Order and revertibility

| # | Step | Operator-required? | Revertible? |
|---|---|---|---|
| 1 | `vault-live.test.ts` (read/metadata paths first) | no | yes |
| 2 | The credential-workflow leg (write CAS) | **yes** - a human confirms the run namespace | yes - rotate the ref back |
| 3 | Any G1 test that resolves a credential through Vault | **yes** - it is now a G2 test | depends on the test |

### 3.4 Stop conditions

- Root-token-only success (not an acceptance identity).
- A shared key/path/policy mutated.
- A connector that cannot read its pinned version.
- Any secret or sentinel in response, audit, SQL, log or evidence.
- **If the connector-side reader is absent, mark that leg BLOCKED** - a manual Vault read is not a substitute.

---

## 4. Per-item: should it be run, and what can we conclude?

| Group | Should it be run? | If not run, the honest statement |
|---|---|---|
| G0 offline | **yes, now** - already in CI | - |
| G3b throwaway PG16 | **yes, first of the live groups** - lowest risk, no project data | - |
| G1 | **yes, when a window is granted** | **cannot yet conclude anything** about live PG/Redis/S3 behaviour. Every claim stays offline-only |
| G2 Vault | **yes, but last** - highest blast radius, needs its own namespace | **cannot yet conclude anything** about the real key provider. The ENC-09/A2 claims in particular remain unproven live |
| G3a own schema | yes, alongside G1 step 3 | - |
| G4 unread `skipIf` | **cannot be scheduled** | the conditions are unread; scheduling them now would be guessing |

**Explicit:** for G1 and G2 the answer to "can we conclude anything?" is **no, not yet**. Not "probably fine".

---

## 5. USER-conditional items (nothing here is granted yet)

1. **The maintenance window itself has not been granted by the USER.** No group below G0 may start without it.
2. **The Vault run namespace** (mount, path, policy, identities) needs USER/owner approval.
3. **The disposal/cleanup owner** for every mutating cell.
4. **`/admin/workflows` deployment (DEV-03)** remains user-gated (WAVE-801 A6) and is out of scope here.
5. **A2 / the ENC-09 window close** stays user-gated; no runbook step authorises the flip.

---

## 6. Hard constraints carried into every group

- **No real data.** Synthetic tenants, synthetic ids, synthetic secrets.
- **No secret in any output**, including this runbook: the evidence rule is counts, statuses, hashes, exits.
- **Nothing was run to produce this file.** Every step above is a plan.

## 7. Ledger

- LIVE-WINDOW-RUNBOOK-819 - Muc 1 - runbook for the maintenance-window and real-Vault groups: split G0
  offline (already in CI), G1 PG/Redis/S3 window, **G2 real Vault as its own group** because Vault is this
  project key provider, G3a own-schema and G3b throwaway PG16, and G4 the unread `skipIf` class that cannot
  be scheduled; G1 and G2 each given environment conditions, an ordered step table with operator-required and
  revertible flags, and stop conditions; per-group "should it run" with **cannot yet conclude anything** for
  G1/G2; five USER-conditional items including the not-yet-granted window. DOC-ONLY: nothing executed, no
  source edit, no commit, no tick.
