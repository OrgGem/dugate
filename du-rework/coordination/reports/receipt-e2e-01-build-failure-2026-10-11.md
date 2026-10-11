# Receipt E2E-01 — Docker build FAILED, root cause isolated

Date: 2026-10-11
Owner: coordinator
Command: `docker compose --env-file .env.docker -f docker-compose.yml build` (cwd `du-rework/`)
Result: **EXIT 1**. All 5 build targets fail in the same place.
Status: BLOCKED — needs a one-line Dockerfile fix by the executor lane.

## Symptom

Every build target dies in stage `<name>-build` running `build-runtime.cjs`,
inside the `@du/contracts` build. Representative tail:

```
> [document-core document-core-build 1/1] RUN --network=none ... node scripts/docker/build-runtime.cjs document-core:
  src/usage-reconciliation.ts(613,19): error TS2737: BigInt literals are not available when targeting lower than ES2020.
  src/vault.ts(214,51): error TS2345: Argument of type '{ tenantId?: string; connectorId?: string; accountId?: string; }'
      is not assignable to parameter of type 'VaultAccountPathScope'.
  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @du/contracts@0.1.0 build: `tsc -p tsconfig.json`
  Exit status 2
target document-core: failed to solve: ... exit code: 1
```

Error census across the whole log (648 lines):

| Code | Count |
|---|---|
| TS2737 BigInt target too low | 150 |
| TS2802 MapIterator/Set iteration needs es2015 | 35 |
| TS2345 argument type mismatch | 20 |
| TS2769 no overload matches | 10 |
| TS5083 Cannot read file tsconfig.base.json | 5 |
| TS2550 Object.hasOwn needs es2022 lib | 5 |
| TS2339 property does not exist | 5 |

## Root cause — Dockerfile does not ship `orchestrator/tsconfig.base.json`

`Dockerfile:9` copies the ROOT base config only:

```
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
```

But `orchestrator/packages/contracts/tsconfig.json:2` extends `../../tsconfig.base.json`,
which from `orchestrator/packages/contracts/` resolves to **`orchestrator/tsconfig.base.json`**,
not the root one. The file exists on disk (`orchestrator/tsconfig.base.json`, 19 lines,
`target: ES2022`, `lib: [ES2022]`), but the Dockerfile never copies it into the image.
The log proves it, once per target:

```
error TS5083: Cannot read file '/workspace/orchestrator/tsconfig.base.json'.
```

Every `orchestrator/**` package is affected — 6 of them extend that path:
`packages/contracts`, `packages/worker-sdk`, `packages/observability`,
`packages/egress`, `packages/document-kit`, `services/orchestrator`.

The `businesses/*` and `tests/*` packages extend `../../tsconfig.base.json` which from
`businesses/document-core/` resolves to the ROOT config — that one IS copied, so those are fine.

## Why the 217 remaining errors are pure cascade

With the base config unreadable, tsc falls back to defaults: `target` defaults to ES3,
`lib` defaults to the ES5 set. That single fact produces the whole cascade mechanically:

- ES3 target ⇒ BigInt literals illegal ⇒ **150x TS2737**.
- ES5 lib ⇒ `Map`/`Set` not downlevel-iterable without the flag ⇒ **35x TS2802**.
- ES5 lib ⇒ `Object.hasOwn` is not in the lib ⇒ **5x TS2550** (whose own message even
  says: Try changing the `lib` compiler option to `es2022` or later).
- Downstream of broken libs, optional-vs-required structural checks on
  `VaultAccountPathScope`, `profile-callback.ts`, `secret-catalog.ts`,
  `profile-commands.ts` misfire ⇒ the 20x TS2345, 10x TS2769, 5x TS2339.

### Proof that the source is clean

Compiled the exact same package on the host, same source, same tsconfig, its base
config readable:

```
cd orchestrator/packages/contracts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
TSC_EXIT=0
```

**Zero errors, zero output.** So the 222 errors are an image-packaging defect, not a
source defect. Nothing in `orchestrator/packages/contracts/src` needs to change.

## The fix (executor lane — coordinator must not edit Dockerfiles)

Add one line to `Dockerfile` next to line 9, in the `build-base` stage, before the
`pnpm fetch` layer at line 12:

```
COPY orchestrator/tsconfig.base.json ./orchestrator/tsconfig.base.json
```

That is the whole fix. It copies the file the build is already proven to need, changes
no build logic, and does not touch any source, lockfile, or manifest.

Note the ordering constraint: it must land before line 12 (`pnpm fetch`), because the
workspace `tsc` invocation happens inside `build-runtime.cjs` in the `<name>-build` stages.
Any position between line 9 and line 15 is fine since line 15 only starts copying package trees.

## Classification

- **Pre-existing**: `git status --porcelain Dockerfile` is clean; this is committed state.
- **Blocker for**: E2E-01, and transitively E2E-02..E2E-09 (nothing can boot if no image builds).
- **Not a code defect**: source compiles clean on the host.
- **Owner**: executor lane. The coordinator contract forbids the coordinator from editing
  Dockerfiles, and the executor is the one who can verify the rebuilt images.

## Boundary note

The alternative would be to change `orchestrator/**/tsconfig.json` to extend the root
config, but that is 6 source-tree edits instead of 1 Dockerfile line, and it would
create two divergent base configs (root vs orchestrator) that are currently identical.
The Dockerfile copy is the correct fix: it makes the image contain what the repo
already declares it needs.