# R1-C network-boundaries harness kit (BR-Q3-01)

Single source of truth for the Network & Secret boundaries offline harness planned in
`coordination/reports/qwen3.md ## W49-Q3-2 sec.6`. Test suites in
`services/connector`, `services/orchestrator`, `packages/connector-client`, `packages/worker-sdk`
consume these modules via relative imports. The kit imports only Node built-ins — no package deps.

Rules the kit enforces:
1. never monkeypatch `globalThis.fetch` (only production injectable seams + real loopback listeners);
2. listeners are the negative oracle (`requests === 0` == deny-before-connect) and the byte/abort
   witness (`bytesWritten`, `closedWithoutFinish`);
3. sentinels are redactor-invisible by construction (charset) and each suite self-checks against
   the real `redactString`;
4. every case is labeled `[LOCK]` (green, regression pin) or was `[OPEN:<row>]` (red on purpose
   until the fix landed). STATUS 2026-09-25 (report W49-Q3-4): all source boundaries landed —
   every former `[OPEN]` case was renamed `[LOCK:<row>]` and the whole matrix runs green inside the
   default suite paths (79/79 as of cycle-84 §W49-Q3-5: connector 41 — includes 2 lane-added pinning
   cases — orchestrator 25, connector-client 7, worker-sdk 6). A future regression of these rows is now a hard red, not a
   "expected red".

Run all suites: `node tests/harness/network-boundaries/verify-r1c.cjs` from `du-rework/`.
Per suite: `pnpm --dir <pkg> exec jest <file> --runInBand` (file names end in `.boundary.test.ts`).

DB/Redis: none of these suites may touch PostgreSQL :5433 or Redis :6380 — unscripted DNS
(`fake-resolver`) and the recording transports exist to make accidental egress fail loudly.

## Known measurement pitfalls (measured 2026-09-25 by the R1-C suites)

1. **Windows port re-bind + undici keep-alive**: a `BoundaryListener` just `stop()`ped can have its
   port re-handed to the NEXT listener; the undici pool then serves a dead socket and the request
   rejects instantly with `requests === 0`. Mitigation pattern (stable over 5 runs, see
   `packages/connector-client/tests/network-boundaries.boundary.test.ts` `timedLoopback`): retry only
   attempts the listener never witnessed; prefer stopping listeners in `afterAll` unless the stop is
   functionally part of the test.
2. **`pulled === 0` needs `highWaterMark: 0`**: `new Response(stream)` with default HWM 1 locks the
   stream and the WHATWG machinery calls `pull()` once on its own (measured Node 22). A
   "body-never-touched" precheck assertion is only meaningful with
   `queuingStrategy { highWaterMark: 0 }` — pair it with a liveness control (lying-CL header →
   `pulled > 0`) so it can never pass vacuously.
3. **pnpm on win32 noise**: when jest exits non-zero, `pnpm exec jest` additionally prints
   `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "jest" not found` — the suite DID run; trust the
   literal `Tests:` line, which `verify-r1c.cjs` parses.
4. **`it.each(['a','b'])('%s', ([x]) => ...)` passes single CHARACTERS silently** (measured
   2026-09-25, orchestrator suite) — a false-green generator for destructured params. Use an
   object table + `$field` titles instead.
5. **plain `http.request` must not receive TLS options**: passing `rejectUnauthorized`
   to `http.request` produced connect **ETIMEDOUT** on loopback (measured Node 22/Windows,
   probe-raw2 A/B) while the identical options without it connect. Keep `servername`/`rejectUnauthorized`
   inside an `https:`-only spread. CYCLE-101: now STRUCTURAL — `buildDialOptions()`
   is an exported pure function and unit-tested (`'servername' in httpOpts === false`).
6. **`@du/egress` consumers read its BUILT dist** (no jest mapper anywhere): after editing
   `packages/egress/src`, run `pnpm --dir packages/egress build` BEFORE any consumer suite,
   or tests measure a stale socket layer.
7. **`error-envelope.ts` treats `undefined` values as absent** (2026-09-25 fix): `problem()`
   always sets every key, so `'errors' in obj` misfires on raw envelopes; wire form
   (`JSON.parse(JSON.stringify(x))`) remains the canonical assertion target.
8. **JS `Date` cannot round-trip PG `timestamptz` microsecond precision** (cycle-100, witnessed
   LIVE): `RETURNING next_at` parsed to a ms-Date and re-bound via `AND next_at=$2` NEVER matches —
   every legitimate release lost its own fence. Carry lease tokens as `::text` and compare via
   `$n::timestamptz`. Scripted-db offline twins with string tokens structurally CANNOT catch this —
   one reason RR live runs exist.
9. **check the DB port before any attempt-run of a `.live`/`.integration` file**: an accidental
   live execution against an up-but-unclaimed :5433 is a protocol breach even when the test
   self-cleans (cycle-100 disclosure). `Test-NetConnection 127.0.0.1 -Port 5433` first.
10. **another lane rebuilding `@du/observability`/contract dists mid-verify can flake two suites
    red inside `verify-r1c` while standalone is green** (observed 3x 2026-09-25): re-run
    standalone before debugging your own code.
