# WAVE-COMMIT-PLAN-809 - receipt (commit plan, DOC-ONLY)

> **RESUME POINT (qwen_5, 2026-10-05)** - task WAVE-COMMIT-PLAN-809 (task_2c6a8b3b2bc4),
> dispatch ctx_ae57c9107166. **DOC-ONLY**: no source edit, no commit, no tick. Nothing here was
> executed beyond `git status`, `git diff --stat`, `glob`, `read_file` and `node` stat calls.

---

## 1. The core problem: git cannot split this wave

```
git status --porcelain --untracked-files=all   -> 2217 entries
  tracked modified (default porcelain)          ->  1466 lines /  155 files
  untracked (default porcelain)                 ->  1311 entries
git diff --shortstat                            -> 154 files changed, 26027 insertions(+), 14599 deletions(-)
```

**There is no commit boundary to diff against.** The tree has been dirty across many waves (780-809)
and nothing in `du-rework` has been committed, so "what changed in this wave" is not a git question.

## 2. The boundary I used - an ASSUMPTION, with the reproduction command

**Assumption: a file belongs to this wave iff its write time is on or after 2026-10-05 00:00 +07:00.**

This is a heuristic, not a fact. It is stated so the coordinator can correct it. Reproduce:

```
git status --porcelain --untracked-files=all > %TEMP%\w809-status.txt
node -e "const fs=require('fs');const CUT=Date.parse('2026-10-05T00:00:00+07:00');
  for(const l of fs.readFileSync(process.env.TEMP+'/w809-status.txt','utf8').split(/\r?\n/).filter(Boolean)){
  const a=l.split(' ');const p=a.slice(1,-1).join(' ');
  try{if(fs.statSync('D:/Git/dugate/'+p).mtimeMs>=CUT)console.log(l);}catch{}}"
```

Result: **831 files on the wave side, 1386 before it.**

**Known weakness of the boundary:** a file an earlier lane touched *and* this wave re-touched lands on
the wave side even if most of its content is older. The list below is therefore a **candidate set**, not a
proven per-file attribution. Where a file is shared across waves, the commit message should say so.

## 3. Classification of the 831 wave-side files

| Area | Count | Commit? |
|---|---|---|
| `coordination/reports/**` | ~150 | **NO** - lane receipts, not product |
| `coordination/evidence/**` | ~300 | **NO** - PNGs, traces, harness.json |
| `coordination/` other (dispatch-specs, state json, topology, counter SQL, scripts) | ~10 | **NO** |
| `docs/**` | 8 | **SEPARATE** - documentation, not product |
| `tasks/**` | 10 | **SEPARATE** - task docs |
| `scratch/**` | 30 | **NO** - scratch scripts |
| `.commandcode/taste/**` | 1 | **NO** |
| `du-rework/.env.example` | 1 | **NO** - see section 5 |
| `services/orchestrator/coordination/reports/raw/**` | 4 | **NO** - raw evidence dumps inside a package |
| **Product source + tests** | **117** | **YES** |

---

## 4. The exact product file list (117 files, with git status letters)

### 4.1 `apps/admin-web/src` (16) - all untracked

```
?? apps/admin-web/src/features/connectors/connectors-screen.tsx
?? apps/admin-web/src/features/connectors/state.ts
?? apps/admin-web/src/features/docs/docs-screen.tsx
?? apps/admin-web/src/features/identity/identity-api.ts
?? apps/admin-web/src/features/identity/identity-screen.tsx
?? apps/admin-web/src/features/index.ts
?? apps/admin-web/src/features/settings/catalog.ts
?? apps/admin-web/src/features/settings/settings-screen.tsx
?? apps/admin-web/src/features/settings/state.ts
?? apps/admin-web/src/features/workflows/workflows-screen.tsx
?? apps/admin-web/src/lib/api/client.ts
?? apps/admin-web/src/lib/api/index.ts
?? apps/admin-web/src/lib/api/types.ts
?? apps/admin-web/src/router.tsx
?? apps/admin-web/src/routes/docs.tsx
?? apps/admin-web/src/routes/workflows.tsx
```

### 4.2 `tests/browser/admin-web` (9) - all untracked

