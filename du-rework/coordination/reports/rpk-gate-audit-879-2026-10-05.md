# RPK-GATE-AUDIT-877 - receipt (doc-only audit, no code change)

> **RESUME POINT (qwen_5, 2026-10-05)** - task RPK-GATE-AUDIT-877 (task_bfea35be4ad2),
> dispatch ctx_bf06612aa543. **DOC-ONLY: no source edit, no commit, no tick.**
>
> **Bottom line: the RPK gate is NOT running. It is DEFERRED, and the plan says so in
> writing. Nothing in this packet authorises starting it.**

---

## 1. Where RPK-00..21 actually live

**All 22 rows are `[ ]` (unchecked) in the plan itself** -
`tasks/SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md:94-115`:

```
RPK-00 [ ]  Xac nhan baseline complete - Coordinator/Reviewer
RPK-01 [ ]  Inventory va ADR layout - Architecture/owners
RPK-02 [ ]  Contract authority/compatibility - Orchestrator/Connector
RPK-03 [ ]  Contracts va domain logic ve owner - Orchestrator
RPK-04 [ ]  Bundle va conformance harness - Contract/tooling
RPK-05 [ ]  Worker runtime reference - Worker owner
RPK-06 [ ]  Source ingestion ve owner - Orchestrator/Worker
RPK-07 [ ]  Document reference/guide - Document Core
RPK-08 [ ]  Egress/observability local - Platform/security
RPK-09 [ ]  Pilot Document Core Worker - Document Core
RPK-10 [ ]  Build pilot doc lap - Build owner
RPK-11 [ ]  Independent verify pilot - Tester
RPK-12 [ ]  Example Review Worker - Worker owner
RPK-13 [ ]  Connector callers/clients - Connector/caller owners
RPK-14 [ ]  Build services/collector doc lap - Service/Build
RPK-15 [ ]  Guides va 4 skills - Developer tooling
RPK-16 [ ]  Patch/version workflow - Platform/worker owners
RPK-17 [ ]  Patch/version workflow - Platform/worker owners
RPK-18 [ ]  Migrate tooling va retire packages - Integration owner
RPK-19 [ ]  Verify toan bo candidate - Tester
RPK-20 [ ]  Canary/rollback rehearsal - Deployment/Tester
RPK-21 [ ]  Acceptance va rollout - Coordinator/owners/reviewers
```

**The plan states the gate is not open, in three separate places:**

- `:7` - "Trang thai: **SPECIFIED / DEFERRED**, chua IMPLEMENTED/VERIFIED/ACCEPTED."
- `:13` - "Toan bo implementation, tao reference/bundle/skill va migration cho `RPK-00`. **Khong dispatch
  tu tai lieu nay, khong thay ledger, code/import/build hoac contract freeze dang chay.**"
- `:58` - "Day la dependency sequencing, khong them gate cho release hien tai."

**And the sequencing is explicit** - `:43`: "Phase B: MIG-04/05 dung RPK-00..21 sau baseline closure;
khong mo extraction writers som."

## 2. Is the RPK gate running in this run? **NO**

Evidence, all measured:

1. **No RPK-00 closure receipt exists.** RPK-00 is the entry condition for RPK-01..21 (`:94`, `:13`).
   Without it, the gate cannot have started.
2. **No RPK implementation file exists.** Globbed `du-rework/**/rpk*` and
   `du-rework/**/*rpk*` - zero matches. No `rpk-01-*.ts`, no redistribution lane.
3. **The 6 packages are still live and still depended on.** `businesses/document-core/package.json`
   declares `"@du/contracts": "workspace:*"`, `"@du/document-kit": "workspace:*"`,
   `"@du/worker-sdk": "workspace:*"`. Nothing has been retired.
4. **The current run is doing something else entirely.** The active task is
   `MIGRATION-INVENTORY-FIX-877` (assertion `coveredKinds` in
   `services/orchestrator/tests/legacy-payload-migration.test.ts`), plus a docs-only
   `DOCS-PROTECTION-820` and a template pilot `WORKER-TEMPLATE-PILOT-890`.

## 3. Duplicate shared packages (path + hash)

**6 packages** (`packages/`): `connector-client`, `contracts`, `document-kit`, `egress`,
`observability`, `worker-sdk`.

**11 duplicate basenames across the three trees. ZERO are byte-identical** - every pair has a
different sha256:

| Basename | Occurrences | Identical? |
|---|---:|---|
| `index.ts` | 7 | no |
| `runtime.ts` | 3 | no |
| `types.ts` | 3 | no |
| `errors.ts` | 2 | no |
| `identity.ts` | 2 | no |
| `request-redaction.ts` | 2 | no |
| `settings.ts` | 2 | no |
| `profiles.ts` | 2 | no |
| `dispatcher.ts` | 2 | no |
| `password.ts` | 2 | no |

**Important nuance:** basename duplication is **not** code duplication. The pairs are a contract
package and its BFF relay, e.g. `packages/contracts/src/settings.ts` (346fa78723c9) vs
`services/orchestrator/src/app/admin/bff/settings.ts` (72bbfd01f33f). The relay re-exports or narrows
the contract; it is not a copy. RPK-01 is the task that decides which of each pair survives.

**One intra-repo duplicate worth flagging:** `password.ts` exists twice **inside**
`services/orchestrator` - `modules/auth/admin-local/password.ts` (6d7975182c81) and
`modules/auth/local-primitives/password.ts` (b3c097607534). That is a candidate for RPK-03, not
a pre-existing defect to fix now.

## 4. Files at risk of being lost or renamed by RPK

**A vendoring template already exists** - `businesses/document-core/template/vendor/contracts/src/`:
`request-redaction.ts`, `encryption.ts`, `ip-policy.ts`, `profile-policy.ts`, `connector.ts`,
`runtime.ts`, `operations.ts`. This is the RPK-05/RPK-07/RPK-10 starting point; it must not be
overwritten by a later redistribution lane.

**Files whose path RPK-18 will change** (retire the 6 packages): every `packages/*/src/**` file,
every `packages/*/package.json`, `packages/*/tsconfig.json`, `packages/*/jest.config.cjs`,
`packages/*/README.md`, plus the root `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

**Consumers that must be re-pointed** (RPK-18 acceptance: "quet moi consumer roi moi bo 6
packages"): `businesses/document-core/package.json`, `businesses/example-review/package.json`,
`businesses/lc-checker/package.json`, `services/orchestrator/**`, `tests/**`.

## 5. Ledger

- RPK-GATE-AUDIT-877 - Muc 1 - **the RPK gate is NOT running**: all 22 rows unchecked, the plan
  states DEFERRED in three places (`:7`, `:13`, `:58`), Phase B waits on RPK-00 (`:43`), no RPK-00
  closure receipt exists, no RPK implementation file exists, the 6 packages are still declared as
  `workspace:*` deps, and the current run is on MIGRATION-INVENTORY-FIX-877 / DOCS-PROTECTION-820 /
  WORKER-TEMPLATE-PILOT-890. Duplicate scan: 6 packages, 11 duplicate basenames, 0 byte-identical
  (basename dup != code dup); one intra-orchestrator `password.ts` pair flagged for RPK-03.
  Vendoring template already present at `businesses/document-core/template/vendor/contracts/src/`.
  No code edit, no commit, no tick.
