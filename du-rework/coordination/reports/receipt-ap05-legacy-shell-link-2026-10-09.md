# AP-05 Legacy Admin Shell Link — Smoke Receipt

- Date: 2026-10-09
- Scope: `du-rework` only; implementation lease `orchestrator/apps/admin-web/src/app-shell/app-shell.tsx`.
- Plan: `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`, AP-05 (`APPROVED`).

## Change

At the `/admin` link in the navigation, replaced the low-emphasis “Legacy shell” text with the clearly labeled “Legacy Admin Shell”, a blue bordered/background treatment, and an accessible decorative external-shell icon (`aria-hidden="true"`). The destination remains `/admin`.

The app-shell file already contained other uncommitted changes before this task (provider wrappers, health status polling/section, and tenant selector). They were preserved; this task changed only the `/admin` link markup and styling.

## Checks

From `du-rework/orchestrator/apps/admin-web`, the requested command was run literally:

```text
node ../../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Result: exit code `1`. Literal error:

```text
Error: Cannot find module 'D:\Git\dugate\du-rework\node_modules\typescript\bin\tsc'
```

That compiler path is absent in this checkout. The same project typecheck was then run using the available root-repo TypeScript compiler:

```text
node D:\Git\dugate\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
```

Result: exit code `0`, no output.

`git diff --check -- du-rework/orchestrator/apps/admin-web/src/app-shell/app-shell.tsx`: exit code `0`, no output.

## Status

No browser-rendered smoke test was run. No backend or other product files were changed. No commit, staging, push, or gate tick was performed.
