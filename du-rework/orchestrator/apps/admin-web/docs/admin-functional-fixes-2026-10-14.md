# Admin functional fixes — 2026-10-14

Evidence below separates source/unit/build validation from local runtime/browser checks. It does not establish readiness of the older Docker deployment or real LLM execution.

## Changes

- Canonical tenant UUID validation accepts the default sentinel with ownership checks retained. Profile custom names, endpoint/action identity, saved-row refresh and exact reopen agree; the BFF forwards optional Profile actions.
- Ordinary Connector drafts claim the exact tenant/ID/head before writing. Local dev composes management routing and a clearly synthetic runtime identity for its backup-effect fence.
- Typed Recipe Catalog lists tenant-owned persisted lifecycle revisions with metadata-only projections, scoped cursors and exact Open. Legacy readers remain separate.
- Vault is optional for PostgreSQL metadata/public uploads, managed Secret Catalog values and typed Connector credentials. Retained local keys are required; there is no plaintext or Vault-outage downgrade.
- Typed DB credentials use AES-GCM with tenant/connector/revision/reference/version AAD, atomic draft-intent staging and resealing on Keep/rollback. Explicit Connector Vault configuration selects exact-version Vault writes for new revisions, including credentials derived from old DB rows.
- `typedCredentialStorage` and `secretCatalogImport` describe actual typed storage separately from legacy `credentialWorkflow`.
- ID inputs combine manual entry with scoped metadata suggestions; see [field inventory](admin-reference-inputs-2026-10-14.md).
- Recipe CAS uses the newly created revision for the next write. Historical loads resolve the finalized current head through complete bounded catalog pages. Activation preserves the verified head; stale tenant/ID/request responses cannot change another editor.
- Private envelopes accept the known optional provider discriminator; malformed wrapped DEKs fail before persistence. Legacy omitted-kind envelopes still require Vault Transit.
- Dev watching fingerprints actual source inputs, ignores generated/test outputs and suppresses spurious null-filename rebuilds. Cold browser startup uses an explicit CommonJS value export and fresh Vite prebundling.
- Migration engines preflight history/checksums/declared objects, share the pinned advisory lock and apply each file transactionally. Cleanup retains original errors; CLI output is allow-listed; artifact synchronization checks SQL names/content.

## Final checks

Commands ran inside `du-rework/orchestrator`, except Admin Node tests inside `apps/admin-web`. Logs/screenshots are in ignored `du-rework/tests/browser/artifacts/admin-functional-fixes-20261014/`.

| Gate | Result | Log |
| --- | --- | --- |
| Orchestrator `test:unit` | 381 passed suites, 17 skipped; 6,061 passed tests, 147 skipped | `orchestrator-optional-vault-final.log` |
| Connector `test:unit` | 59 passed suites; 563 passed tests, 1 skipped | `connector-optional-vault.log` |
| Contracts tests | 35 passed suites; 586 passed tests | `contracts-optional-vault-final.log` |
| Admin `node --test 'tests/**/*.test.mjs' 'src/**/*.test.mjs'` | 43 suites; 204 passed, zero failures | `admin-reference-cas-final.log` |
| Dev isolation/watcher/runtime identity/migration artifact tests | 14 passed | `scripts-optional-vault.log` |
| `pnpm run build` | 9/9 passed in 37.2s; 17 Connector SQL files mirrored | `build-reference-cas-final.log` |
| `pnpm run migrate` | Only forward Connector migration 017 applied; no historical SQL replay | `migrate-optional-vault-final.log` |
| `pnpm run migrate:verify` | Both passed: 65 Orchestrator + 17 Connector applied; zero pending/unknown checksums | `migrate-verify-optional-vault-final.log` |

Read-only independent source review closed with no remaining P1/P2 findings in the frozen changes, including encryption, typed recovery proofs, selectors and late CAS guards. Initial full-suite schema/provider regressions and stale Admin source-wiring assertions were repaired before the passing reruns. The last assertion repair was test-only; production source was unchanged after the final build.

