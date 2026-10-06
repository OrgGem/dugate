# TRACE-RECONCILE-803 - evidence fold receipt (2026-10-05)

Task `task_fa67a1eded62`, dispatch `ctx_37707d14bbd6`, run `run_069ecd6957cd`; owner codex_arch. DOC-ONLY: appended a new evidence section to docs/19, docs/28 and docs/35 without changing historical content. No product source edits, task ticks, commit, stage or push.

## Evidence and retained limits

Each addendum records 17 evidence rows and 14 packet rows (W802-01..08 and UI 803-01..06). All product/test/reviewer claims are explicitly *owner* transcribed from linked receipts, including independent tester reports. None were rerun by codex_arch; no acceptance row was promoted to VERIFIED, and no fleet total was calculated.

The fold includes SDK R4 camelCase fan-out, opened admin projection/S1 and route probes, ENC09 inventory/store and its two owner bugs, optional Vault example semantics, CFGADM P1/P2/P3 review conditions, digest-pinned UI contract section 5, V1 conditions and startup policy decision, migration 0032 prep/ledger fix, role-policy security change, CRED V3 limitations, independent VFY-ENC09-803 and VFY-PLAN-805B, and the fourteen packet dependencies.

Key qualifications: actual AES-GCM R1/R2/SDK interoperability used a scripted DB and deterministic offline provider; no production backfill caller/window enforcement was found. Migration ledger checks still cannot prove physical schema objects. The role-policy owner reported three existing audit-position test failures and no HTTP route proof. CRED G7 issued zero SQL; its capture detector has a separate positive control. Settings was catalog-only with missing wire at review time; AI wizard contract/BFF absent. Docs CHANGES_REQUIRED remains tied to the reviewed build until CSRF repair and a fresh review.

V1 fail-fast condition (a) was disproven by actual disposable boot; tick-note condition (b) passed. Claude's policy (b), allow boot + warning + typed consumption denial, is design input pending implementation and acceptance evidence; AUTH_DECRYPT_FAILED already exists in PERMANENT_CODES. Digest audit is transcribed at its audit time, not a fresh digest verification by this lane.

A1-A6, commit go/no-go 1-6, eight live-window questions, DEV-03 and A3 dual-read expiry remain gated/open. live-admin-web.spec.ts remains live-gated; listed/skipped journeys do not prove live behavior.

## Validation - document checks only

Reproduce from the repository root:

```powershell
python coordination/reports/trace-reconcile-803-2026-10-05.validate.py
```

The validator checks intake snapshot SHA-256, exact old-byte prefix retention, unchanged ordered checkbox tokens, required evidence/packet markers, owner attribution on every appended table row, appended local links, post-write hashes and scoped git diff-check. Literal diff is against captured intake bytes, so pre-existing shared-worktree edits are not attributed to this task.

Artifacts: [intake](trace-reconcile-803-2026-10-05.intake.json), [validator](trace-reconcile-803-2026-10-05.validate.py), [raw validation](trace-reconcile-803-2026-10-05.validation.raw.json), [post-write pins](trace-reconcile-803-2026-10-05.post-pins.json), [literal diff](trace-reconcile-803-2026-10-05.literal.diff), [diff-check raw](trace-reconcile-803-2026-10-05.diff-check.raw.txt). The one-shot [append script](trace-reconcile-803-2026-10-05.append.py) refuses duplicate sections or existing snapshot files; rerun the validator, not the append script.

**Verified by codex_arch this session:** validator literal exit 0, errors `[]`; all three original byte prefixes preserved, ordered checkbox counts unchanged (13 / 48 / 198), zero checkbox edits; 31 owner-attributed appended rows per document, 31 required markers per document and 81 appended local links valid. These are document checks only.

Intake-relative `git diff --no-index --check` exits **1 / 1 / 1**, with zero whitespace diagnostics: no-index implies exit-code, so 1 records the expected content differences. The standard worktree-versus-HEAD `git diff --check` exits **2** with 1,055 whitespace diagnostics, all within the preserved intake prefixes, zero in the append. The full [HEAD diff-check raw](trace-reconcile-803-2026-10-05.worktree-diff-check.raw.txt) is retained; historical content was left intact as instructed. This receipt does not claim the entire dirty worktree passes diff-check.

Post-write document SHA-256:

| File | SHA-256 |
|---|---|

| `docs/19-traceability-audit-matrix.md` | `e4efd02ec7f80d0e4006746d8c04a8f85f2e5daa8a9bdedb169d1d9a6a29c0de` |
| `docs/28-test-inventory.md` | `bfa9295d494e01e86edfb5f7fab671432b6252fca6cfd1c5ed884c71171b11f5` |
| `docs/35-acceptance-baseline.md` | `a502a3c2ec6a51fe2308c090f721c07f18a917edb366d82d559b52879ae66b51` |

Artifact SHA-256 (receipt excluded to avoid self-hash recursion):

| Artifact | SHA-256 |
|---|---|
| [trace-reconcile-803-2026-10-05.intake.json](trace-reconcile-803-2026-10-05.intake.json) | `14cf658a0c2032e7830d1c113d284bab4c1f0ae03967aaf0a484edba87e39935` |
| [trace-reconcile-803-2026-10-05.validation.raw.json](trace-reconcile-803-2026-10-05.validation.raw.json) | `deb68b49b480dab31b183c81af592639314e8ec2967d750e879853db0e9c370e` |
| [trace-reconcile-803-2026-10-05.post-pins.json](trace-reconcile-803-2026-10-05.post-pins.json) | `26096bfdb5f470aa95a0c09e62aea74cb95a4c2c65d3e8425011c8a41fd41101` |
| [trace-reconcile-803-2026-10-05.literal.diff](trace-reconcile-803-2026-10-05.literal.diff) | `00c3aea0f2b18c778e213d31460623f31a1270d8fddab959091935b009d4f64e` |
| [trace-reconcile-803-2026-10-05.diff-check.raw.txt](trace-reconcile-803-2026-10-05.diff-check.raw.txt) | `3a452b714525d2ed88f9fcbb3f56841f355bf918ad6f5a12fb2683310ba8d767` |
| [trace-reconcile-803-2026-10-05.worktree-diff-check.raw.txt](trace-reconcile-803-2026-10-05.worktree-diff-check.raw.txt) | `ce1d5a8f6d3c96c6a43bb6d174843cc09e189577893722c5a56dfcfc3af28534` |
| [trace-reconcile-803-2026-10-05.validate.py](trace-reconcile-803-2026-10-05.validate.py) | `a60970ac69893f112bfe1fa708a0ab7580ee8d23d2c84ca8c5a4720ee6cff687` |