```
?? tests/browser/admin-web/api-keys-connectors.spec.ts
?? tests/browser/admin-web/cfgadm-08-identity-crud.spec.ts
?? tests/browser/admin-web/cfgadm-settings-port-p1.spec.ts
?? tests/browser/admin-web/connectors-wire.spec.ts
?? tests/browser/admin-web/harness.ts
?? tests/browser/admin-web/live-admin-web.spec.ts
?? tests/browser/admin-web/p745-ui-keys-journey.spec.ts
?? tests/browser/admin-web/p745-ui-mask.spec.ts
?? tests/browser/admin-web/profiles.spec.ts
```

### 4.3 `packages/contracts/src` (8)

```
?? packages/contracts/src/connector-management.ts
 M packages/contracts/src/connector.ts
?? packages/contracts/src/identity.ts
 M packages/contracts/src/index.ts
 M packages/contracts/src/operations.ts
?? packages/contracts/src/profile-policy.ts
 M packages/contracts/src/runtime.ts
?? packages/contracts/src/settings.ts
```

### 4.4 `services/orchestrator/src` (27)

```
?? services/orchestrator/src/app/admin/bff/handle.ts
?? services/orchestrator/src/app/admin/bff/identity.ts
?? services/orchestrator/src/app/admin/bff/settings.ts
 M services/orchestrator/src/app/admin/p6-01-shell-fixtures.ts
 M services/orchestrator/src/app/admin/shell-server.ts
 M services/orchestrator/src/app/admin/view-models.ts
?? services/orchestrator/src/app/bootstrap/create-app.ts
 M services/orchestrator/src/compat/legacy-http-mount.ts
 M services/orchestrator/src/db/migrations.ts
?? services/orchestrator/src/http/route-context.ts
?? services/orchestrator/src/http/routes/admin.ts
?? services/orchestrator/src/http/routes/public.ts
?? services/orchestrator/src/http/routes/runtime.ts
 M services/orchestrator/src/main.ts
 M services/orchestrator/src/modules/admin-actions/dispatcher.ts
 M services/orchestrator/src/modules/auth/admin-local/repository.ts
?? services/orchestrator/src/modules/connector-credentials/compose.ts
?? services/orchestrator/src/modules/connector-credentials/vault-kv2-writer.ts
?? services/orchestrator/src/modules/connectors/connector-management-store.ts
 M services/orchestrator/src/modules/encryption/legacy-payload-migration.ts
?? services/orchestrator/src/modules/encryption/metadata-auth-counter.ts
?? services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts
?? services/orchestrator/src/modules/operations/mappers.ts
 M services/orchestrator/src/modules/operations/submission.ts
 M services/orchestrator/src/modules/runtime/metadata-crypto.ts
 M services/orchestrator/src/modules/runtime/runtime.ts
 M services/orchestrator/src/server.ts
```

### 4.5 `services/orchestrator/tests` (38)

