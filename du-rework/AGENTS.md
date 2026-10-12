# du-rework Instructions

These instructions supplement the repository-root `AGENTS.md` and apply to work in `du-rework/`.

## Code and runtime boundaries

- Find the canonical implementation and its consumers before editing. Core paths include `orchestrator/`, `packages/` and `services/` where present, plus `businesses/<business>/` code, workers, and templates.
- Preserve intentionally shared business-worker authentication keys and the established checkpoint and grant key formats. Do not split, rename, normalize, or rotate them unless the task explicitly requires that change.
- Keep source, built artifacts, and running deployment evidence distinct. State which level was inspected or verified; a source change or test receipt alone does not prove deployed behavior.
- Protect secrets and avoid printing credentials in logs, receipts, or command output.

## Codex coordination

Use the Codex roles and model selections in the root `AGENTS.md`. Historical files such as `coordination/COORDINATOR-CONTRACT.md`, task ledgers, reports, and scheduler state may provide context, but are reference-only for this Codex session. They do not require Claude Code or Orca dispatch, live scheduler checks, or legacy reporting/approval gates. The primary agent may consult current plans and evidence when they help define the requested scope.