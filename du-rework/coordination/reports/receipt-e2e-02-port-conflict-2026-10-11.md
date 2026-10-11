# Receipt E2E-02 — port conflict resolved by isolation, not by killing a peer stack

Date: 2026-10-11
Owner: coordinator
Status: RESOLVED (stack starting under an isolated project)

## The conflict

First `up -d` attempt (default project `du-rework`) failed at the last service:

```
Error response from daemon: failed to set up container networking:
driver failed programming external connectivity on endpoint du-rework-orchestrator-1:
Bind for 127.0.0.1:3300 failed: port is already allocated
```

Everything before it had succeeded: postgres healthy, valkey healthy,
`migrate` **Exited (0)**, connector healthy.

## Who owns the ports

`netstat -ano` showed both 3300 and 3301 held by PID 6500, which `tasklist`
identifies as `com.docker.backend.exe` — i.e. a published container port, not a
bare process. `docker ps -a` named the holder:

```
arch-phase-b-20261006-orchestrator-1   Up 5 days (healthy)
    127.0.0.1:3300->3000/tcp, 127.0.0.1:3301->3001/tcp
```

That is another lane's stack, running and healthy for 5 days.

## Decision: isolate, do not destroy

Killing it would have destroyed a peer lane's live containers — an outward-facing,
hard-to-reverse action on work that is not mine. The coordinator contract also
forbids auto-reverting shared state. So the conflict was resolved by moving MY
stack, not theirs.

This also turns out to be required rather than merely polite: the live suite
`tests/deployment/smoke.cjs:10` refuses any project not starting with `du-fix-`,
so an isolated project was needed anyway.

## How

Two levers, neither of which touches secrets or another lane:

1. **Project name** — `-p du-fix-e2e-20261011`. Satisfies the `du-fix-` guard and
   keeps every container name namespaced away from the peer stacks.
2. **Host ports** — shell env overrides, verified against the rendered model
   before committing to them:

```
ORCHESTRATOR_PORT=13300 ADMIN_SHELL_PORT=13301 docker compose ... config
published=[["127.0.0.1","13300",3000],["127.0.0.1","13301",3001]]
PORT=3000 ORCHESTRATOR_PORT=3000
```

Note the container-internal `PORT`/`ORCHESTRATOR_PORT` stay `3000`; only the
host-side published numbers move. That is the correct seam — the container keeps
listening on 3000 and the host mapping becomes 13300->3000.

Also set `DU_IMAGE_TAG=e2e-20261011` so the isolated stack gets its own images
rather than sharing `du-*:local` with the default project.

## Peer stacks observed and left untouched

| Stack | Age | Action |
|---|---|---|
| `arch-phase-b-20261006-*` | 5 days | untouched (owns 3300/3301) |
| `du-orchestrator-local-*` | 7 hours | untouched |
| `du-wfa-20261007-*` | 4 days | untouched |
| `du-request-controls-20261006` | exited | untouched |

## Note on the first attempt's leftovers

The failed `up -d` left `du-rework-*` containers in `Created` state (orchestrator,
document-core, lc-checker, example-review) plus healthy postgres/valkey/connector
and an exited migrate. These are this session's own leftovers, not a peer's.
They are left in place rather than force-removed; the isolated project does not
need them, and removing them is not required for the E2E run.