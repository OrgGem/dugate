# CONV-00 — tracked file-size guard receipt

Date: 2026-10-02  
Scope: `du-rework/tools/` and this receipt only. No production or test source, package manifest, or CI file was edited.

## Implementation

Added `tools/file-size-guard.cjs`, a dependency-free Node guard. It enumerates paths from `git ls-files -z`, reads their working-tree contents, and counts physical UTF-8 lines for the plan's hand-authored source extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.py`, `.sql`, `.ps1`, `.sh`, `.go`, and `.rs`. CRLF is treated as one line separator, the same as LF; a final unterminated line is counted.

The guard warns at `>= 1,500` lines. It reports files over `2,000` lines, but only exits nonzero for paths not in the active legacy-debt exemption map. The five entries from the plan are retained as the original baseline record; paths that are already below threshold or deleted are not exempted. Once a legacy file is refactored below the threshold, remove its exemption in that same change; a later increase over 2,000 then becomes a new oversize and fails. Existing debt remains visible and does not fail solely because it is still present.

Exclusions are explicit and counted in command output: tracked lockfiles; `docs/21-openapi.json`; `coordination/reports/**` history; the three coordination state JSON files (`agent-watch-state.json`, `coordinator-schedule-state.json`, `coordinator-state.json`); and generated `docs/28-test-inventory.md`. The scanner also skips any tracked path with a segment named `node_modules`, `dist`, `build`, `coverage`, `.cache`, or `__pycache__`, and prints a count for each directory. Other non-code extensions are counted in an `Ignored tracked non-code extensions` total. Untracked files are outside the requested tracked-file inventory.

## Baseline and guard run

The plan's original baseline was five entries with these recorded line counts:

| File | Lines | Result |
|---|---:|---|
| `services/orchestrator/src/server.ts` | 4,299 | still over threshold; active exemption |
| `services/orchestrator/tests/runtime.test.ts` | 3,869 | still over threshold; active exemption |
| `services/orchestrator/tests/admin-shell-render.test.ts` | 2,815 | now 288 lines; exemption retired, regrowth is guarded |
| `businesses/document-core/tests/multi-container-e2e.integration.test.ts` | 2,261 | still over threshold; active exemption |
| `services/orchestrator/tests/admin-operations-list-pagination.test.ts` | 2,031 | deleted from working tree; exemption retired |

Command: `cd du-rework && node tools/file-size-guard.cjs` — **exit code 1** in the current working tree. At run time, the scan found four files over 2,000: the three still-grandfathered debts above plus `businesses/document-core/src/worker.ts` at 2,023 lines. It exited 1 for `worker.ts`, a tracked hand-authored source file that must not be hidden by an exclusion. That file is modified outside this packet (`git status` reports `M`; `git diff --numstat` reports 605 insertions and 1 deletion); its committed `HEAD` version is 1,419 lines. Two original baseline paths also changed concurrently during this task: `admin-shell-render.test.ts` is now 288 lines and the operations-pagination test is deleted. The script reports both transitions and no longer exempts them. The original five baseline counts are preserved above, but the current working tree does not satisfy the requested five-file output because of those separate source changes and the new `worker.ts` threshold crossing.

The final run reported 10 files at or above 1,500 lines, four over 2,000, 824 tracked code files, 473 tracked non-code-extension files, one tracked code path absent from the working tree (`services/orchestrator/tests/admin-operations-list-pagination.test.ts`), and the allowlist/excluded-directory counts described in the output. No tracked file was modified by the guard.

## Line-ending and behavior tests

Command: `cd du-rework && node --test tools/file-size-guard.test.cjs` — **exit code 0**; TAP reported `# tests 3`, `# pass 3`, `# fail 0`. The LF/CRLF test writes two temporary `.ts` files with identical logical content and verifies both count as three lines. Additional tests verify explicit exclusions, baseline debt behavior, a new 2,001-line file failing, and a cleared baseline path failing if it crosses the threshold again.

## CI wiring proposal

Integration owner can add `node tools/file-size-guard.cjs` as a read-only CI check in a separate wiring change; this packet intentionally did not edit package scripts or CI configuration.
