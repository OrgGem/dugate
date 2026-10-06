# WT-06 - Portal purpose filter comment alignment - 2026-10-07

Owner: codex_arch. Scope: du-rework only. Canonical plan: `tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md` section 2.2.
Status: IMPLEMENTED; owner typecheck passed. Independent verification/acceptance remains with tester/reviewer. No commit or push; legacy root unchanged.

## Decision and scoped diff

Selected the explicitly authorized comment-only option: retain exact-purpose filtering. `purposeMatches` accepts the required purpose or undefined metadata; explicit generic and other explicit purposes are excluded. ACTIVE-state filtering and configured-but-unavailable ref display are unchanged. Generic remains a legitimate catalog purpose, not a wildcard for callback credentials.

Rationale: `callback-policy.ts` documents that this filter prevents selections which the resolver would deny at delivery. `services/orchestrator/src/modules/secrets/vault-resolver.ts:276-277` checks `reference.purposes.includes(context.purpose)` and returns PURPOSE_DENIED on a mismatch. No authorization broadening was introduced.

Task-owned hunk in `apps/admin-web/src/features/profiles/callback-policy-editor.tsx:66`:

```diff
-  // Selectable options: ACTIVE and authorized for the branch purpose. `generic`
-  // (or missing purpose metadata) stays selectable for compatibility.
+  // Selectable options: ACTIVE with the exact branch purpose, or missing
+  // purpose metadata for compatibility. `generic` is not a callback-purpose
+  // wildcard and is filtered out, as are other explicit purposes.
```

Only this comment was edited by WT-06; pre-existing shared-tree changes in the file were preserved. No public API, type, contract, runtime logic or dependency was changed.

## Validation

Node: **v24.21.0**.

| cwd | command | exit | result |
|---|---|---:|---|
| `D:/Git/dugate/du-rework/apps/admin-web` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | passed, no diagnostics |

Raw log: `raw/wt06-portal-purpose-2026-10-07/portal-typecheck.log` (empty on success); exit recorded in `portal-typecheck.exit.txt`; current file SHA-256 in `source-sha256.txt`.

Orchestrator/contracts checks were not rerun because the change is a Portal comment only and touches no executable code/types/contracts. No additional unit/browser tests were added or claimed. No global plan checkbox was changed.