```
 M services/orchestrator/tests/admin-crypto-config.test.ts
 M services/orchestrator/tests/admin-local-user-repository.test.ts
?? services/orchestrator/tests/admin-local-user-role-policy.test.ts
 M services/orchestrator/tests/admin-p6-01-shell-fixtures.test.ts
 M services/orchestrator/tests/admin-shell-platform-mount.test.ts
 M services/orchestrator/tests/admin-shell-render.test.ts
 M services/orchestrator/tests/admin-shell-router.test.ts
 M services/orchestrator/tests/admin-shell-server.test.ts
 M services/orchestrator/tests/admin-shell-session-lifecycle.test.ts
 M services/orchestrator/tests/admin-view-model.test.ts
?? services/orchestrator/tests/audit-ext-2-offline.test.ts
?? services/orchestrator/tests/bff-connectors-actions.test.ts
?? services/orchestrator/tests/bff-settings-identity.test.ts
 M services/orchestrator/tests/br12-isolation-offline.test.ts
?? services/orchestrator/tests/credworkflow-compose.test.ts
?? services/orchestrator/tests/credworkflow-e2e-offline.functional.test.ts
?? services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts
?? services/orchestrator/tests/encmeta-enc09-kind.test.ts
?? services/orchestrator/tests/encmeta-resultref-offline.functional.test.ts
?? services/orchestrator/tests/fu-encmeta-admin-projection.test.ts
?? services/orchestrator/tests/gate-authenticate-808-pg16.test.ts
?? services/orchestrator/tests/gate-authenticate-808.test.ts
 M services/orchestrator/tests/legacy-http-mount.test.ts
 M services/orchestrator/tests/legacy-payload-migration.test.ts
?? services/orchestrator/tests/migration-0032-rollback.test.ts
?? services/orchestrator/tests/migration-verify-trap-fix.test.ts
 M services/orchestrator/tests/migrations-ledger-guard.test.ts
?? services/orchestrator/tests/p745-connector-actions.test.ts
?? services/orchestrator/tests/p745-connector-boot-composition.test.ts
?? services/orchestrator/tests/p745-connector-management-proxy.test.ts
?? services/orchestrator/tests/p745-prompt-carrier-claim.test.ts
?? services/orchestrator/tests/rcr-http-offline.functional.test.ts
?? services/orchestrator/tests/rcr-luna-http-encryption.test.ts
?? services/orchestrator/tests/rcr-luna-verification.test.ts
 M services/orchestrator/tests/runtime-encryption-metadata.test.ts
 M services/orchestrator/tests/rv01-loopback-http-offline.test.ts
?? services/orchestrator/tests/v1-boot-typed-denial.test.ts
?? services/orchestrator/tests/vault-kv2-writer-offline.functional.test.ts
```

### 4.6 Remaining product (15)

```
 M businesses/document-core/src/actions/analyze/index.ts
 M businesses/document-core/src/actions/compare/index.ts
 M businesses/document-core/src/actions/extract/index.ts
 M businesses/document-core/src/actions/generate/index.ts
 M businesses/document-core/src/actions/ingest/index.ts
?? businesses/document-core/src/actions/prompt-application.ts
 M businesses/document-core/src/actions/transform/index.ts
 M businesses/document-core/src/types/context.ts
 M businesses/document-core/src/types/results.ts
 M businesses/document-core/src/worker.ts
 M businesses/document-core/tests/execution-pin.functional.test.ts
?? businesses/document-core/tests/p745-carrier-impl-b2.test.ts
?? businesses/document-core/tests/p745-session-capture-inject.test.ts
 M packages/worker-sdk/src/fan-out.ts
 M packages/worker-sdk/tests/fan-out.test.ts
?? packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts
?? packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts
?? services/connector/tests/p745-session-leg.test.ts
?? services/orchestrator/migrations/0032_checkpoint_session_ref.sql
```

---

## 5. Suggested commit order and messages

Order is dependency-first: contracts before consumers, source before its tests, migration last.

| # | Group | Files | Suggested message |
|---|---|---|---|
| 1 | contracts | 8 (4.3) | `feat(contracts): add settings/identity/connector-management wires and tighten runtime+operations` |
| 2 | ENCMETA | 10 (metadata-crypto, runtime, legacy-payload-migration, metadata-auth-counter, migrations, acquisition-ref-resolver, mappers, submission, dispatcher, admin-local/repository) | `feat(encmeta): seal result_ref and add the auth gate counter` |
| 3 | connector credentials | 5 (compose, vault-kv2-writer, connector-management-store, connector.ts, connector-management.ts) | `feat(connector-credentials): compose the Vault KV2 credential workflow` |
| 4 | orchestrator BFF + shell | 12 (bff/handle, bff/identity, bff/settings, route-context, routes/admin, routes/public, routes/runtime, view-models, p6-01-shell-fixtures, shell-server, main, server, legacy-http-mount) | `feat(orchestrator): add settings/identity BFF routes and admin shell wiring` |
| 5 | admin-web | 25 (4.1 + 4.2) | `feat(admin-web): settings surface, identity and workflows screens` |
| 6 | document-core + worker-sdk | 15 (4.6) | `feat(document-core): prompt application and execution pin` |
| 7 | migration | 1 | `chore(migrations): add step_checkpoints.session_ref` |
| 8 | tests | 38 (4.5) | `test: cover the above` |

**Do not squash 1-3 into one commit** - they are three different subsystems and a revert of one should not
drag the others. Group 8 (tests) may be split per subsystem if the reviewer prefers.

