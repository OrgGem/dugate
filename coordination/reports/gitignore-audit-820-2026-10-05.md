# GITIGNORE-AUDIT-820 — read-only findings and proposal

**Repository root:** `D:/Git/dugate`  
**Scope:** inspect current ignore files, effective Git visibility, tracked generated/local files, and secret-bearing paths. No `.gitignore` or source file was edited, no file was staged/unstaged, and no commit or task tick was made.

## Findings first

1. **High risk:** `du-rework/.env.live` is untracked and **not ignored**. A safe variable-shape scan found 15 non-placeholder values in secret-bearing fields; values were deliberately withheld. Add a local-environment ignore rule before anyone stages this path.
2. **No verified real secret was found in a tracked environment/credential file.** The only tracked environment-like files are examples/samples. A signature scan did find token/private-key-shaped literals in four tracked test files; they appear to be test fixtures, but the scan cannot certify they are synthetic. The four paths are named below, without exposing contents.
3. The existing browser ignore rule covers `test-results/`, but **10 current `test-results-*` files/trace paths remain visible** because their directory names do not match it. They are generated Playwright output and can include captured page state; add a narrow prefix rule.
4. **437 already tracked paths match positive ignore rules**: 403 under `.qwen/tmp/` and 34 Python bytecode files under `__pycache__/`. There are 103 tracked `.log` files among the `.qwen/tmp/` paths. Ignore rules do not untrack these files; a separate, explicitly authorized index cleanup would be required.
5. The current root `.gitignore` working copy is readable text, but the index/HEAD blob has 14 NUL bytes and `git diff -- .gitignore` reports a binary difference. This makes the pending ignore-rule change hard to review line by line; normalize/review it as a separate controlled change.

The exact path inventory is in [gitignore-audit-820-path-inventory.txt](gitignore-audit-820-path-inventory.txt). It records the paths visible before this receipt was written, the local/generated candidates proposed for ignoring, and every tracked path matched by a positive ignore rule. It contains path names/rules only, no file contents or secret values.

## Ignore files found

There are five `.gitignore` files:

| Path | Worktree status at audit start | Effective role / spot-check |
|---|---|---|
| `.gitignore` | Modified before this audit | Repository-wide env/key/build/local-agent patterns. `git check-ignore` confirms `.qwen/tmp/`, `__pycache__/`, local `.env.local`, and targeted coordination state rules are active. `!uploads/.gitkeep` and `!outputs/.gitkeep` keep sentinels visible. |
| `du-rework/.gitignore` | Modified before this audit | Ignores package `node_modules`, `dist`, coverage, local data, logs, and local env. It has `.env.docker`/`.env.docker.*` plus `!.env.docker.example`; the example stays visible. |
| `du-rework/apps/admin-web/.gitignore` | Untracked at audit start; keep visible | Its `node_modules/`, `dist/`, and `*.tsbuildinfo` rules correctly hide admin-web build output. Do not ignore this config file itself. |
| `du-rework/tests/browser/.gitignore` | No worktree change observed | `node_modules/`, `artifacts/`, `playwright-report/`, and exact `test-results/` outputs are ignored. The prefix-named `test-results-*` directories are not. |
| `du-rework/tests/login/.gitignore` | No worktree change observed | Local `node_modules/`, `dist/`, and `*.log` are ignored. |

The root file's current worktree is 866 bytes with zero NUL bytes; its index/HEAD blob is 304 bytes with 14 NUL bytes. Git's current diff says `Binary files a/.gitignore and b/.gitignore differ`. `git check-ignore` reads the working-tree rules, so the current observed runtime behavior reflects the text worktree file, while the pending change cannot be reviewed as an ordinary textual diff yet.

## Effective visibility checks

These results came from `git check-ignore -v` and `git status` path-only inspection:

