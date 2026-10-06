# MIG-00 — PM-M02 topology documentation delta

Date: 2026-10-05. Owner: codex_arch. Authority: Antigravity-approved PM-M02 spec and explicit MIG-00 documentation lease. Status: documentation updated; no implementation/deployment acceptance claimed.

Changed only the two authorized documentation files, plus this requested receipt:

- `docs/40-du-platform-architecture.md:96`: same-process Public 3000 / Internal 3002 listener model, early public guard, authenticated BFF/internal consumers, Portal 3001, unpublished internal/Connector ports and all three worker Runtime defaults on 3002.
- `docs/12b-deployment-guide.md:22`: target ingress matrix, matching env/URL semantics, conditional local-debug overlay instructions and literal loopback debug bindings. `compose/local-debug.yml` was absent at inspection; commands are explicitly target instructions pending deployment-owner implementation and merge verification.

Both docs distinguish approved topology from the currently inspected pre-migration Compose snapshot. Internal network access does not bypass auth or establish east-west isolation. Enabled usage sink moves to internal Runtime; unset stays disabled.

Validation cwd: `D:\Git\dugate`. `git diff --check -- du-rework/docs/40-du-platform-architecture.md du-rework/docs/12b-deployment-guide.md`: exit 0 (Git line-ending notice only). Inline Python documentation checks: **6 passed, 0 failed**, exit 0; checks cover listener matrix, worker URL consistency, debug loopback bindings/status, existing spec/audit links and cross-document anchor. Initial checker run had one false failure from a non-ASCII search literal passed through the PowerShell pipeline; corrected to ASCII checks and reran successfully, without changing product/docs to satisfy that checker. No product tests, Compose render, build or live deployment tests run for this documentation-only task; validation output is in the task tool transcript.

Final document SHA-256:

| Document | SHA-256 |
|---|---|
| `docs/40-du-platform-architecture.md` | `4c17d1d0cd942c719112f4f3a53fc559aea5bf435ea9f7687ca1ca241c91e8d4` |
| `docs/12b-deployment-guide.md` | `9ebd39476d942207d1fe2ba22daa3623dd04a714a164938c7e5587467b4b803b` |

No source/Compose edits, commit, push, cutover or task checkbox changes. Antigravity retains dispatch/lease and independent verification ownership; PM-M02 remains open pending implementation and IF-01–IF-08 evidence.
