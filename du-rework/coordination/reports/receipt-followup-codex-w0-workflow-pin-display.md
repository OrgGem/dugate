# Receipt — FOLLOWUP-CODEX-W0-WORKFLOW-PIN-DISPLAY (effective workflow revision)

| Field | Value |
| :--- | :--- |
| Finding | Workflow revision shown in the editor differed from the revision the save body carries (catalog value shown, draft pin saved) |
| Dispatch | [`FOLLOWUP-CODEX-W0-WORKFLOW-PIN-DISPLAY-dispatch.txt`](../dispatch-specs/FOLLOWUP-CODEX-W0-WORKFLOW-PIN-DISPLAY-dispatch.txt) |
| Worker | DeepSeek Worker 0 — `deepseek-v4.1-flash` |
| Status | **COMPLETE (source + offline tests).** Display and save share one resolution rule; the UI now shows the effective pin and names a differing catalog default as context. |
| Evidence level | Source, typecheck and unit-test level. |
| Date | 2026-10-21 (host clock at run time) |

## 1. Change

### `profile-group-state.ts`
- New exported `resolveEffectiveWorkflowRevision(config, descriptor)`:
  - returns `null` for any non-workflow descriptor;
  - otherwise resolves `config.workflowRevision ?? descriptor.workflowRevision`,
    accepting only a positive safe integer (anything else — `0`, `NaN`, `2.5` —
    is unresolved, matching the contract);
  - an explicitly unusable draft pin does not silently fall back to the catalog.
- `buildProfileGroupSaveBody` now calls the same helper for its
  `workflowRevision`, removing the duplicated inline resolution.

### `profile-group-editor.tsx`
- `renderFunctionEditor` computes `effectiveWorkflowRevision` with the helper.
- "Server-owned pins → Workflow revision" renders the effective value; when the
  catalog advertises a different active revision it renders
  `2 (catalog: 5)` instead of the old raw `descriptor.workflowRevision`.
- Endpoints and unresolved workflows still render `—`, which is exactly what the
  save body will omit.

## 2. Tests — `tests/aweb10-profile-group-v2-state.test.ts`
New describe block (5 cases):
1. draft pin 2 vs catalog 5 → helper 2, and the save body carries 2 (the reported defect);
2. no draft pin → catalog 5;
3. endpoint never resolves a revision, even with a stale draft value;
4. null/undefined fallback and unusable values (`0`, `NaN`, `2.5`) → `null`, no silent fallback;
5. source guard: the editor calls the helper and no longer renders
   `{descriptor.workflowRevision ?? '—'}`.

## 3. Verification (literal)

| Command | Result |
| :--- | :--- |
| `pnpm --filter @du/admin-web exec tsc --noEmit` | `ADMINWEB_TSC=0` |
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | `SERVICE_TSC=0` |
| `jest tests/aweb10-profile-group-v2-state.test.ts` | 32/32 passed, exit 0 |
| Same runner, admin-web batch (state, r06, r07, bff workbench, bff groups) | 5 suites, 81/81 passed, exit 0 |

All three edited files: UTF-8, 0 mojibake sequences.
