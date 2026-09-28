$orca = "C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
$term = "term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e"

$prompt = @"
[PACKET D-EVID-A17 — Evidence ledger sync Turn 110 audit + README header update]

TASK 1 — Update tasks/README.md header pointer: Per Reviewer Turn 110 recommendation, update the leading blockquote in du-rework/tasks/README.md (line 3) to point to the Turn 110 adjudication at coordination/reports/review.md#L786 as canonical. Replace the first blockquote with: Current review — Turn 110 (2026-09-26): Latest Reviewer audit is canonical for release-gate status, closed/open deltas and Turn 110-120 work order. 52 unaccepted task rows in release scope. All four gates NO-GO. Keep all other blockquotes below as historical snapshots.

TASK 2 — Synchronize evidence inventory docs/28 and docs/35: Run link check and update anchors to reflect T-CODEX-TEST-23 (keyset EXPLAIN live 6/6 pass, delta-23 CLOSED), D-EVID-A15/A16 (775/434/BROKEN=0, delta-36 CLOSED), T-CODEX-TEST-22 (synthetic browser C0-C3, C4/C5 open), Reviewer Turn 110 decisions. Bump version to v1.26.0.

RECEIPT: Append to du-rework/coordination/reports/qwen-docs.md with cycle number, version, files changed, link check results, summary of README.md header changes.
"@

& $orca terminal send --terminal $term --text $prompt --enter
