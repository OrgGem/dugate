# Receipt E2E-00 L0 triage — offline suite reds

Date: 2026-10-11
Owner: coordinator
Scope: triage of the 6 failures in `tests/deployment/docker.test.cjs` (14 pass / 6 fail, EXIT=1)
Verdict: PRE-EXISTING on a clean committed tree. Non-blocking for E2E-01 build.

## Tree state

`git status --porcelain pnpm-lock.yaml compose/ docker-compose.yml Dockerfile tests/deployment/ scripts/docker/`
returned no output. None of the involved paths are modified or untracked.

## FAIL A — lockfile byte-equality

Test: `tests/deployment/docker.test.cjs:42-48`, failing assertion at `:45`.

```js
const prepared = deploymentLockfile(original);
assert.equal(prepared.slice(prepared.indexOf('overrides:')), original.slice(original.indexOf('overrides:')));
```

Mechanism, read from source:

- `scripts/docker/build-runtime.cjs:82-83` rewrites
  `tarball: file:orchestrator/vendor/<file>` to an absolute path under `root`.
- Rationale comment at `scripts/docker/build-runtime.cjs:79-81`: deploy resolves local
  tarballs relative to its output directory, so build-only resolutions must point at the
  source artifact or offline worker deployment looks for `/deploy/<worker>/vendor`.
- `scripts/docker/build-runtime.cjs:84-88` injects `injectWorkspacePackages: true` under `settings:`.
- `pnpm-lock.yaml:7` is `overrides:`; `pnpm-lock.yaml:3607` is the tarball resolution
  `tarball: file:orchestrator/vendor/xlsx-0.20.3.tgz`.

Because line 3607 sits AFTER line 7, the test's comparison window necessarily includes the
exact value the function is documented to rewrite. The assertion is unsatisfiable by design
on any lockfile containing that line.

Provenance: `git log -S 'xlsx-0.20.3.tgz' -- pnpm-lock.yaml` and
`git log --oneline -3 -- tests/deployment/docker.test.cjs` both resolve to the same commit
`4308cc5 chore(du-rework): snapshot application code and documentation`. The test and the
tarball line arrived together, so this assertion has never passed.

Classification: TEST BUG. The implementation behaviour is intentional and load-bearing for
offline worker deployment. The assertion window should exclude the tarball rewrite.

## FAIL B — five compose model assertions

Test: `tests/deployment/docker.test.cjs:97`, failing for the root wrapper,
`orchestrator/services/orchestrator`, `businesses/document-core`, `businesses/lc-checker`,
`businesses/example-review`. The `connector` wrapper PASSED.

```js
assert.equal(service.environment.ORCHESTRATOR_PORT, undefined);  // actual: '3000'
```

Mechanism, read from source:

- `compose/orchestrator.yml:26` sets `ORCHESTRATOR_PORT: '3000'` in the container environment.
- `compose/orchestrator.yml:24` sets `PORT: '3000'`. The two agree.
- `compose/connector.yml:9` sets only `PORT: '8080'` and has no `CONNECTOR_PORT` key, which is
  why the parallel assertion at `tests/deployment/docker.test.cjs:104` passes.
- `compose/orchestrator.yml:84` uses `${ORCHESTRATOR_PORT:-3000}` only for the host-side
  published port, which is the correct place for the knob.

`grep -n '^\s\+\(ORCHESTRATOR_PORT\|CONNECTOR_PORT\|PORT\):' compose/` returns exactly three
hits: `compose/orchestrator.yml:24`, `compose/orchestrator.yml:26`, `compose/connector.yml:9`.
`compose/orchestrator.yml:26` is the sole asymmetry in the whole `compose/` directory.

Provenance: `git log -S "ORCHESTRATOR_PORT: '3000'" -- compose/orchestrator.yml` resolves to
`4308cc5`, the same commit that introduced the test. Also never passed.

Classification: TEST BUG / harmless redundancy. The container listens on 3000 either way, so
the rendered model is self-consistent. Removing line 26 would satisfy the test but is a
source edit outside coordinator authority.

## Why neither blocks L0

L0 is defined by the build and boot contract, not by the offline regression guard. The L0.2
compose contract was verified independently and directly from the rendered model:

- 8 services.
- All 6 build services use `ctx=<du-rework root>` and `dockerfile=Dockerfile`.
- Only `orchestrator` publishes host ports: `127.0.0.1:3300->3000`, `127.0.0.1:3301->3001`.
- `orchestrator` env: `PORT=3000`, `AUTO_MIGRATE=false`, `DU_ADMIN_WEB=1`, `DATA_MODE=real`.
- `depends_on.migrate.condition=service_completed_successfully`.
- `migrate` command `["node","dist/migrate-cli.js","migrate"]`, `restart="no"`.

The 10 build-plan assertions, all 10 Dockerfile-sync assertions, the credential/identity
test, and the missing-secrets-refusal test all PASSED. The deployment model is sound; the two
reds are narrow contract divergences between a test and an intentional implementation.

## Host tree safety during build

`Dockerfile:9` copies `pnpm-lock.yaml` into the `build-base` stage (`WORKDIR /workspace`), and
`Dockerfile:26-34` runs `build-runtime.cjs` inside that stage with `--network=none`.
`build-runtime.cjs:111-113` therefore rewrites `/workspace/pnpm-lock.yaml` inside the image
layer only. The host `pnpm-lock.yaml` is never modified by the build.

## Disposition

Proceed to E2E-01. Both reds are recorded here with file:line evidence and are NOT counted as
L0 failures. They are handed to the executor lane as pre-existing test defects, not as
blockers for the live E2E run.
