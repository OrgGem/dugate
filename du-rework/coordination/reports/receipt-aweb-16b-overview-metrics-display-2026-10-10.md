# Receipt: AWEB-16B Overview aggregate metrics

Date: 2026-10-10
Task: AWEB-16B-METRICS-DISPLAY-CLIENT-2026-10-10
Plan: `coordination/reports/survey-workflows-connectors-2026-10-10.md`, section 6 item W-A
Scope: `du-rework`

## Delivered

- Overview KPI totals and success rate remain sourced from the server operations aggregate endpoint, whose response validates the complete status-count sum and echoes tenant plus UTC time bounds.
- The aggregate is passed to the dashboard only while its tenant and time window match the current selection. A tenant or range change clears the prior snapshot and failure state so old-scope values are not shown during refresh.
- `computeOperationsTelemetry` now names its list-derived counts and success rate as sample metrics. It no longer exposes `operations.length` as a system-wide total; the 100-row list remains only a recent-page sample.

## Verification

Environment: Node 24.21.0, offline admin-web checks.

- Command: `node --test tests/*.test.mjs`
  - CWD: `du-rework/orchestrator/apps/admin-web`
  - Result: PASS, 54 tests, 12 suites, exit code 0.
- Command: `npm run typecheck`
  - CWD: `du-rework/orchestrator/apps/admin-web`
  - Result: PASS, exit code 0.
- Node inline smoke with 120 operation rows verified that helper output is sample-scoped and has no system `total` field — PASS, exit code 0.
- Build digest: not produced; build was not requested.
- No files were staged, committed, or pushed.

No separate raw-output artifact was written; command results were observed in the execution terminal.
