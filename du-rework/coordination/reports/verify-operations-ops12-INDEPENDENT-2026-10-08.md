# VERIFY — OPU-OPS-1 (download link) + OPU-OPS-2 (elapsed timer), independent — 2026-10-08

- **Verifier**: oc_3 (independent; source and harness read from disk, no lane
  report trusted).
- **Mode**: READ-ONLY — no source/test edits, no commit/add/push, no gate ticks,
  no `docs/21-openapi.json` hand-edit, `.env.live` never read. **Offline only**
  — no PostgreSQL/Redis, no DB window claimed. `du-rework` only.
- **cwd for commands**: as noted per row.

## Command table (literal + exit code)

| # | Command | cwd | Exit | Literal |
|---|---|---:|---|---|
| 1 | `node tests/operations-download-live-offline.cjs` | `orchestrator/services/orchestrator` | **0** | `PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)` — all 6 `ok` lines below |
| 2 | `pnpm --filter @du/admin-web typecheck` | `orchestrator/apps/admin-web` | **0** | engine warnings only (current Node `v22.16.0` vs `>=24.21.0`) — warnings, not failures; `tsc --noEmit -p tsconfig.json` ran and exited 0 |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `orchestrator/services/orchestrator` | **0** | no output |

Literal harness lines:

```
ok   OPS-2: a 1s tick interval exists while a non-terminal op is shown
ok   OPS-2: unknown start renders Unknown, never a fabricated 0
ok   OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
ok   OPS-1: artifact with downloadUrl renders a real download link
ok   OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
ok   OPS-2: no interval starts when every op is terminal
```

Full console captures kept outside the repo at `%TEMP%\verify-ops12\`.

## Read-and-report

### OPU-OPS-1 — artifact download link (`operations-screen.tsx` + `state.ts`)

- `operations-screen.tsx:335-347`: the Download cell renders
  `<a href={artifact.downloadUrl} download>Download</a>` **only when
  `downloadUrl` is truthy**; otherwise `<span>Unavailable</span>` — **no anchor
  is rendered for a missing URL**, so no broken link.
- `state.ts:57`: `downloadUrl: str(raw['downloadUrl'] ?? raw['download'])` —
  tolerant parse; non-string/absent → `null`.
- Harness verifies at runtime (vm render): the artifact with the URL yields an
  anchor with the exact `href`, the `download` attribute and visible text;
  the artifact without a URL yields **exactly one anchor total** (the good one),
  no empty `href`, and `Unavailable` text present.
- **Never replaces missing data with 0**: the download surface shows
  `Unavailable`, not a fake URL/0.

### OPU-OPS-2 — elapsed timer (`operations-screen.tsx` + `state.ts`)

- `operations-screen.tsx:42-52`: `listHasLive` / `detailHasLive` are true only
  when a **non-terminal** op is on screen; the effect returns early when neither
  is true, otherwise `setInterval(..., 1000)` with `clearInterval` cleanup.
  Terminal-only pages start **no** interval (harness asserts 0 active timers).
- `state.ts:92-99` (`elapsedMs`): `start` missing or `end` missing → `null`;
  terminal rows use `completedAt` (never `updatedAt`), live rows use `now`.
  Negative/non-finite → `null`.
- `operations-screen.tsx:22-23`: `formatTime(null) → 'Unknown'`,
  `formatDuration(null) → 'Unknown'`. Missing start renders **"Unknown", never
  "0.0 s"** (harness pins both). The interval drives the live value
  (0.0 s → 5.0 s after a simulated 5 s tick) with no manual refresh.
- Note on “never 0 for missing data” (factual, **out of this change's scope**):
  `state.ts:67-68` still defaults task `attempt`/`maxAttempts` to `0` when the
  wire omits them. `state.ts` is **unmodified** by this lane (`git status` clean
  for it; mtime 2026-10-07 04:30:17), so this is pre-existing behavior — flagged
  for awareness, not counted against OPU-OPS-1/2.

### Lease non-overlap

- The OPU-OPS-1/2 change is confined to `features/operations/operations-screen.tsx`
  (`M`, mtime 14:42:21 — diff is exactly: the `nowIso` + conditional-interval
  block, elapsed cells switched to `nowIso`, and the new Download column) plus
  the new harness `tests/operations-download-live-offline.cjs` (`??`).
  `features/operations/state.ts` is **untouched**.
- The named forbidden files are dirty from **other packets**, verified by
  content not just mtime: `overview-screen.tsx` and `usage-screen.tsx` carry
  inline-commented **OPU-G2** auto-refresh intervals (`// OPU-G2: one interval,
  created only after opt-in…`); `app-shell.tsx` / `components/ui/toast.tsx`
  carry **OPU-G4** (previously verified); `api-docs-screen.tsx` has no OPS
  markers. Grep of their diffs for `downloadUrl|elapsedMs|formatDuration`:
  **0 hits anywhere**; the only `setInterval` hits are their own OPU-G2/G4
  features. No OPU-OPS-1/2 content leaked into any forbidden file.

## FAIL

**None.** All 3 commands exit 0; all 6 harness assertions pass; no test name /
expected / received to report.

## Verdict

**PASS on the verified scope.** Real download link when `downloadUrl` exists and
`Unavailable` (no broken anchor) when it does not; elapsed interval runs only
while a non-terminal op is present, with cleanup, and missing start time renders
"Unknown" (never 0 s); typechecks clean; no lease overlap with the forbidden
files.

## Constraints confirmation

No source/test edits; no commit, no `git add`, no push; no gate ticks; no
`docs/21-openapi.json` edits; `.env.live` never read or printed; offline only.
The only file this lane creates in the repo is this receipt.