| Path/pattern | Observed result | Assessment |
|---|---|---|
| `du-rework/.env.live` | No ignore rule; visible as `??` | Credential exposure/staging risk; fix proposal below. |
| `du-rework/.env.local` | Ignored by root `.gitignore:4` (`.env.local`) | Correct local-only behavior. Safe shape scan found non-placeholder sensitive fields; values withheld. |
| `du-rework/.env.docker.example` | Visible due `du-rework/.gitignore:8` negation | Correct: preserve the safe template. |
| `du-rework/apps/admin-web/dist/**` | Ignored by `du-rework/apps/admin-web/.gitignore:2` | Correct generated build output. |
| `du-rework/services/orchestrator/dist/**`, `coverage/**`, and `node_modules/**` | Ignored by the nested package rules | Correct generated/local output. |
| `du-rework/tests/browser/test-results/**` | Ignored by `tests/browser/.gitignore:4` | Correct for this exact directory name. |
| `du-rework/tests/browser/test-results-*/*` | Not ignored; 10 current paths are visible | Rule is too narrow for actual Playwright output names. |
| `du-rework/tests/browser/artifacts/**`, `playwright-report/**` | Ignored by browser `.gitignore:2-3` | Correct generated output. |
| `du-rework/data/**` | Ignored by `du-rework/.gitignore:11` | Appropriate local-data boundary; no source/evidence directory should be placed there. |
| `coordination/tl*.json`, `du-rework/coordination/tl*.json`, `probe-nudges.json`, `coordination/tmpread/` | Matched the explicit root rules at lines 26-29 | Dynamic task state/read caches; retain the narrow rules, do not broaden them to coordination history. |
| `du-rework/coordination/reports/`, `reviews/`, `dispatch-specs/`, and `evidence/` | Visible; corresponding root ignore lines are comments | Correct. Keep these untracked task records discoverable for A16/path reconciliation. |
| `outputs/.gitkeep` | Kept visible by `.gitignore:11` negation | Correct; do not remove the exception. |

The broad `*.key`/`*.pem` rules currently have no demonstrated untracked public-key fixture conflict by filename. Keep them as safety defaults; add a path-specific negation only if a reviewed, intentionally committed public test fixture requires one.

## Secret-path audit

- Tracked environment-like paths are only `.env.example`, `du-rework/.env.example`, `du-rework/.env.local.sample`, and `mock-service/.env.example`. No tracked `.env`, `.env.local`, `.env.production`, `.env.live`, private-key file, or credential-named local config was found.
- `du-rework/.env.live` is untracked and visible. It contains 15 non-placeholder values in fields whose names indicate credentials or credential-bearing connection/config data. The file path is the only detail recorded; values were not printed or copied into this receipt.
- `du-rework/.env.local` is ignored as expected; the safe scan found non-placeholder sensitive values there too. No values are recorded.
- Known-signature scanning of tracked content returned candidate paths only in these test files: `du-rework/packages/contracts/tests/vault-ref.test.ts`, `du-rework/packages/observability/tests/observability.test.ts`, `du-rework/services/orchestrator/tests/delivery-encryption.test.ts`, and `du-rework/tests/login/tests/log-redaction.test.ts`. They are test locations with key/token-shaped fixtures, not tracked live configuration. No real credential was confirmed; review them as synthetic fixtures before external release.
- `gitleaks`/`detect-secrets` was not installed in this environment. The scan was limited to known high-confidence signature patterns and tracked env-like paths; it is not a full entropy-based secret scan. The safe finding is **no confirmed real secret tracked**, with the four test-fixture candidates left for manual confirmation.

## Tracked files already covered by ignore rules

The NUL-safe `git check-ignore --no-index` comparison found 437 tracked paths matched by positive rules:

| Current rule | Tracked match count | Assessment |
|---|---:|---|
| `.gitignore:22` — `.qwen/tmp/` | 403 | Agent scratch, patch backups, and captured run logs; includes 103 `.log` files. These are local scratch/history, not durable product files. |
| `.gitignore:18` — `__pycache__/` | 34 | Generated `.pyc` bytecode under `.agent/skills/**` and `du-rework/tools/openapi/**`. |