Existing local ledgers received explicit reviewed baselines (65 Orchestrator + 16 Connector) before migration 017. This is a reviewed current starting point, not proof of original historical bytes. Numbered historical SQL was not modified or replayed. Migration 017 creates ciphertext storage with a draft-intent foreign key.

## Local runtime/browser evidence

The test API key, managed Secret and Profile `codex-ui-check-20261014` remain for review. The one-time key value was dismissed before screenshot/log observation. A read-only public operation lookup authenticated with it and returned 404; no job/provider call was submitted.

After final normal restart, Profile revision 1 reopened for `document-core@1.1.0`, action `analyze`, endpoint `analyze:classify`, with ACTIVE API-key membership. The prompt key selector showed actual ACTIVE tenant metadata. The exact tenant/key/endpoint connection scope had no eligible legacy UUIDs and honestly retained manual entry. No prompt override was submitted during selector checks.

The no-Vault dev process blanked Vault inputs and set `DU_VAULT_MOCK=false` in memory, without editing `.env.local`. External PostgreSQL/Redis were used, with metadata/public-upload encryption still enabled. The Secret ID picker loaded eligible metadata; Escape/ArrowDown/Enter reopened and selected it. Import created `codex-db-check-20261014@1` as PENDING. Read-only DB probes confirmed encrypted-DB source, no synthetic plaintext in recipe/source/ciphertext, correct-context decryption and wrong-revision rejection.

An initial consecutive Save exposed historical-base CAS reuse. After repair and a cold no-Vault restart, exact Open succeeded; consecutive Keep saves created revisions 2 and 3 and their ciphertext passed binding checks. Following normal restart from unchanged `.env.local`, the Inspector selected actual typed IDs and opened historical revision 1 through the Recipe reader. Save then created revision 4 using the verified current head. A fresh normal-environment crypto probe also opened the actual local-keyring import journal with the retained local key despite Vault being configured, rejecting a wrong import context. Both final DB probes passed.

Screenshots include `connector-no-vault-success.png`, `secret-id-selector-success.png`, `connector-normal-reopen-success.png`, `profile-id-selector-success.png` and earlier `profile-reopened-success.png`. Synthetic Connector revisions remain PENDING; no provider activation was made. Dev was left running normally on port 3001 with reload enabled.

## Limits and configuration

Retain `ENCRYPTION_KEY` and the Connector encryption key across restarts. Explicit Orchestrator local/Catalog keyrings retain versioned keys; Connector key replacement requires deliberate re-encryption, not automatic rotation. Gateway authentication API keys remain hashed.

Vault credential configuration stores coordinates/version, while the immutable import recovery/audit journal separately retains an encrypted submitted payload. Vault mode therefore does not remove every encrypted secret byte from all DB tables.

Typed credential backup inventory/authenticated-decryption proofs have unit/source evidence; no live backup/restore was run. Existing isolated metadata recovery remains Vault Transit based, so local-wrapper portability through that reader is not established and fails closed. Old Vault envelopes require their original provider; encrypted S3 still requires Transit integration.

No Docker image was built/changed, real LLM request or full external-worker/provider E2E was run. Core/workflow/operation API specs and independent worker SDK/skill design were preserved.
Final housekeeping at validation time: both local health endpoints returned HTTP 200. `git diff --check` passed. A scan of 141 changed/new project files found zero exact local secret-value matches and zero private-key markers; public key-reference/version identifiers were excluded from secret-value matching.

The later discussed unified Secret Catalog reference flow is not part of this change: Connector currently selects/imports managed DB secrets into its own immutable credential revision. Selecting a Vault-reference Catalog entry directly, and retaining a shared Catalog reference rather than importing a value, remain unimplemented. Catalog rotation does not automatically update an already imported Connector revision.
