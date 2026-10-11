# OPU-G4 — toast notifications and global error boundary

Date: 2026-10-08  
Scope: `du-rework` only. No database or Redis services were started; no DB window is claimed.

## Change

- Added a dependency-free `ToastProvider`, `useToast()` hook, accessible notification viewport, success/error variants, dismissal, and automatic expiry in `orchestrator/apps/admin-web/src/components/ui/toast.tsx`.
- Added `GlobalErrorBoundary` in the same file. It shows the captured message when available and `Unavailable` otherwise; it does not render a stack or substitute a numeric value.
- Mounted the boundary around the shell content and the toast provider around all routed screens in `orchestrator/apps/admin-web/src/app-shell/app-shell.tsx`. The Lane A health strip and navigation remain in the shell.
- Added the offline source-contract harness `orchestrator/services/orchestrator/tests/admin-toast-error-boundary-offline.cjs` (14 assertions). The harness is plain CJS and is run directly with Node, not Jest.

## Fail-first RED

Before implementation, from `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`:

```text
Command: node tests/admin-toast-error-boundary-offline.cjs
Exit code: 1

node:internal/assert/utils:281
    throw err;
    ^

AssertionError [ERR_ASSERTION]: toast.tsx must export ToastProvider
    at check (D:\Git\dugate\du-rework\orchestrator\services\orchestrator\tests\admin-toast-error-boundary-offline.cjs:14:10)
    at Object.<anonymous> (D:\Git\dugate\du-rework\orchestrator\services\orchestrator\tests\admin-toast-error-boundary-offline.cjs:17:1)
    at Module._compile (node:internal/modules/cjs/loader:1730:14)
    at Object..js (node:internal/modules/cjs/loader:1895:10)
    at Module.load (node:internal/modules/cjs/loader:1465:32)
    at Function._load (node:internal/modules/cjs/loader:1282:12)
    at TracingChannel.traceSync (node:diagnostics_channel:322:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:235:24)
    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)
    at node:internal/main/run_main_module:36:49 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '=='
}

Node.js v22.16.0
```

## Verification commands and results

Command run history (all cwd values are absolute):

| cwd | Command | Result |
|---|---|---|
| `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node tests/admin-toast-error-boundary-offline.cjs` before implementation | Exit `1`, RED literal above. |
| same | `node tests/admin-toast-error-boundary-offline.cjs` after initial implementation | Exit `0`; `PASS admin toast/error boundary offline harness (12 assertions)`. |
| `D:/Git/dugate/du-rework/orchestrator/apps/admin-web` | `pnpm --filter @du/admin-web typecheck` first attempt | Exit `1`; TypeScript reported the two `override` diagnostics detailed in FAILS below. |
| `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node tests/admin-toast-error-boundary-offline.cjs` after adding modifiers | Exit `0`; `PASS admin toast/error boundary offline harness (12 assertions)`. |
| `D:/Git/dugate/du-rework/orchestrator/apps/admin-web` | `pnpm --filter @du/admin-web typecheck` after adding modifiers | Exit `0`. |
| `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node tests/admin-toast-error-boundary-offline.cjs` after moving the boundary around the shell | Exit `0`; `PASS admin toast/error boundary offline harness (13 assertions)`. |
| `D:/Git/dugate/du-rework/orchestrator/apps/admin-web` | `pnpm --filter @du/admin-web typecheck` after moving the boundary | Exit `0`. |
| `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node tests/admin-toast-error-boundary-offline.cjs` final run | Exit `0`; `PASS admin toast/error boundary offline harness (14 assertions)`. |
| `D:/Git/dugate/du-rework/orchestrator/apps/admin-web` | `pnpm --filter @du/admin-web typecheck` final run | Exit `0`. |

Final required harness run, cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`:

```text
Command: node tests/admin-toast-error-boundary-offline.cjs
PASS admin toast/error boundary offline harness (14 assertions)
Exit code: 0
```

Final required typecheck, cwd `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`:

```text
Command: pnpm --filter @du/admin-web typecheck
> @du/admin-web@0.0.0 typecheck D:\Git\dugate\du-rework\orchestrator\apps\admin-web
> tsc --noEmit -p tsconfig.json
Exit code: 0
```

The package manager emitted engine warnings because this run used Node `v22.16.0` while the workspace requests `>=24.21.0 <25`; the typecheck itself exited successfully.

## FAILS and limits

- The fail-first RED above is expected and was captured before implementation.
- The first typecheck command was `pnpm --filter @du/admin-web typecheck` from `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`; it exited `1` (`tsc` reported exit status `2`) with these literal diagnostics:

  ```text
  src/components/ui/toast.tsx(104,3): error TS4114: This member must have an 'override' modifier because it overrides a member in the base class 'Component<ErrorBoundaryProps, ErrorBoundaryState, any>'.
  src/components/ui/toast.tsx(110,3): error TS4114: This member must have an 'override' modifier because it overrides a member in the base class 'Component<ErrorBoundaryProps, ErrorBoundaryState, any>'.
  ```

  Those modifiers were added; the final typecheck above exited `0`.
- An intermediate harness run passed with 12 assertions; the structural boundary assertion and the message/stack checks were then added. The final 14-assertion run above passed.
- The CJS harness checks source wiring and required fallback/toast contracts. It does not mount React in a browser or exercise keyboard/screen-reader behavior. Verification was offline; no PostgreSQL/Redis or live health window was used.
- No remaining test or typecheck failure was observed in the final required runs.

## Lane A evidence carried forward

These results are from the completed Lane A run recorded earlier in this work. The Lane A package typecheck command invokes the `tsc` script shown below; that is one typecheck execution, not two independent runs.

| Command | Result |
|---|---|
| cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`; `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-bff-health-offline.test.ts` | Exit `0`; `Test Suites: 1 passed, 1 total`; `Tests: 1 passed, 1 total`. |
| cwd `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`; package script `tsc --noEmit -p tsconfig.json` as printed by the typecheck command | Exit `0`; no TypeScript diagnostics. |
| cwd `D:/Git/dugate/du-rework/orchestrator/apps/admin-web`; `pnpm --filter @du/admin-web typecheck` | Exit `0`; engine warnings noted above for the Lane A environment. |

No gates were ticked. No commit, staging, or push was performed.