The single `outputs/.gitkeep` match is the negative exception at `.gitignore:11`, so it is **not ignored** and is not included in the 437. The path inventory includes the exact 437 paths plus the exception result.

**Important Git behavior:** none of those ignore lines makes an already tracked file untracked. The current rules only prevent new, untracked matches from being offered for staging. Removing existing entries from the index would require a separate operation such as `git rm --cached -- <exact-paths>` and a separately approved commit; no such operation was performed or is being requested here.

## Untracked paths to preserve for A16/path reconciliation

At the inventory snapshot, Git showed 2,264 untracked paths. The path-only companion file enumerates **2,253 paths to leave visible** and separately identifies 11 obvious local/generated candidates (`du-rework/.env.live` plus the 10 `test-results-*` artifacts). The keep list includes current source, tests, migrations, `.env.docker.example`, the untracked admin-web `.gitignore`, and the full untracked `du-rework/coordination/` dispatch/review/report/evidence history. It also leaves the 77 `scratch/coord-update-*.js` scripts visible pending explicit owner classification; no broad `scratch/` rule is proposed.

Do not add ignore rules for `du-rework/coordination/**`, `du-rework/services/**`, `du-rework/tests/**`, `du-rework/tasks/**`, package source, migrations, fixtures, or task receipts. Do not uncomment the optional review/report/dispatch-spec ignore lines. The full exact file list is in the companion manifest rather than abbreviated to globs here; its SHA-256 at creation was `f4967e367360d79cdfcc380a19ba961daaf48f3c35dac1eb282676be28adaa85`.

The worktree is active and the untracked inventory changed while this audit ran. Treat the manifest as a time-bound snapshot and rerun `git ls-files --others --exclude-standard` immediately before staging or applying any ignore change.

## Proposed additions only — not applied

No existing line should be removed just because a proposed pattern overlaps it. Preserve the current exceptions and the commented optional history rules. Proposed root `.gitignore` block:

```gitignore
# Local environment variants may carry credentials; explicitly retain committed templates.
.env.*
!.env.example
!.env.local.sample
!.env.docker.example
```

| Proposed line | Reason / expected effect |
|---|---|
| `.env.*` | Ignores `du-rework/.env.live` and future environment-specific overlays. It would hide the current untracked live file from ordinary `git status` and `git add`; it will not untrack an already tracked file. |
| `!.env.example` | Keeps tracked example templates visible at the repository root and in subprojects. |
| `!.env.local.sample` | Keeps the existing tracked local sample visible despite the broader pattern. |
| `!.env.docker.example` | Keeps the untracked safe Docker template visible; this complements the existing nested exception. |

Proposed addition to `du-rework/tests/browser/.gitignore`:

```gitignore
/test-results-*/
```

This narrowly hides the current generated `test-results-*` run directories and their traces while preserving `tests/browser/admin-web/*.spec.ts`, harnesses, fixtures, and the exact `test-results/` rule. Its target set is the 10 artifact paths in the companion inventory.

No rule is proposed for the `scratch/` tree in this pass. The 77 `coord-update` scripts and three other scratch paths remain visible until their owner confirms which are disposable. No new rule is proposed for coordination receipts/history or product source.

After a separately approved edit, verify expected rules with `git check-ignore -v du-rework/.env.live` and `git check-ignore -v du-rework/tests/browser/test-results-navigation-completion/.last-run.json`; verify templates and source remain visible with `git check-ignore -q .env.example`, `git check-ignore -q du-rework/.env.docker.example`, and `git check-ignore -q du-rework/tests/browser/admin-web/admin-web.spec.ts` (the latter three should return exit 1). These are proposed future checks, not executed changes.

## Audit limits and action boundary

This receipt records path visibility and signature-based checks only. It does not modify ignore behavior, untrack any file, stage anything, or claim that the four test-fixture signature matches are proven fake. No secrets were printed. The root and subproject `.gitignore` files were already dirty before this audit; all recommendations are proposals for an owner-reviewed change.
