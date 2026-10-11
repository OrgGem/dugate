# Receipt E2E-01 — Docker build GREEN after one-line Dockerfile fix

Date: 2026-10-11
Owner: coordinator (user-authorized edit; contract authority clause applied)
Result: **EXIT 0** — all 5 images built, 0 TypeScript errors.

## Authorization

User instruction: fix the Dockerfile and continue building. Applied under
`COORDINATOR-CONTRACT.md` clause: latest user assignment takes precedence over
historical role documents. Scope of the edit was kept to exactly the one defect
isolated in `receipt-e2e-01-build-failure-2026-10-11.md` — nothing else.

## The change

`Dockerfile`, `build-base` stage, added at line 12-14 (after the existing
`orchestrator/vendor` copy at line 11, before the `pnpm fetch` layer):

```
# orchestrator/** packages resolve their extends as orchestrator/tsconfig.base.json,
# not the root config. Without this every tsc falls back to ES3/ES5 defaults.
COPY orchestrator/tsconfig.base.json ./orchestrator/tsconfig.base.json
```

Two comment lines plus one COPY. No other line of the Dockerfile changed.
Verified by re-reading the file: line 9 root COPY intact, line 10 patches intact,
line 11 vendor intact, line 15 `pnpm fetch` unchanged.

Placement constraint satisfied: the file must exist in the image before
`build-runtime.cjs` runs `tsc` inside the `<name>-build` stages. Line 14 precedes
the `pnpm fetch` at line 15 and every `COPY orchestrator/packages` at line 18.

## Result

Command: `docker compose --env-file .env.docker -f docker-compose.yml build`
cwd: `du-rework/`
Exit: **0**

Images built:

| Image | Status |
|---|---|
| `du-connector:local` | Built |
| `du-document-core:local` | Built |
| `du-example-review:local` | Built |
| `du-lc-checker:local` | Built |
| `du-orchestrator:local` | Built (x2 targets: migrate + orchestrator) |

TypeScript errors in the entire build log: **0** (was 222).

The whole failure set collapsed from one missing COPY. The host-side proof
recorded in the prior receipt (`tsc -p tsconfig.json --noEmit` ⇒ `TSC_EXIT=0` on
identical source) predicted exactly this outcome and the build confirmed it:
no source, lockfile, or manifest change was needed.

## Boundary note

The deliberate alternative was to repoint the 6 `orchestrator/**/tsconfig.json`
files at the root base config. Rejected: 6 source edits versus 1 Dockerfile line,
and it would leave two divergent base configs (root vs orchestrator) that are
currently byte-identical in compiler options. Copying the file the repo already
declares it needs keeps a single source of truth.

## Next

E2E-02 `up -d`, then E2E-03 run the LIVE suite `tests/deployment/smoke.cjs`
with `DU_SMOKE_ENV_FILE` set and `DU_SMOKE_PROJECT` starting with `du-fix-`
(guard at `smoke.cjs:8-10`).