---

## 6. What must NOT be committed

- **`.env` / `.env.live` / any real environment file.** Only `.env.example` may be considered, and it is
  currently dirty - review it for real values before staging anything from it.
- **Keys and secrets of any kind**: `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `DU_VAULT_KV_TOKEN`,
  `INVOCATION_GRANT_SECRET`, `ADMIN_TOKEN`, `RUNTIME_TOKEN`, `USAGE_TOKEN`, `WEBHOOK_SECRET`,
  `CONNECTOR_SERVICE_TOKEN`, `DATABASE_URL` (contains a password), S3 credentials, Vault tokens.
  Grep the staged set for these names before committing.
- **Disposable data**: the throwaway PG16 containers and their dumps (`du-mig0032-rehearsal`,
  `du-counter-fix`, `du-leftover-counter`), the rehearsal `pg_dump` output, and any fixture data.
- **Generated files**: `apps/admin-web/dist/**`, `packages/*/dist/**`, `node_modules/**`, build output,
  `*.tsbuildinfo`, coverage output.
- **Scratch and tooling**: `scratch/**` (30 `coord-update-*.js` + `verify-780-pins.js`),
  `.commandcode/taste/**`, `coordination/evidence/**` (~300 PNGs and traces),
  `coordination/reports/**` (~150 lane receipts), `services/orchestrator/coordination/reports/raw/**`.
- **Line-ending churn**: the tree is full of `LF will be replaced by CRLF` warnings. Decide the
  `.gitattributes` policy **before** staging, or the diff will be dominated by EOL noise and the real
  changes become unreadable.

---

## 7. Pre-commit checklist

Run per package, not once for the whole tree:

```
pnpm --filter @du/contracts build        # or tsc --noEmit
pnpm --filter @du/orchestrator test      # the 38-file suite in 4.5
pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json
pnpm --filter @du/document-core test
pnpm --filter @du/worker-sdk test
pnpm --filter @du/admin-web typecheck
pnpm --filter @du/admin-web build
pnpm --filter @du/connector test
```

Plus, before staging:

1. `git diff --stat` on the staged set only - confirm it matches section 4 and nothing from section 6.
2. Grep the staged set for secret names (`SECRET`, `TOKEN`, `PASSWORD`, `KEY`, `DATABASE_URL`, `sk-`,
   `AKIA`) and confirm zero hits.
3. Confirm no `dist/`, `node_modules/`, `scratch/`, `coordination/` path is staged.
4. Confirm the EOL policy decision is recorded in the commit message or a follow-up.
5. Run the checklist **before** the commit, not after - a red suite discovered post-commit is a revert.

---

## 8. Honest limits

1. **The wave boundary is an mtime heuristic, not a fact.** 831/1386 split at 2026-10-05 00:00 +07:00.
   A file touched by an earlier wave and re-touched now is counted as this wave. The 117-file list is a
   **candidate set**; per-file attribution needs the lane receipts, not this plan.
2. **I did not run any test, build or lint.** This is a plan, not a verification. Section 7 is the
   checklist someone else must execute.
3. **The 154 tracked modifications include changes from waves before 809.** Only the 117 product files are
   proposed for this commit; the other ~37 tracked-modified files in the wave-side set are inside
   `coordination/`, `docs/`, `tasks/` and are excluded by section 3.
4. **`.env.example` is dirty and I did not audit it.** It is listed as do-not-commit pending review.

## 9. Ledger

- WAVE-COMMIT-PLAN-809 - Muc 1 - commit plan for the wave: git cannot split the wave (154 tracked files,
  26027 insertions, 14599 deletions, 1311 untracked, nothing committed); boundary taken as mtime >=
  2026-10-05 00:00 +07:00 (stated as an assumption with a reproduction command) giving 831 wave-side
  files; classified into do-not-commit (reports, evidence, scratch, raw dumps, .env.example) and 117 product
  source+test files listed exactly with git status letters; 8 dependency-first commit groups with
  Conventional Commits messages; explicit do-not-commit list (secrets, disposable data, generated output,
  EOL churn); pre-commit checklist. DOC-ONLY: no source edit, no commit, no tick.
