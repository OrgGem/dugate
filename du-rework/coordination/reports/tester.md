# Tester report ??? W48-A6fb2

- DB window CLAIM: 2026-09-25 00:03:31.987 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 00:03:42.889 +07:00 (Asia/Bangkok, +07:00)
- Working directory: `D:\Git\dugate\du-rework`
- Command per run: `$env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
- Runs were executed sequentially, with no test invocation between them.
- Summary: all three runs exited 1 with the MM-05c assertion failing (5 passed, 1 failed). The response was `{"status":"ok","db":true,"redis":true,"activeLeases":0}`, which did not match `/HEALTHY/i`.
- Run 1 additionally reported `connect EADDRINUSE 127.0.0.1:5433` in `afterAll` while dropping the isolated schema.

## Run 1

- ExitCode: 1

Raw output:

```text
FAIL tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts
  ?—? P8-02b: Redis-loss-before-claim drill (MM-05) + same-epoch fault injection (MM-10) ??? MM-05c (characterization of the OPEN defect): health reports HEALTHY with queue data wiped ??? durable health missing

    expect(received).toMatch(expected)

    Expected pattern: /HEALTHY/i
    Received string:  "{\"status\":\"ok\",\"db\":true,\"redis\":true,\"activeLeases\":0}"

      292 |       // platform implements durable health, this probe must be flipped to assert a
      293 |       // DEGRADED/unhealthy signal while queue data is gone ??? tracking MM-05 closure.
    > 294 |       expect(JSON.stringify(health.body)).toMatch(/HEALTHY/i);
          |                                           ^
      295 |     }, 25_000);
      296 |
      297 |     // ---------------------------------------------------------------------

      at Object.<anonymous> (p8-02b-redisloss-sameepoch-fault.integration.test.ts:294:43)


  ?—? Test suite failed to run

    connect EADDRINUSE 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02b-redisloss-sameepoch-fault.integration.test.ts:173:9)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 5 passed, 6 total
Snapshots:   0 total
Time:        1.537 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

## Run 2

- ExitCode: 1

Raw output:

```text
FAIL tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts
  ?—? P8-02b: Redis-loss-before-claim drill (MM-05) + same-epoch fault injection (MM-10) ??? MM-05c (characterization of the OPEN defect): health reports HEALTHY with queue data wiped ??? durable health missing

    expect(received).toMatch(expected)

    Expected pattern: /HEALTHY/i
    Received string:  "{\"status\":\"ok\",\"db\":true,\"redis\":true,\"activeLeases\":0}"

      292 |       // platform implements durable health, this probe must be flipped to assert a
      293 |       // DEGRADED/unhealthy signal while queue data is gone ??? tracking MM-05 closure.
    > 294 |       expect(JSON.stringify(health.body)).toMatch(/HEALTHY/i);
          |                                           ^
      295 |     }, 25_000);
      296 |
      297 |     // ---------------------------------------------------------------------

      at Object.<anonymous> (p8-02b-redisloss-sameepoch-fault.integration.test.ts:294:43)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 5 passed, 6 total
Snapshots:   0 total
Time:        1.751 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

## Run 3

- ExitCode: 1

Raw output:

```text
FAIL tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts
  ?—? P8-02b: Redis-loss-before-claim drill (MM-05) + same-epoch fault injection (MM-10) ??? MM-05c (characterization of the OPEN defect): health reports HEALTHY with queue data wiped ??? durable health missing

    expect(received).toMatch(expected)

    Expected pattern: /HEALTHY/i
    Received string:  "{\"status\":\"ok\",\"db\":true,\"redis\":true,\"activeLeases\":0}"

      292 |       // platform implements durable health, this probe must be flipped to assert a
      293 |       // DEGRADED/unhealthy signal while queue data is gone ??? tracking MM-05 closure.
    > 294 |       expect(JSON.stringify(health.body)).toMatch(/HEALTHY/i);
          |                                           ^
      295 |     }, 25_000);
      296 |
      297 |     // ---------------------------------------------------------------------

      at Object.<anonymous> (p8-02b-redisloss-sameepoch-fault.integration.test.ts:294:43)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 5 passed, 6 total
Snapshots:   0 total
Time:        1.622 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

## W48-A6fb3 ??? Round 3 (Qwen-2 MM-05c fix)

- DB window CLAIM: 2026-09-25 00:13:09.819 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 00:13:21.008 +07:00 (Asia/Bangkok, +07:00)
- Working directory: `D:\Git\dugate\du-rework`
- Command per run: `$env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
- Runs were executed sequentially, with no test invocation between them.

### Run 1

- ExitCode: 0

Raw output:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        1.577 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

### Run 2

- ExitCode: 0

Raw output:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        1.652 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

### Run 3

- ExitCode: 0

Raw output:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        1.598 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

## W48-C1 ??? admin-audit.test.ts (Claude Code request)

- DB window CLAIM: 2026-09-25 00:51:33.971 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 00:51:54.963 +07:00 (Asia/Bangkok, +07:00)
- DB endpoints: PostgreSQL :5433, Redis :6380
- Working directory: `D:\Git\dugate\du-rework\services\orchestrator`
- Command per run: `npx jest tests/admin-audit.test.ts --runInBand`
- Runs were executed sequentially, with no test invocation between them.

### Run 1

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts (7.281 s)
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (77 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (30 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (47 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        7.712 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

### Run 2

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (52 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (24 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (52 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        2.567 s, estimated 8 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

### Run 3

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (44 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (14 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (40 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        2.487 s, estimated 3 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

## RUN REQUEST #2 ??? admin-audit.test.ts (taxonomy apikey.profile_bind)

- DB window CLAIM: 2026-09-25 01:21:25.496 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 01:21:45.143 +07:00 (Asia/Bangkok, +07:00)
- DB endpoints: PostgreSQL :5433, Redis :6380
- Working directory: `D:\Git\dugate\du-rework\services\orchestrator`
- Command per run: `npx jest tests/admin-audit.test.ts --runInBand`
- Runs were executed sequentially, with no test invocation between them.
- Test taxonomy verified before the run: `apikey.profile_bind`.

### Run 1

- ExitCode: 1

Raw output:

```text
FAIL tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ?— 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (360 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (51 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (58 ms)

  ?—? W48-C1: real admin audit ledger ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list)

    TypeError: fetch failed

      120 |
      121 | async function postBinding(rawKey: string): Promise<unknown> {
    > 122 |   const res = await fetch(`${baseUrl}/api/v1/admin/profile-bindings`, {
          |               ^
      123 |     method: 'POST',
      124 |     headers: adminHeaders(),
      125 |     body: JSON.stringify({

      at postBinding (tests/admin-audit.test.ts:122:15)
      at Object.<anonymous> (tests/admin-audit.test.ts:146:5)

    Cause:
    connect ETIMEDOUT 127.0.0.1:60968



Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
Snapshots:   0 total
Time:        5.202 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

### Run 2

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (51 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (22 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (58 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        3.069 s, estimated 5 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

### Run 3

- ExitCode: 1

Raw output:

```text
FAIL tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ?— 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (394 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (50 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (58 ms)

  ?—? W48-C1: real admin audit ledger ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list)

    TypeError: fetch failed

      120 |
      121 | async function postBinding(rawKey: string): Promise<unknown> {
    > 122 |   const res = await fetch(`${baseUrl}/api/v1/admin/profile-bindings`, {
          |               ^
      123 |     method: 'POST',
      124 |     headers: adminHeaders(),
      125 |     body: JSON.stringify({

      at postBinding (tests/admin-audit.test.ts:122:15)
      at Object.<anonymous> (tests/admin-audit.test.ts:146:5)

    Cause:
    connect ETIMEDOUT 127.0.0.1:60998



Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
Snapshots:   0 total
Time:        3.288 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

## RUN REQUEST #3 ??? W48-C1 admin-audit retry change

- DB window CLAIM: exact timestamp not recoverable; claim preceded Run 1.
- DB window RELEASE: exact timestamp not recoverable; release followed Run 3.
- Timestamp note: the run wrapper captured these values, but its report append failed after RELEASE before they were persisted; values are not estimated.
- DB endpoints: PostgreSQL :5433, Redis :6380
- Working directory: `D:\Git\dugate\du-rework\services\orchestrator`
- Command per run: `npx jest tests/admin-audit.test.ts --runInBand`
- Runs were executed sequentially, with no test invocation between them.
- Pre-run source check: network fetch retry loop is capped at 3 attempts with 500 ms delay.

### Run 1

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (51 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (16 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (38 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        3.701 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

### Run 2

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (42 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (20 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (41 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        2.863 s, estimated 4 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

### Run 3

- ExitCode: 0

Raw output:

```text
PASS tests/admin-audit.test.ts
  W48-C1: real admin audit ledger
    ??? 1. an admin mutation produces a REAL audit row (no placeholder, no empty list) (55 ms)
    ??? 2. tenant A cannot read tenant B events (tenant predicate, not just client filter) (18 ms)
    ??? 3. limit is respected (previously parsed then discarded via `void limit`) (46 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        3.018 s, estimated 5 s
Ran all test suites matching /tests\\admin-audit.test.ts/i.

```

## RUN REQUEST W48-A6fb4 ??? P8-02b round 4

- DB window CLAIM: 2026-09-25 02:11:22.588 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 02:11:40.517 +07:00 (Asia/Bangkok, +07:00)
- DB endpoints: PostgreSQL :5433, Redis :6380
- Working directory: `D:\Git\dugate\du-rework`
- Command per run: `$env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
- Runs were executed sequentially, with no test invocation between them.
- Pre-run source check: MM-10b expects HTTP 410 with code `TASK_TERMINAL`.

### Run 1

- ExitCode: 0

Raw output:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        2.892 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

### Run 2

- ExitCode: 0

Raw output:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        2.442 s, estimated 3 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

### Run 3

- ExitCode: 0

Raw output:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        2.388 s, estimated 3 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.

```

## RUN REQUEST W48-A6fb5 ??? v??ng 5, P8-02 guard-order companion checks

- DB window CLAIM: 2026-09-25 03:11:51.114 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 03:12:13.880 +07:00 (Asia/Bangkok, +07:00)
- DB endpoints: PostgreSQL :5433, Redis :6380
- Suites ran sequentially in one DB window; Suite 2 used `npx` as specified in `docs/29-run-request-queue.md`.
- Expected: Suite 1 20/20; Suite 2 97/97; both ExitCode 0.

### Suite 1

- Working directory: `D:\Git\dugate\du-rework`
- Command: `$env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02-fault-recovery.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
- ExitCode: 1

Literal raw output:

```text
FAIL tests/integration/p8-02-fault-recovery.integration.test.ts
  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? submission transaction boundary failure leaves zero half-written operation or task state

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? child spawn transaction boundary failure rolls back and prevents parent task state drift

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? task report success transaction boundary failure rolls back and leaves task and operation RUNNING

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? artifact upload transaction boundary failure leaves no orphan unreferenced artifact metadata (ART-02)

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? crashed worker lease expiry is detected by sweeper: re-dispatched and old epoch fenced

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? replacement worker successfully executes lease takeover

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? zombie worker heartbeat after lease takeover is rejected with 409 LEASE_LOST

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? zombie worker writes during active takeover lease are rejected with 409 LEASE_LOST

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? replacement worker completes task and subsequent writes return 410 TASK_TERMINAL

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? cancelling operation cancels running task and open human wait atomically

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? stale heartbeat on cancelled task is rejected with 409 LEASE_LOST

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? cancelled task cannot be claimed by another worker (fencing)

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? cancelled worker cannot report completion or yield child tasks (fencing)

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? duplicate submission delivery with identical Idempotency-Key returns replayed=true with zero duplicate rows

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? duplicate submission delivery with mismatched payload fails with 409 IDEMPOTENCY_CONFLICT

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? duplicate resume delivery on human wait converges to single answer with CAS protection (RUN-06)

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? stale or duplicate resume after cancellation is rejected with 409 STATE_CONFLICT

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 5. Deadline Sweep & Crash Recovery Under Real Failure Injection ??? deadline sweeper marks expired operations TIMED_OUT and cancels tasks atomically

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 5. Deadline Sweep & Crash Recovery Under Real Failure Injection ??? subsequent deadline sweep is idempotent and sweeps 0 operations

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 5. Deadline Sweep & Crash Recovery Under Real Failure Injection ??? shutdown graceful drain rejects new claims with 503 SHUTTING_DOWN (OPS-07)

    TypeError: fetch failed

      93 |   opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
      94 | ): Promise<HttpResult> {
    > 95 |   const res = await fetch(`${base}${path}`, {
         |               ^
      96 |     method: opts.method ?? 'GET',
      97 |     headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      98 |     body: opts.body === undefined ? undefined : JSON.stringify(opts.body),

      at http (p8-02-fault-recovery.integration.test.ts:95:15)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:157:20)

    Cause:
        connect ETIMEDOUT 127.0.0.1:54382

Test Suites: 1 failed, 1 total
Tests:       20 failed, 20 total
Snapshots:   0 total
Time:        3.688 s, estimated 4 s
Ran all test suites matching tests/integration/p8-02-fault-recovery.integration.test.ts.

```


## RUN REQUEST W48-A6fb6 ??? v??ng 6, P8-02 guard-order re-run

### Prerun checks (before DB claim)

- `NO_PROXY=127.0.0.1,localhost`; `npx tsc --noEmit -p tsconfig.json` in `services/orchestrator` ??? ExitCode 0, no output.
- `netsh int ipv4 show excludedportrange protocol=tcp` ??? ExitCode 0; listed ranges do not include port 54382, so no `winnat` restart was performed.

Literal raw port-exclusion output:

```text

Protocol tcp Port Exclusion Ranges

Start Port    End Port      
----------    --------      
        80          80      
       443         443      
      2323        2323      
      5357        5357      
     49286       49385      
     49737       49836      
     50000       50059     *
     50160       50259      
     50260       50359      
     51466       51565      
     56760       56859      

* - Administered port exclusions.

```

- DB window CLAIM: 2026-09-25 03:42:39.789 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 03:42:42.928 +07:00 (Asia/Bangkok, +07:00)
- DB endpoints: PostgreSQL :5433, Redis :6380
- Working directory: `D:\Git\dugate\du-rework`
- Command: `$env:NO_PROXY = '127.0.0.1,localhost'; $env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02-fault-recovery.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
- Expected: 20 passed / 20 total, ExitCode 0; stale heartbeat on cancelled task must return 409 LEASE_LOST.
- ExitCode: 1
- Observed: all 20 cases failed during DB connection setup with ECONNREFUSED 127.0.0.1:5433; the :603 assertion was not reached.

Literal raw test output:

```text
FAIL tests/integration/p8-02-fault-recovery.integration.test.ts
  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? submission transaction boundary failure leaves zero half-written operation or task state

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? child spawn transaction boundary failure rolls back and prevents parent task state drift

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? task report success transaction boundary failure rolls back and leaves task and operation RUNNING

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 1. Transaction Boundary Fault Invariants (Zero Half-Written State) ??? artifact upload transaction boundary failure leaves no orphan unreferenced artifact metadata (ART-02)

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? crashed worker lease expiry is detected by sweeper: re-dispatched and old epoch fenced

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? replacement worker successfully executes lease takeover

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? zombie worker heartbeat after lease takeover is rejected with 409 LEASE_LOST

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? zombie worker writes during active takeover lease are rejected with 409 LEASE_LOST

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 2. Crashed Worker Cannot Keep Leases & Lease Takeover ??? replacement worker completes task and subsequent writes return 410 TASK_TERMINAL

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? cancelling operation cancels running task and open human wait atomically

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? stale heartbeat on cancelled task is rejected with 409 LEASE_LOST

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? cancelled task cannot be claimed by another worker (fencing)

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 3. Cancelled Worker Cannot Keep Leases & Fencing ??? cancelled worker cannot report completion or yield child tasks (fencing)

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? duplicate submission delivery with identical Idempotency-Key returns replayed=true with zero duplicate rows

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? duplicate submission delivery with mismatched payload fails with 409 IDEMPOTENCY_CONFLICT

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? duplicate resume delivery on human wait converges to single answer with CAS protection (RUN-06)

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 4. Duplicate Delivery Converges to One Effect ??? stale or duplicate resume after cancellation is rejected with 409 STATE_CONFLICT

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 5. Deadline Sweep & Crash Recovery Under Real Failure Injection ??? deadline sweeper marks expired operations TIMED_OUT and cancels tasks atomically

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 5. Deadline Sweep & Crash Recovery Under Real Failure Injection ??? subsequent deadline sweep is idempotent and sweeps 0 operations

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)

  ?—? P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02) ??? 5. Deadline Sweep & Crash Recovery Under Real Failure Injection ??? shutdown graceful drain rejects new claims with 503 SHUTTING_DOWN (OPS-07)

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:124:7)


  ?—? Test suite failed to run

    connect ECONNREFUSED 127.0.0.1:5433

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:24)
      at Object.<anonymous> (p8-02-fault-recovery.integration.test.ts:172:7)

Test Suites: 1 failed, 1 total
Tests:       20 failed, 20 total
Snapshots:   0 total
Time:        0.953 s, estimated 4 s
Ran all test suites matching tests/integration/p8-02-fault-recovery.integration.test.ts.

```

## RUN REQUEST W48-A6fb7 ??? v??ng 6b, P8-02 with infra-up

### Prerun step 0 ??? infra

- `docker compose -f infra/docker-compose.yml up -d` ExitCode: 0.
```text
Network du-rework-test_default  Creating
Network du-rework-test_default  Created
Container du-rework-postgres  Creating
Container du-rework-redis  Creating
Container du-rework-redis  Created
Container du-rework-postgres  Created
Container du-rework-redis  Starting
Container du-rework-postgres  Starting
Container du-rework-redis  Started
Container du-rework-postgres  Started
```

- `docker compose -f infra/docker-compose.yml ps` ExitCode: 0; both containers `Up (healthy)`.
```text
NAME                 IMAGE                COMMAND                  SERVICE    CREATED         STATUS                   PORTS
du-rework-postgres   postgres:16-alpine   "docker-entrypoint.s???"   postgres   6 seconds ago   Up 5 seconds (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
du-rework-redis      redis:7-alpine       "docker-entrypoint.s???"   redis      6 seconds ago   Up 5 seconds (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
```

### Prerun steps 1???2

- TCP sanity ExitCode: 0.
```text
PostgreSQL_5433=True
Redis_6380=True
```

- `NO_PROXY=127.0.0.1,localhost`; `npx tsc --noEmit -p tsconfig.json` in `services/orchestrator` ??? ExitCode 0, no output.

- DB window CLAIM: 2026-09-25 04:03:25.613 +07:00 (Asia/Bangkok, +07:00)
- DB window RELEASE: 2026-09-25 04:03:30.680 +07:00 (Asia/Bangkok, +07:00)
- DB endpoints: PostgreSQL :5433, Redis :6380
- Working directory: `D:\Git\dugate\du-rework`
- Command: `$env:NO_PROXY = '127.0.0.1,localhost'; $env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02-fault-recovery.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
- Expected: 20 passed / 20 total, ExitCode 0.
- Assertion :603, lines 610???611: source expects HTTP 409 and body `LEASE_LOST`; the 20/20 suite pass means this assertion passed. Jest's default output contained only the suite summary, with no per-test line.
- ExitCode: 0

Literal raw test output:

```text
Test Suites: 1 passed, 1 total
Tests:       20 passed, 20 total
Snapshots:   0 total
Time:        2.259 s
Ran all test suites matching tests/integration/p8-02-fault-recovery.integration.test.ts.

```

### Suite 2

- Working directory: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest tests/runtime.test.ts --runInBand`
- ExitCode: 0

Literal raw output:

```text
{"ts":"2026-09-24T20:12:05.987Z","level":"error","component":"orchestrator","msg":"unhandled request error","errorName":"object","correlationId":"e30e49b4-49f4-4a70-b3a8-99d9dcdf8ed1","pathname":"/api/runtime/v1/tasks/73175cab-6969-4d42-ab71-65e6e68f1e98/invocation-grants"}
PASS tests/runtime.test.ts (13.247 s)
  runtime vertical slice (isolated PG/Redis)
    ??? submit ??? outbox ??? dispatch ??? claim ??? heartbeat ??? checkpoint ??? complete ??? result (197 ms)
    ??? idempotency: same key + same body replays, different body ??? 409 (47 ms)
    ??? lease expiry allows reclaim by another worker (68 ms)
    ??? fail retryable enqueues continuation with future due_at; dispatch respects due_at (73 ms)
    ??? input validation returns 422 on bad submission (7 ms)
    ??? runtime auth rejects missing token (30 ms)
    ??? usage ingest accepts the Connector single-event shape with dedicated auth (28 ms)
    ??? usage batch projects totals and identical replay is a duplicate (46 ms)
    ??? same usage event ID with a conflicting payload returns 409 without changing totals (36 ms)
    ??? usage task must belong to the supplied operation and a rejected batch is atomic (38 ms)
    ??? usage arriving after terminal completion is reflected in the result (77 ms)
    ??? cancel is tenant-scoped, idempotent, and terminals the task (37 ms)
    ??? cancel of an unknown operation returns 404 (4 ms)
    ??? deadline sweeper times out past-due operations and cancels their tasks (39 ms)
    ??? deadline sweeper ignores operations whose deadline is in the future (21 ms)
    ??? cancel and sweep-deadlines reject missing auth (16 ms)
    ??? R08-01: unknown and revoked API keys are denied fail-closed (13 ms)
    ??? R08-01: admin and runtime credentials cannot substitute for each other (33 ms)
    ??? R08-01/W11-C1: unsafe credential configuration is rejected, not silently weakened (225 ms)
    ??? R08-02/W11-C1: invocation grants carry stable identity, replay the same ID, and conflict on differing hash (132 ms)
    ??? W12-C: expired lease cannot mint a grant even before sweep/reclaim (39 ms)
    ??? W12-C: concurrent identical grant requests converge on one identity and one row (171 ms)
    ??? W12-C: an action declaring no connector slots grants no slot (fail closed) (75 ms)
    ??? W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued (20 ms)
    ??? W13-C: pinned operations grant the pinned connector, and claims carry the pin (70 ms)
    ??? W13-C/PRF-02: a revision change mid-operation keeps the in-flight pin; new submissions pin the new revision (112 ms)
    ??? W13-C: a manifest-declared slot missing from the operation pin is denied (BINDING_DENIED) (60 ms)
    ??? W13-C/children: spawn ??? WAITING_CHILDREN ??? GET children ??? join completes exactly once (124 ms)
    ??? W13-C/children: concurrent completions emit exactly one parent continuation (127 ms)
    ??? W13-C/children: one child failure fails the parent join and cancels siblings (118 ms)
    ??? W13-C/children: spawn rejects stale lease, unknown kind, overlap, and capacity (182 ms)
    ??? W13-C/children: spawn on a terminal task is 410 TASK_TERMINAL (60 ms)
    ??? W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues (144 ms)
    ??? W13-C/resume: unknown wait ??? 404, terminal operation ??? 409, cross-tenant ??? 404 (116 ms)
    ??? W13-C/wait-input: rejects stale lease and terminal task (79 ms)
    ??? W13-C: continuation GET rejects missing runtime auth (3 ms)
    ??? W27-C/cancel: terminal operation closes OPEN human_waits to CANCELLED; no dispatch (92 ms)
    ??? W27-C/deadline: sweep closes OPEN human_waits to EXPIRED (103 ms)
    ??? W27-C/cancel-resume race: resume wins before cancel; wait is ANSWERED then closed (115 ms)
    ??? W27-C/repeated cancel: idempotent with no duplicate dispatch or state churn (109 ms)
  W28-C: version activation / drain / rollback
    ??? activate v2: new submissions select v2, in-flight v1 stays pinned (67 ms)
    ??? activate v1 rollback: re-activating v1 redirects new submissions back to v1 (33 ms)
    ??? drain v2: fail-closed when sole active version is drained; explicit re-activate restores (74 ms)
    ??? activate invalid version ??? 404 (6 ms)
    ??? activate rejects missing admin auth (401) (2 ms)
    ??? concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3) (25 ms)
    ??? activate is idempotent: re-activating the active version returns 200 replayed (19 ms)
  W29-C: Admin authorization negative tests
    ??? enable rejects missing admin auth (401) (2 ms)
    ??? deactivate rejects missing admin auth (401) (2 ms)
    ??? profile-bindings rejects missing admin auth (401) (2 ms)
    ??? enable rejects runtime token (401) ??? role substitution denied (1 ms)
    ??? enable on unregistered version ??? 404 NOT_FOUND (W29-C fix) (2 ms)
    ??? cross-tenant cancel ??? 404 (no information leakage) (37 ms)
    ??? cross-tenant resume ??? 404 (no information leakage) (24 ms)
  W30-C: expired-lease recovery
    ??? expired RUNNING task is recovered: re-dispatched via outbox, old epoch fenced (83 ms)
    ??? unexpired lease is not touched by sweep (61 ms)
    ??? READY task with NULL lease is excluded (idle, not crashed) (24 ms)
    ??? WAITING_INPUT and WAITING_CHILDREN tasks are excluded (30 ms)
    ??? terminal operation excludes a RUNNING task from sweep (14 ms)
    ??? terminal task (FAILED) with stale lease is excluded (18 ms)
    ??? budget exhaustion: expired lease with attempt >= max_attempts ??? terminal FAIL (26 ms)
    ??? repeated sweep is idempotent: second sweep touches nothing (67 ms)
    ??? production hook: listen() starts interval sweep that recovers without explicit call (675 ms)
  W32-C: webhook delivery outbox & dispatch
    ??? callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row (47 ms)
    ??? no callback_url ??? no webhook row on terminal transition (47 ms)
    ??? terminal FAILED via failTask schedules a webhook (48 ms)
    ??? terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate (37 ms)
    ??? terminal TIMED_OUT via deadline sweep schedules a webhook (34 ms)
    ??? signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection (1 ms)
    ??? dispatcher: successful delivery marks DELIVERED with correct signed headers (64 ms)
    ??? dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected (66 ms)
    ??? dispatcher: idempotent ??? no due rows means no attempts; delivered rows stay delivered (54 ms)
  W36-C: operations status & result facade
    ??? toOperationView: canonical shape includes name, links, progress (1 ms)
    ??? isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal
    ??? resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others
    ??? waitForTerminal: returns immediately for terminal op (46 ms)
    ??? GET /operations/:id: returns canonical OperationView with name, links, progress (18 ms)
    ??? GET /operations/:id: non-existent returns 404 (2 ms)
    ??? GET /operations/:id/result: SUCCEEDED returns ResultEnvelope (57 ms)
    ??? GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT (18 ms)
    ??? GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT (26 ms)
    ??? GET /operations/:id/result: TIMED_OUT returns 410 GONE (32 ms)
    ??? GET /operations/:id/result: non-existent returns 404 (6 ms)
    ??? ?wait=0 or absent: returns immediately (no blocking) (18 ms)
    ??? ?wait=5: long-poll holds until operation reaches SUCCEEDED (533 ms)
    ??? ?wait=1: timeout returns current (non-terminal) state (1029 ms)
  W37-C: P2-06 composite ??? children, human wait, deadline, cancel
    ??? RUN-05 composite: fan-out ??? children complete ??? join closes ??? parent resumes to terminal SUCCEEDED (163 ms)
    ??? RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock (103 ms)
    ??? RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED (118 ms)
    ??? RUN-06 composite: wait OPEN ??? resume ANSWERED ??? task QUEUED ??? completion SUCCEEDED (132 ms)
    ??? RUN-06 composite: unknown wait ??? 404; terminal operation resume ??? 409 (127 ms)
    ??? RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation (89 ms)
    ??? RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed) (89 ms)
  W38-A6: P2-09 health and graceful shutdown
    ??? health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases (69 ms)
    ??? health endpoint returns 503 degraded when DB or Redis is unreachable (9 ms)
    ??? drain stops accepting new claims and close() waits for active leases to complete (295 ms)
    ??? graceful shutdown force-closes when active lease exceeds timeout (294 ms)

Test Suites: 1 passed, 1 total
Tests:       97 passed, 97 total
Snapshots:   0 total
Time:        13.487 s
Ran all test suites matching /tests\\runtime.test.ts/i.

```

## W48-A6fb8 ??? Round 7: P8-02c MM-05 READY-rearm live suite

Run request: `docs/29-run-request-queue.md:883`. The required gate was `DU_MM05_REARM=1`.

### Prerun

- `docker compose -f infra/docker-compose.yml ps`: 2/2 healthy before the DB window (PostgreSQL :5433 and Redis :6380).
- In `services/orchestrator`, `npm run build && npx tsc --noEmit -p tsconfig.json`: ExitCode 0.
- Build output:
  ```text
  > @du/orchestrator@0.1.0 build
  > tsc -p tsconfig.json
  ```
- Typecheck produced no output; ExitCode 0.

### DB window

- CLAIM: 2026-09-25 04:40:50.683 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 04:46:28.722 +07:00 (Asia/Bangkok).
- The same exclusive window covered the three counted suite invocations below. No `docker compose down` command was run.
- Post-release `docker compose -f infra/docker-compose.yml ps`: both containers remained Up (healthy).

### Results

All three runs hit the same migration failure before app startup, so the MM-05 re-arm assertions were not reached. The cause is visible in the migration directory: both `0011_admin_audit.sql` and `0011_artifact_finalize_epoch.sql` map to sequence 11, while `schema_migrations.sequence` is a primary key. The second sequence-11 insert fails with `duplicate key value violates unique constraint "schema_migrations_pkey"`.

1. **Run 1 ??? exact requested command.** Test summary: 1 suite failed; 5 failed, 5 total. Jest printed its open-handle warning and did not exit. The verified Jest process was stopped after the completed summary; tool session ExitCode was -1 (forced termination), so no normal shell ExitCode was available. The suite result itself is failure (Jest failure status 1).
2. **Run 2 ??? same suite and env, with `--forceExit` appended only to make Jest return after its open-handle warning.** ExitCode: 1. Summary: 1 suite failed; 5 failed, 5 total.
3. **Run 3 ??? same as Run 2.** ExitCode: 1. Summary: 1 suite failed; 5 failed, 5 total.

For Runs 2???3, the exact requested test selection/configuration and live-infra gates were preserved; `--forceExit` affected process shutdown only. Raw output is recorded verbatim below.

#### Run 1 raw output

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-0 (meta): docs/38 ??7 surface landed ??? runtime sweep + health-cache seams are functions

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/src/server.ts:145:5)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-1 (E2E): Redis wipe before claim ??? sweep re-arms ??? dispatcher republishes SAME jobId ??? claim+complete ??? SUCCEEDED, zero TIMED_OUT, zero duplicate job

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/src/server.ts:145:5)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-2 (false-positive safety): aged row with LIVE job ??? sweep re-arms NOTHING; queue untouched

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/src/server.ts:145:5)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/src/server.ts:145:5)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-4 (MM-05c durable health): /health gains queueIntegrity {state,lastSweepAt} reflecting the sweep

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/src/server.ts:145:5)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

Test Suites: 1 failed, 1 total
Tests:       5 failed, 5 total
Snapshots:   0 total
Time:        1.389 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Jest did not exit one second after the test run has completed.

'This usually means that there are asynchronous operations that weren't stopped in your tests. Consider running Jest with `--detectOpenHandles` to troubleshoot this issue.
```

#### Run 2 raw output

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-0 (meta): docs/38 ??7 surface landed ??? runtime sweep + health-cache seams are functions

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-1 (E2E): Redis wipe before claim ??? sweep re-arms ??? dispatcher republishes SAME jobId ??? claim+complete ??? SUCCEEDED, zero TIMED_OUT, zero duplicate job

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-2 (false-positive safety): aged row with LIVE job ??? sweep re-arms NOTHING; queue untouched

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-4 (MM-05c durable health): /health gains queueIntegrity {state,lastSweepAt} reflecting the sweep

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

Test Suites: 1 failed, 1 total
Tests:       5 failed, 5 total
Snapshots:   0 total
Time:        1.505 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=1]
```

#### Run 3 raw output

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-0 (meta): docs/38 ??7 surface landed ??? runtime sweep + health-cache seams are functions

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-1 (E2E): Redis wipe before claim ??? sweep re-arms ??? dispatcher republishes SAME jobId ??? claim+complete ??? SUCCEEDED, zero TIMED_OUT, zero duplicate job

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-2 (false-positive safety): aged row with LIVE job ??? sweep re-arms NOTHING; queue untouched

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-4 (MM-05c durable health): /health gains queueIntegrity {state,lastSweepAt} reflecting the sweep

    error: duplicate key value violates unique constraint "schema_migrations_pkey"

      85 |         await db.tx(async (client) => {
      86 |             await client.query(file.sql);
    > 87 |             await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [file.sequence, file.filename]);
         |             ^
      88 |         });
      89 |         applied.push(file.filename);
      90 |     }

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at ../../services/orchestrator/dist/db/migrations.js:87:13
      at Object.tx (../../services/orchestrator/dist/db/db.js:15:32)
      at migrate (../../services/orchestrator/dist/db/migrations.js:85:9)
      at createApp (../../services/orchestrator/dist/server.js:69:9)
      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:170:11)

Test Suites: 1 failed, 1 total
Tests:       5 failed, 5 total
Snapshots:   0 total
Time:        1.147 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=1]
```

### Earlier interrupted harness attempt (excluded from the three runs above)

A preceding tool session hung without yielding a Jest summary or captured exit code and was stopped. Its CLAIM timestamp could not be recovered; RELEASE was recorded as 2026-09-25 04:38:07.440 +07:00. Since no literal test output or exit code was collected, it is excluded from the three counted runs.


## W48-A6fb8 ??? Cycle 84 rerun after migration hotfix

Qwen-1 renamed the colliding migration and rebuilt orchestrator dist. The migration directory was checked before the run: `0011_artifact_finalize_epoch.sql` and `0012_admin_idempotency.sql` are present, with no duplicate `0011` prefix.

### Exclusive DB window and reset

- CLAIM: 2026-09-25 05:11:18.651 +07:00 (Asia/Bangkok).
- `docker compose -f infra/docker-compose.yml down -v`: ExitCode 0, performed as explicitly requested for this run.
- `docker compose -f infra/docker-compose.yml up -d`: ExitCode 0.
- Both containers reached Up (healthy) before the test.
- RELEASE: 2026-09-25 05:12:04.485 +07:00 (Asia/Bangkok).
- Post-release status: both containers remain Up (healthy); infra was left running.

Literal reset/up output:

```text
DB_WINDOW_CLAIM=2026-09-25 05:11:18.651 +07:00
 Container du-rework-postgres  Stopping
 Container du-rework-redis  Stopping
 Container du-rework-redis  Stopped
 Container du-rework-redis  Removing
 Container du-rework-redis  Removed
 Container du-rework-postgres  Stopped
 Container du-rework-postgres  Removing
 Container du-rework-postgres  Removed
 Network du-rework-test_default  Removing
 Network du-rework-test_default  Removed
COMPOSE_DOWN_EXITCODE=0
 Network du-rework-test_default  Creating
 Network du-rework-test_default  Created
 Container du-rework-postgres  Creating
 Container du-rework-redis  Creating
 Container du-rework-redis  Created
 Container du-rework-postgres  Created
 Container du-rework-redis  Starting
 Container du-rework-postgres  Starting
 Container du-rework-postgres  Started
 Container du-rework-redis  Started
COMPOSE_UP_EXITCODE=0
NAME                 IMAGE                COMMAND                  SERVICE    CREATED                  STATUS                                     PORTS
du-rework-postgres   postgres:16-alpine   "docker-entrypoint.s???"   postgres   Less than a second ago   Up Less than a second (health: starting)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
du-rework-redis      redis:7-alpine       "docker-entrypoint.s???"   redis      Less than a second ago   Up Less than a second (health: starting)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
INFRA_HEALTHY=2/2
```

Healthy check before test:

```text
NAME                 IMAGE                COMMAND                  SERVICE    CREATED              STATUS                        PORTS
du-rework-postgres   postgres:16-alpine   "docker-entrypoint.s???"   postgres   About a minute ago   Up About a minute (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
du-rework-redis      redis:7-alpine       "docker-entrypoint.s???"   redis      About a minute ago   Up About a minute (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
```

### Round 7 test result

- Cwd: `D:\Git\dugate\du-rework`
- Environment: `NO_PROXY=127.0.0.1,localhost`, `DU_LIVE_INFRA=1`, `DU_MM05_REARM=1`.
- Command: `npx jest tests/integration/p8-02c-mm05-rearm.integration.test.ts --config tests/integration/jest.config.cjs --runInBand --forceExit`
- ExitCode: 1.
- Result: 1 failed, 4 passed, 5 total. The migration setup now completes; `rearm-1` fails at line 305 because `r1.rearmed` was 0 (expected at least 1). The other four tests passed.
- No test code or migration files were changed by the Tester.

Literal raw test output:

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-1 (E2E): Redis wipe before claim ??? sweep re-arms ??? dispatcher republishes SAME jobId ??? claim+complete ??? SUCCEEDED, zero TIMED_OUT, zero duplicate job

    expect(received).toBeGreaterThanOrEqual(expected)

    Expected: >= 1
    Received:    0

      303 |
      304 |     const r1 = await sweep();
    > 305 |     expect(r1.rearmed).toBeGreaterThanOrEqual(1); // ??2 detection + ??3 re-arm (CAS)
          |                        ^
      306 |     // The re-arm SQL sets due_at = now() + 2^attempts backoff ??? pin past the
      307 |     // scheduler wait deterministically instead of sleeping on it.
      308 |     await app!.db.query(`UPDATE outbox SET due_at = now() - interval '1 second' WHERE id = $1`, [outboxId]);

      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:305:24)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 4 passed, 5 total
Snapshots:   0 total
Time:        1.772 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=1]
```

DB-window RELEASE and post-release health check:

```text
DB_WINDOW_RELEASE=2026-09-25 05:12:04.485 +07:00
NAME                 IMAGE                COMMAND                  SERVICE    CREATED          STATUS                    PORTS
du-rework-postgres   postgres:16-alpine   "docker-entrypoint.s???"   postgres   44 seconds ago   Up 44 seconds (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
du-rework-redis      redis:7-alpine       "docker-entrypoint.s???"   redis      44 seconds ago   Up 44 seconds (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
```


## W48-A6fb9 ??? Round 7???: rebuild and three P8-02c runs

Run request: `docs/29-run-request-queue.md:917`. Infra was 2/2 Up (healthy) before the DB window.

### DB window and build gate

- CLAIM: 2026-09-25 05:31:13.913 +07:00 (Asia/Bangkok), before the build.
- In `services/orchestrator`: `npm run build` ExitCode 0; `npx tsc --noEmit -p tsconfig.json` ExitCode 0.
- `findstr /m date_trunc dist\modules\runtime\runtime.js` printed the dist path and returned ExitCode 0.
- Build gate output:

```text
DB_WINDOW_CLAIM=2026-09-25 05:31:13.913 +07:00

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

BUILD_EXITCODE=0
TSC_EXITCODE=0
dist\modules\runtime\runtime.js
FINDSTR_EXITCODE=0
BUILD_GATE=PASS
```

### Three consecutive test runs

Each ran from `D:\Git\dugate\du-rework` with `NO_PROXY=127.0.0.1,localhost`, `DU_LIVE_INFRA=1`, `DU_MM05_REARM=1`, using the requested Jest selection/configuration and `--forceExit`.

All three runs returned ExitCode 1 and the same result: 1 failed, 4 passed, 5 total. `rearm-1` no longer fails; the failure is `rearm-3` (terminal fence), where `r3.rearmed` was 1 but expected 0 at test line 360.

#### Run 1 raw output

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected

    expect(received).toBe(expected) // Object.is equality

    Expected: 0
    Received: 1

      358 |
      359 |     const r3 = await sweep();
    > 360 |     expect(r3.rearmed).toBe(0); // predicate excludes terminal ops (??2) ??? RUN-07 fence parity
          |                        ^
      361 |     expect(await queue!.getJob(jobId)).toBeUndefined(); // nothing revived
      362 |     const stamp = await app!.db.query<{ dispatched_at: Date | null }>(
      363 |       'SELECT dispatched_at FROM outbox WHERE id = $1',

      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:360:24)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 4 passed, 5 total
Snapshots:   0 total
Time:        1.463 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=1]
```

#### Run 2 raw output

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected

    expect(received).toBe(expected) // Object.is equality

    Expected: 0
    Received: 1

      358 |
      359 |     const r3 = await sweep();
    > 360 |     expect(r3.rearmed).toBe(0); // predicate excludes terminal ops (??2) ??? RUN-07 fence parity
          |                        ^
      361 |     expect(await queue!.getJob(jobId)).toBeUndefined(); // nothing revived
      362 |     const stamp = await app!.db.query<{ dispatched_at: Date | null }>(
      363 |       'SELECT dispatched_at FROM outbox WHERE id = $1',

      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:360:24)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 4 passed, 5 total
Snapshots:   0 total
Time:        2.064 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=1]
```

#### Run 3 raw output

```text
FAIL tests/integration/p8-02c-mm05-rearm.integration.test.ts
  ?—? P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance) ??? rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected

    expect(received).toBe(expected) // Object.is equality

    Expected: 0
    Received: 1

      358 |
      359 |     const r3 = await sweep();
    > 360 |     expect(r3.rearmed).toBe(0); // predicate excludes terminal ops (??2) ??? RUN-07 fence parity
          |                        ^
      361 |     expect(await queue!.getJob(jobId)).toBeUndefined(); // nothing revived
      362 |     const stamp = await app!.db.query<{ dispatched_at: Date | null }>(
      363 |       'SELECT dispatched_at FROM outbox WHERE id = $1',

      at Object.<anonymous> (p8-02c-mm05-rearm.integration.test.ts:360:24)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 4 passed, 5 total
Snapshots:   0 total
Time:        1.474 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=1]
```

### DB window release

- RELEASE: 2026-09-25 05:31:52.355 +07:00 (Asia/Bangkok).
- Post-release, PostgreSQL :5433 and Redis :6380 remained Up (healthy); infra was left running.

Literal release status:

```text
DB_WINDOW_RELEASE=2026-09-25 05:31:52.355 +07:00
NAME                 IMAGE                COMMAND                  SERVICE    CREATED          STATUS                    PORTS
du-rework-postgres   postgres:16-alpine   "docker-entrypoint.s???"   postgres   20 minutes ago   Up 20 minutes (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
du-rework-redis      redis:7-alpine       "docker-entrypoint.s???"   redis      20 minutes ago   Up 20 minutes (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
```


## W48-A6fb10 ??? Round 7???: re-run P8-02c after test-isolation fix

Run request: `docs/29-run-request-queue.md:938`. Docker was 2/2 Up (healthy) before the build. The queue recommended build/typecheck before claiming; both completed successfully.

### Build gate and DB window

- In `services/orchestrator`: `npm run build` ExitCode 0 and `npx tsc --noEmit -p tsconfig.json` ExitCode 0.
- DB window CLAIM: 2026-09-25 05:53:11.601 +07:00 (Asia/Bangkok), after prerun.
- DB window RELEASE: 2026-09-25 05:53:40.726 +07:00 (Asia/Bangkok).
- Infra was left running; PostgreSQL :5433 and Redis :6380 were Up (healthy) after release.

Literal build/typecheck output:

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

BUILD_EXITCODE=0
TSC_EXITCODE=0
PRERUN_BUILD_GATE=PASS
```

### Three consecutive live test runs

Each invocation used `NO_PROXY=127.0.0.1,localhost`, `DU_LIVE_INFRA=1`, `DU_MM05_REARM=1`, from the `du-rework` root:
`npx jest tests/integration/p8-02c-mm05-rearm.integration.test.ts --config tests/integration/jest.config.cjs --runInBand --forceExit`.

All three runs passed: 1 suite passed; 5 passed, 5 total; ExitCode 0. The Jest open-handle notice is emitted after the completed summary; `--forceExit` was permitted by the run request.

#### Run 1 raw output

```text
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        2.159 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=0]
```

#### Run 2 raw output

```text
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        2.362 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=0]
```

#### Run 3 raw output

```text
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        2.665 s, estimated 3 s
Ran all test suites matching tests/integration/p8-02c-mm05-rearm.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=0]
```

Literal DB-window release and post-release infra status:

```text
DB_WINDOW_RELEASE=2026-09-25 05:53:40.726 +07:00
NAME                 IMAGE                COMMAND                  SERVICE    CREATED          STATUS                    PORTS
du-rework-postgres   postgres:16-alpine   "docker-entrypoint.s???"   postgres   42 minutes ago   Up 42 minutes (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
du-rework-redis      redis:7-alpine       "docker-entrypoint.s???"   redis      42 minutes ago   Up 42 minutes (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
```


## W48-A6fb11 ??? Round 8: p8-02b after MM-05c flip

Run request: `docs/29-run-request-queue.md:955`.

### Prerun

- `docker compose -f infra/docker-compose.yml ps` could not parse the compose file and returned ExitCode 1: `yaml: line 48: mapping values are not allowed in this context`. Line 48 is the unquoted `REDIS_KEY_PREFIX: du:connector:test:` entry in the connector profile. No compose-file change was made.
- Direct Docker Engine check confirmed `du-rework-postgres` and `du-rework-redis` were both Up (healthy).
- Orchestrator source changes were present, so in `services/orchestrator` I ran `npm run build` and `npx tsc --noEmit -p tsconfig.json`; both ExitCode 0.

Build/typecheck output:

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

BUILD_EXITCODE=0
TSC_EXITCODE=0
PRERUN_BUILD_GATE=PASS
```

### DB window

- CLAIM: 2026-09-25 06:01:54.568 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 06:02:21.545 +07:00 (Asia/Bangkok).
- Three test invocations ran sequentially inside this window. Infra was left up.

### Three consecutive test runs

Each used `NO_PROXY=127.0.0.1,localhost` and `DU_LIVE_INFRA=1` from the `du-rework` root. Per the run request, `DU_MM05_REARM` was not needed. Jest command:
`npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand --forceExit`.

All three passed: 1 suite passed, 6 passed, 6 total, ExitCode 0.

#### Run 1 raw output

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        1.775 s, estimated 3 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=0]
```

#### Run 2 raw output

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        1.743 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=0]
```

#### Run 3 raw output

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        1.795 s, estimated 2 s
Ran all test suites matching tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
[JEST_EXITCODE=0]
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 06:02:21.545 +07:00
NAMES                STATUS                    PORTS
du-rework-redis      Up 51 minutes (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 51 minutes (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-001 ??? ADM-BASE-02 live HTTP matrix

Official run request: `docs/29-run-request-queue.md:977`.

### Prerun

- Docker Compose status command returned ExitCode 1 with `yaml: line 48: mapping values are not allowed in this context`; the unquoted connector-profile value `REDIS_KEY_PREFIX: du:connector:test:` is the parse location.
- Direct Docker Engine checks confirmed `du-rework-postgres` and `du-rework-redis` were Up (healthy) before the DB window.
- In `services/orchestrator`, `npm run build`: ExitCode 0; `npx tsc --noEmit -p tsconfig.json`: ExitCode 0; required queue gate `npx tsc --noEmit -p tsconfig.live-tests.json`: ExitCode 0, no output.
- Read-only precheck found no `admin_idempotency` table in the target database before the run.

### DB window

- CLAIM: 2026-09-25 06:14:46.421 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 06:15:07.801 +07:00 (Asia/Bangkok).
- Infra was left running.

### Test result

- Cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- ExitCode: 1. Result: 1 suite failed; 7 failed, 3 passed, 10 total.
- D1, D3, D4 passed. D2 failed because the 403 response detail was empty instead of containing CSRF. M1???M6 each failed when their setup submission expected HTTP 202 but received 404.

Literal raw Jest output:

```text
FAIL tests/admin-action-rbac-live.test.ts (5.156 s)
  ADM-BASE-02 dispatcher ??? live cells
    ??? D1: bearer operator dispatching business.enable -> 403 and ZERO side effects (41 ms)
    ?— D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin (6 ms)
    ??? D3: GET /api/v1/admin/actions -> 405, never GET-as-success (7 ms)
    ??? D4: operator bind foreign key -> 403 zero rows; unknown key -> 404; own key -> 201 + exactly 1 audit row (23 ms)
  ADM-BASE-02 read surfaces ??? live cells
    ?— M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A
    ?— M2: operator GET /api/v1/operations returns ONLY tenant-A rows
    ?— M3: operator by-id read of a tenant-B operation is indistinguishable 404
    ?— M4: operator api-keys list is own-tenant only; explicit foreign scope 403
    ?— M5: platform operations-list envelope regression {rows,total,limit}
    ?— M6: live Idempotency-Key replay on direct profile-bindings POST

  ?—? ADM-BASE-02 dispatcher ??? live cells ??? D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin

    expect(received).toMatch(expected)

    Expected pattern: /csrf/i
    Received string:  ""

      173 |     });
      174 |     expect(denied.status).toBe(403);
    > 175 |     expect(String(denied.body.detail ?? '')).toMatch(/csrf/i);
          |                                              ^
      176 |
      177 |     const allowed = await call('/api/v1/admin/actions', {
      178 |       method: 'POST',

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:175:46)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 404

      229 |         body: { input: { q: 'rbac-live-control' } },
      230 |       });
    > 231 |       expect(sub.status).toBe(202);
          |                          ^
      232 |     }
      233 |   });
      234 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:231:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M2: operator GET /api/v1/operations returns ONLY tenant-A rows

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 404

      229 |         body: { input: { q: 'rbac-live-control' } },
      230 |       });
    > 231 |       expect(sub.status).toBe(202);
          |                          ^
      232 |     }
      233 |   });
      234 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:231:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M3: operator by-id read of a tenant-B operation is indistinguishable 404

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 404

      229 |         body: { input: { q: 'rbac-live-control' } },
      230 |       });
    > 231 |       expect(sub.status).toBe(202);
          |                          ^
      232 |     }
      233 |   });
      234 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:231:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M4: operator api-keys list is own-tenant only; explicit foreign scope 403

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 404

      229 |         body: { input: { q: 'rbac-live-control' } },
      230 |       });
    > 231 |       expect(sub.status).toBe(202);
          |                          ^
      232 |     }
      233 |   });
      234 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:231:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M5: platform operations-list envelope regression {rows,total,limit}

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 404

      229 |         body: { input: { q: 'rbac-live-control' } },
      230 |       });
    > 231 |       expect(sub.status).toBe(202);
          |                          ^
      232 |     }
      233 |   });
      234 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:231:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M6: live Idempotency-Key replay on direct profile-bindings POST

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 404

      229 |         body: { input: { q: 'rbac-live-control' } },
      230 |       });
    > 231 |       expect(sub.status).toBe(202);
          |                          ^
      232 |     }
      233 |   });
      234 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:231:26)

Test Suites: 1 failed, 1 total
Tests:       7 failed, 3 passed, 10 total
Snapshots:   0 total
Time:        5.393 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 06:15:07.801 +07:00
NAMES                STATUS                       PORTS
du-rework-redis      Up About an hour (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up About an hour (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-002 ??? ADM-BASE-02 live HTTP matrix rerun

Run request: `docs/29-run-request-queue.md:993`.

### Prerun

- Docker Engine confirmed PostgreSQL :5433 and Redis :6380 both Up (healthy).
- `services/orchestrator`: `npm run build` ExitCode 0; `npx tsc --noEmit -p tsconfig.live-tests.json` ExitCode 0.

Build gate output:

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

BUILD_EXITCODE=0
LIVE_TSC_EXITCODE=0
BUILD_GATE=PASS
```

### DB window

- CLAIM: 2026-09-25 06:33:21.034 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 06:33:36.375 +07:00 (Asia/Bangkok).
- Docker was left running; post-release status showed both containers Up (healthy).

### Test result

- Cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- ExitCode: 1. Result: 1 suite failed; 6 failed, 4 passed, 10 total.
- D1???D4 passed, including the corrected D2 CSRF title check. M1???M6 failed at the shared control-operation setup: expected HTTP 202, received 403.

Literal raw Jest output:

```text
FAIL tests/admin-action-rbac-live.test.ts
  ADM-BASE-02 dispatcher ??? live cells
    ??? D1: bearer operator dispatching business.enable -> 403 and ZERO side effects (26 ms)
    ??? D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin (20 ms)
    ??? D3: GET /api/v1/admin/actions -> 405, never GET-as-success (4 ms)
    ??? D4: operator bind foreign key -> 403 zero rows; unknown key -> 404; own key -> 201 + exactly 1 audit row (24 ms)
  ADM-BASE-02 read surfaces ??? live cells
    ?— M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A
    ?— M2: operator GET /api/v1/operations returns ONLY tenant-A rows
    ?— M3: operator by-id read of a tenant-B operation is indistinguishable 404
    ?— M4: operator api-keys list is own-tenant only; explicit foreign scope 403
    ?— M5: platform operations-list envelope regression {rows,total,limit}
    ?— M6: live Idempotency-Key replay on direct profile-bindings POST

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 403

      248 |         body: { input: { q: 'rbac-live-control' } },
      249 |       });
    > 250 |       expect(sub.status).toBe(202);
          |                          ^
      251 |     }
      252 |   });
      253 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:250:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M2: operator GET /api/v1/operations returns ONLY tenant-A rows

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 403

      248 |         body: { input: { q: 'rbac-live-control' } },
      249 |       });
    > 250 |       expect(sub.status).toBe(202);
          |                          ^
      251 |     }
      252 |   });
      253 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:250:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M3: operator by-id read of a tenant-B operation is indistinguishable 404

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 403

      248 |         body: { input: { q: 'rbac-live-control' } },
      249 |       });
    > 250 |       expect(sub.status).toBe(202);
          |                          ^
      251 |     }
      252 |   });
      253 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:250:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M4: operator api-keys list is own-tenant only; explicit foreign scope 403

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 403

      248 |         body: { input: { q: 'rbac-live-control' } },
      249 |       });
    > 250 |       expect(sub.status).toBe(202);
          |                          ^
      251 |     }
      252 |   });
      253 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:250:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M5: platform operations-list envelope regression {rows,total,limit}

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 403

      248 |         body: { input: { q: 'rbac-live-control' } },
      249 |       });
    > 250 |       expect(sub.status).toBe(202);
          |                          ^
      251 |     }
      252 |   });
      253 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:250:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M6: live Idempotency-Key replay on direct profile-bindings POST

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 403

      248 |         body: { input: { q: 'rbac-live-control' } },
      249 |       });
    > 250 |       expect(sub.status).toBe(202);
          |                          ^
      251 |     }
      252 |   });
      253 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:250:26)

Test Suites: 1 failed, 1 total
Tests:       6 failed, 4 passed, 10 total
Snapshots:   0 total
Time:        3.694 s, estimated 6 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 06:33:36.375 +07:00
NAMES                STATUS                       PORTS
du-rework-redis      Up About an hour (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up About an hour (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-003 ??? ADM-BASE-02 live HTTP matrix rerun

Run request: `docs/29-run-request-queue.md:1008`.

### Prerun

- Docker Engine confirmed PostgreSQL :5433 and Redis :6380 were both Up (healthy).
- In `services/orchestrator`, `npm run build` and `npx tsc --noEmit -p tsconfig.live-tests.json` both returned ExitCode 0.

### DB window

- CLAIM: 2026-09-25 06:54:34.490 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 06:54:51.742 +07:00 (Asia/Bangkok).
- PostgreSQL and Redis remained Up (healthy) after release.

### Test result

- Cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- ExitCode: 1. Result: 1 suite failed; 6 failed, 4 passed, 10 total.
- D1???D4 passed. M1???M6 all failed at the shared control-operation submission: expected HTTP 202, received 500. Raw output includes the associated unhandled-request log and correlation ID.

Literal raw Jest output:

```text
{"ts":"2026-09-24T23:54:45.924Z","level":"error","component":"orchestrator","msg":"unhandled request error","errorName":"Error","correlationId":"027e6295-6815-4e7a-988f-6980d1e34abf","pathname":"/api/v1/businesses/biz-rbac-ctl-70c2aed2/actions/extract"}
FAIL tests/admin-action-rbac-live.test.ts
  ADM-BASE-02 dispatcher ??? live cells
    ??? D1: bearer operator dispatching business.enable -> 403 and ZERO side effects (33 ms)
    ??? D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin (18 ms)
    ??? D3: GET /api/v1/admin/actions -> 405, never GET-as-success (4 ms)
    ??? D4: operator bind foreign key -> 403 zero rows; unknown key -> 404; own key -> 201 + exactly 1 audit row (28 ms)
  ADM-BASE-02 read surfaces ??? live cells
    ?— M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A
    ?— M2: operator GET /api/v1/operations returns ONLY tenant-A rows
    ?— M3: operator by-id read of a tenant-B operation is indistinguishable 404
    ?— M4: operator api-keys list is own-tenant only; explicit foreign scope 403
    ?— M5: platform operations-list envelope regression {rows,total,limit}
    ?— M6: live Idempotency-Key replay on direct profile-bindings POST

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      269 |         body: { input: { q: 'rbac-live-control' } },
      270 |       });
    > 271 |       expect(sub.status).toBe(202);
          |                          ^
      272 |     }
      273 |   });
      274 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:271:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M2: operator GET /api/v1/operations returns ONLY tenant-A rows

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      269 |         body: { input: { q: 'rbac-live-control' } },
      270 |       });
    > 271 |       expect(sub.status).toBe(202);
          |                          ^
      272 |     }
      273 |   });
      274 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:271:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M3: operator by-id read of a tenant-B operation is indistinguishable 404

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      269 |         body: { input: { q: 'rbac-live-control' } },
      270 |       });
    > 271 |       expect(sub.status).toBe(202);
          |                          ^
      272 |     }
      273 |   });
      274 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:271:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M4: operator api-keys list is own-tenant only; explicit foreign scope 403

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      269 |         body: { input: { q: 'rbac-live-control' } },
      270 |       });
    > 271 |       expect(sub.status).toBe(202);
          |                          ^
      272 |     }
      273 |   });
      274 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:271:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M5: platform operations-list envelope regression {rows,total,limit}

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      269 |         body: { input: { q: 'rbac-live-control' } },
      270 |       });
    > 271 |       expect(sub.status).toBe(202);
          |                          ^
      272 |     }
      273 |   });
      274 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:271:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M6: live Idempotency-Key replay on direct profile-bindings POST

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      269 |         body: { input: { q: 'rbac-live-control' } },
      270 |       });
    > 271 |       expect(sub.status).toBe(202);
          |                          ^
      272 |     }
      273 |   });
      274 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:271:26)

Test Suites: 1 failed, 1 total
Tests:       6 failed, 4 passed, 10 total
Snapshots:   0 total
Time:        5.126 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 06:54:51.742 +07:00
NAMES                STATUS                 PORTS
du-rework-redis      Up 2 hours (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 2 hours (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-004 ??? ADM-BASE-02 live HTTP matrix rerun

Run request: final entry in `docs/29-run-request-queue.md`.

### Prerun

- Docker Engine confirmed PostgreSQL :5433 and Redis :6380 Up (healthy).
- `npm run build` in `services/orchestrator`: ExitCode 0.
- `npx tsc --noEmit -p tsconfig.live-tests.json`: ExitCode 2. TypeScript errors are in `src/modules/webhooks/webhooks.ts`: duplicate `claimed` declarations at 271/301; unresolved `claimResult` at 301/302; non-iterable `{ rows, tokens }` at 308; missing `length` at 379.

Literal build/typecheck output:

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

BUILD_EXITCODE=0
src/modules/webhooks/webhooks.ts(271,9): error TS2451: Cannot redeclare block-scoped variable 'claimed'.
src/modules/webhooks/webhooks.ts(301,9): error TS2451: Cannot redeclare block-scoped variable 'claimed'.
src/modules/webhooks/webhooks.ts(301,19): error TS2304: Cannot find name 'claimResult'.
src/modules/webhooks/webhooks.ts(302,23): error TS2304: Cannot find name 'claimResult'.
src/modules/webhooks/webhooks.ts(308,23): error TS2488: Type '{ rows: WebhookDeliveryRow[]; tokens: Map<string, unknown>; }' must have a '[Symbol.iterator]()' method that returns an iterator.
src/modules/webhooks/webhooks.ts(379,18): error TS2339: Property 'length' does not exist on type '{ rows: WebhookDeliveryRow[]; tokens: Map<string, unknown>; }'.
LIVE_TSC_EXITCODE=2
```

### DB window

- CLAIM: 2026-09-25 07:01:42.705 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 07:02:03.183 +07:00 (Asia/Bangkok).
- Docker remained Up (healthy) after release.

### Test result

- Cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- ExitCode: 1. Result: 1 suite failed; 6 failed, 4 passed, 10 total.
- D1???D4 passed. M1???M6 failed at control-operation submission: expected HTTP 202, received 500. Jest also logged an unhandled request error for the control-business extract path.

Literal raw Jest output:

```text
{"ts":"2026-09-25T00:01:56.617Z","level":"error","component":"orchestrator","msg":"unhandled request error","errorName":"Error","correlationId":"9fdbc5a7-078c-4056-a2ec-b8b5318623c3","pathname":"/api/v1/businesses/biz-rbac-ctl-2b79b4b9/actions/extract"}
FAIL tests/admin-action-rbac-live.test.ts (7.065 s)
  ADM-BASE-02 dispatcher ??? live cells
    ??? D1: bearer operator dispatching business.enable -> 403 and ZERO side effects (61 ms)
    ??? D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin (36 ms)
    ??? D3: GET /api/v1/admin/actions -> 405, never GET-as-success (8 ms)
    ??? D4: operator bind foreign key -> 403 zero rows; unknown key -> 404; own key -> 201 + exactly 1 audit row (47 ms)
  ADM-BASE-02 read surfaces ??? live cells
    ?— M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A (1 ms)
    ?— M2: operator GET /api/v1/operations returns ONLY tenant-A rows
    ?— M3: operator by-id read of a tenant-B operation is indistinguishable 404
    ?— M4: operator api-keys list is own-tenant only; explicit foreign scope 403
    ?— M5: platform operations-list envelope regression {rows,total,limit}
    ?— M6: live Idempotency-Key replay on direct profile-bindings POST

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      282 |         body: { input: { q: 'rbac-live-control' } },
      283 |       });
    > 284 |       expect(sub.status).toBe(202);
          |                          ^
      285 |     }
      286 |   });
      287 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:284:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M2: operator GET /api/v1/operations returns ONLY tenant-A rows

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      282 |         body: { input: { q: 'rbac-live-control' } },
      283 |       });
    > 284 |       expect(sub.status).toBe(202);
          |                          ^
      285 |     }
      286 |   });
      287 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:284:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M3: operator by-id read of a tenant-B operation is indistinguishable 404

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      282 |         body: { input: { q: 'rbac-live-control' } },
      283 |       });
    > 284 |       expect(sub.status).toBe(202);
          |                          ^
      285 |     }
      286 |   });
      287 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:284:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M4: operator api-keys list is own-tenant only; explicit foreign scope 403

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      282 |         body: { input: { q: 'rbac-live-control' } },
      283 |       });
    > 284 |       expect(sub.status).toBe(202);
          |                          ^
      285 |     }
      286 |   });
      287 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:284:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M5: platform operations-list envelope regression {rows,total,limit}

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      282 |         body: { input: { q: 'rbac-live-control' } },
      283 |       });
    > 284 |       expect(sub.status).toBe(202);
          |                          ^
      285 |     }
      286 |   });
      287 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:284:26)

  ?—? ADM-BASE-02 read surfaces ??? live cells ??? M6: live Idempotency-Key replay on direct profile-bindings POST

    expect(received).toBe(expected) // Object.is equality

    Expected: 202
    Received: 500

      282 |         body: { input: { q: 'rbac-live-control' } },
      283 |       });
    > 284 |       expect(sub.status).toBe(202);
          |                          ^
      285 |     }
      286 |   });
      287 |

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:284:26)

Test Suites: 1 failed, 1 total
Tests:       6 failed, 4 passed, 10 total
Snapshots:   0 total
Time:        7.439 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 07:02:03.183 +07:00
NAMES                STATUS                 PORTS
du-rework-redis      Up 2 hours (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 2 hours (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-005 ??? ADM-BASE-02 + OIDC-03 live matrix

Run request: final entry in `docs/29-run-request-queue.md`.

### Prerun

- Docker Engine confirmed PostgreSQL :5433 and Redis :6380 Up (healthy).
- `npm run build` in `services/orchestrator`: ExitCode 2 due duplicate `Readable` declarations in `src/modules/artifacts/s3-storage-facade.ts` at lines 2 and 25. Because the requested build gate is chained with `&&`, `npx tsc --noEmit -p tsconfig.live-tests.json` did not run.

Literal build gate output:

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

src/modules/artifacts/s3-storage-facade.ts(2,23): error TS2300: Duplicate identifier 'Readable'.
src/modules/artifacts/s3-storage-facade.ts(25,15): error TS2300: Duplicate identifier 'Readable'.
BUILD_EXITCODE=2
```

### DB window

- CLAIM: 2026-09-25 07:31:45.657 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 07:32:04.076 +07:00 (Asia/Bangkok).
- PostgreSQL and Redis remained Up (healthy) after release.

### Test result

- Cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- ExitCode: 1. Result: 1 suite failed; 1 failed, 11 passed, 12 total.
- D1???D4, M1???M6, and X1 passed. X2 returned 404/NOT_FOUND but its `title` included the foreign operation UUID, violating the non-disclosure assertion. Assertions after that failure in X2 were not reached.

Literal raw Jest output:

```text
FAIL tests/admin-action-rbac-live.test.ts (5.085 s)
  ADM-BASE-02 dispatcher ??? live cells
    ??? D1: bearer operator dispatching business.enable -> 403 and ZERO side effects (33 ms)
    ??? D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin (14 ms)
    ??? D3: GET /api/v1/admin/actions -> 405, never GET-as-success (2 ms)
    ??? D4 (OIDC-03): bind-profile is ADMIN-ONLY ??? operator 403 for ANY key, zero bindings; platform unknown 404, own 201 + exactly 1 audit row (26 ms)
  ADM-BASE-02 read surfaces ??? live cells
    ??? M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A (6 ms)
    ??? M2: operator GET /api/v1/operations returns ONLY tenant-A rows (2 ms)
    ??? M3: operator by-id read of a tenant-B operation is indistinguishable 404 (8 ms)
    ??? M4: operator api-keys list is own-tenant only; explicit foreign scope 403 (4 ms)
    ??? M5: platform operations-list envelope regression {rows,total,limit} (2 ms)
    ??? M6: live Idempotency-Key replay on direct profile-bindings POST (11 ms)
  OIDC-03 operation-control live cells (operator-approved actions)
    ??? X1: operator cancels an OWN-tenant operation via the dispatcher (200 + tenant-scoped audit) (23 ms)
    ?— X2: operator cancelling a tenant-B operation is 404-indistinguishable and touches NOTHING (23 ms)

  ?—? OIDC-03 operation-control live cells (operator-approved actions) ??? X2: operator cancelling a tenant-B operation is 404-indistinguishable and touches NOTHING

    expect(received).not.toContain(expected) // indexOf

    Expected substring: not "e8f7e09d-2124-42c7-9be5-3ef9dd768231"
    Received string:        "{\"type\":\"urn:du:error:not_found\",\"title\":\"operation e8f7e09d-2124-42c7-9be5-3ef9dd768231 not found\",\"status\":404,\"code\":\"NOT_FOUND\",\"correlationId\":\"ca4d68a0-e6a7-4705-927d-0cfc69e85c6d\"}"

      413 |     expect(res.status).toBe(404);
      414 |     expect(res.body.code).toBe('NOT_FOUND');
    > 415 |     expect(JSON.stringify(res.body)).not.toContain(opB);
          |                                          ^
      416 |     expect(await countOwned('SELECT count(*)::text AS n FROM admin_audit_events', [])).toBe(before);
      417 |     const stillRunning = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [opB]);
      418 |     expect(stillRunning.rows[0]!.state).not.toBe('CANCELLED');

      at Object.<anonymous> (tests/admin-action-rbac-live.test.ts:415:42)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 11 passed, 12 total
Snapshots:   0 total
Time:        5.317 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 07:32:04.076 +07:00
NAMES                STATUS                 PORTS
du-rework-redis      Up 2 hours (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 2 hours (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-006 ??? ADM-BASE-02 / OIDC-03 12-cell live matrix

Run request: `docs/29-run-request-queue.md` (final entry, W48-QW1-LIVE-006).

### Prerun

- Docker Engine confirmed PostgreSQL :5433 and Redis :6380 Up (healthy).
- `npm run build` in `services/orchestrator`: ExitCode 2. TypeScript reports missing `assertBodyTaskRuntimeAuth` at `src/server.ts:784,794` (suggests `assertTaskRuntimeAuth`).

Literal build output:

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

src/server.ts(784,13): error TS2552: Cannot find name 'assertBodyTaskRuntimeAuth'. Did you mean 'assertTaskRuntimeAuth'?
src/server.ts(794,13): error TS2552: Cannot find name 'assertBodyTaskRuntimeAuth'. Did you mean 'assertTaskRuntimeAuth'?
BUILD_EXITCODE=2
```

### DB window

- CLAIM: 2026-09-25 08:10:54.538 +07:00 (Asia/Bangkok).
- RELEASE: 2026-09-25 08:11:13.046 +07:00 (Asia/Bangkok).
- Docker was left running; both containers remained Up (healthy).

### Test result

- Cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- ExitCode: 1. Jest could not compile `src/server.ts` due the same missing `assertBodyTaskRuntimeAuth` at lines 784 and 794. Result: 1 suite failed to run; 0 tests ran. No matrix assertions executed.

Literal raw Jest output:

```text
FAIL tests/admin-action-rbac-live.test.ts
  ?—? Test suite failed to run

    [96msrc/server.ts[0m:[93m784[0m:[93m13[0m - [91merror[0m[90m TS2552: [0mCannot find name 'assertBodyTaskRuntimeAuth'. Did you mean 'assertTaskRuntimeAuth'?

    [7m784[0m       await assertBodyTaskRuntimeAuth(ctx);
    [7m   [0m [91m            ~~~~~~~~~~~~~~~~~~~~~~~~~[0m

      [96msrc/server.ts[0m:[93m1840[0m:[93m16[0m
        [7m1840[0m async function assertTaskRuntimeAuth(ctx: RouteContext, taskId: string): Promise<void> {
        [7m    [0m [96m               ~~~~~~~~~~~~~~~~~~~~~[0m
        'assertTaskRuntimeAuth' is declared here.
    [96msrc/server.ts[0m:[93m794[0m:[93m13[0m - [91merror[0m[90m TS2552: [0mCannot find name 'assertBodyTaskRuntimeAuth'. Did you mean 'assertTaskRuntimeAuth'?

    [7m794[0m       await assertBodyTaskRuntimeAuth(ctx);
    [7m   [0m [91m            ~~~~~~~~~~~~~~~~~~~~~~~~~[0m

      [96msrc/server.ts[0m:[93m1840[0m:[93m16[0m
        [7m1840[0m async function assertTaskRuntimeAuth(ctx: RouteContext, taskId: string): Promise<void> {
        [7m    [0m [96m               ~~~~~~~~~~~~~~~~~~~~~[0m
        'assertTaskRuntimeAuth' is declared here.

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        3.972 s, estimated 6 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

Post-release Docker Engine status:

```text
DB_WINDOW_RELEASE=2026-09-25 08:11:13.046 +07:00
NAMES                STATUS                 PORTS
du-rework-redis      Up 3 hours (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 3 hours (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```


## W48-QW1-LIVE-006 ??? rerun after assertBodyTaskRuntimeAuth fix

- Date: 2026-09-25 (Asia/Bangkok, UTC+07:00)
- Docker preflight command: `docker ps --filter name=du-rework-postgres --filter name=du-rework-redis`
- Build gate cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Build gate command: `npm run build`
- Build gate ExitCode: 0
- DB window: CLAIM 2026-09-25 08:21:11.621 +07:00; RELEASE 2026-09-25 08:21:30.101 +07:00
- Jest cwd: `D:\Git\dugate\du-rework\services\orchestrator`
- Jest command: `npx jest --runInBand tests/admin-action-rbac-live.test.ts`
- Jest ExitCode: 0
- Result: 1 suite passed; 12 tests passed, 12 total; 0 snapshots.

### Docker preflight raw output

```text
NAMES                STATUS                 PORTS
du-rework-redis      Up 3 hours (healthy)    0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 3 hours (healthy)    0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```

### Build gate raw output

```text
> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

BUILD_EXITCODE=0
```

### Jest raw output

```text
PASS tests/admin-action-rbac-live.test.ts
  ADM-BASE-02 dispatcher ??? live cells
    ??? D1: bearer operator dispatching business.enable -> 403 and ZERO side effects (31 ms)
    ??? D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin (18 ms)
    ??? D3: GET /api/v1/admin/actions -> 405, never GET-as-success (2 ms)
    ??? D4 (OIDC-03): bind-profile is ADMIN-ONLY ??? operator 403 for ANY key, zero bindings; platform unknown 404, own 201 + exactly 1 audit row (41 ms)
  ADM-BASE-02 read surfaces ??? live cells
    ??? M1: operator GET /api/v1/usage ??? tenantId=B 403, tenantId=A 200, missing param 200-of-A (9 ms)
    ??? M2: operator GET /api/v1/operations returns ONLY tenant-A rows (5 ms)
    ??? M3: operator by-id read of a tenant-B operation is indistinguishable 404 (8 ms)
    ??? M4: operator api-keys list is own-tenant only; explicit foreign scope 403 (5 ms)
    ??? M5: platform operations-list envelope regression {rows,total,limit} (3 ms)
    ??? M6: live Idempotency-Key replay on direct profile-bindings POST (17 ms)
  OIDC-03 operation-control live cells (operator-approved actions)
    ??? X1: operator cancels an OWN-tenant operation via the dispatcher (200 + tenant-scoped audit) (28 ms)
    ??? X2: operator cancelling a tenant-B operation is 404-indistinguishable and touches NOTHING (24 ms)

Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
Time:        4.827 s
Ran all test suites matching /tests\\admin-action-rbac-live.test.ts/i.
```

### Post-release Docker Engine status

```text
NAMES                STATUS                 PORTS
du-rework-redis      Up 3 hours (healthy)    0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 3 hours (healthy)    0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```
## RR-Q3-3/RR-Q3-4 ??? LIVE webhook fence, regressions, graceful shutdown

- Date: 2026-09-25 (Asia/Bangkok, UTC+07:00)
- DB window: CLAIM 2026-09-25 08:51:38.526 +07:00; RELEASE 2026-09-25 09:25:33.632 +07:00
- Window was held continuously for build, migration ledger inspection, live/regression suites, SIGTERM process smoke, and fixture cleanup.
- Docker preflight and post-release: PostgreSQL :5433 and Redis :6380 were Up (healthy); both remain Up. No compose down was run.
- Build gate cwd: `services/orchestrator`; command `npm run build`; ExitCode 0.
- Migration ledger: initial status command had no DATABASE_URL in the host process (ExitCode 1); rerun with the repository's integration-test database URL succeeded: 14/14 applied, all migrations applied.
- Live webhook fence result: 2 tests, both failed (ExitCode 1).
- `admin-error-boundary.test.ts`: 1/1 passed (ExitCode 0).
- `runtime.test.ts`: compilation failed before tests (ExitCode 1; duplicate `body` / `headers` declarations and associated TS errors).
- `p8-04-security-isolation.integration.test.ts`: 26 total; 17 passed, 9 failed (ExitCode 1).
- SIGTERM smoke: native host is Windows, where the child-process SIGTERM probe terminated the child without delivering its Node handler. To exercise actual process signal handling, smoke ran the built `dist/main.js` process in a Linux test container on the existing test Docker network. A temporary preload enabled private-network egress only for the local stalled-listener fixture because `main.ts` does not expose that test option as an environment variable. The actual shutdown handler and database path were used; no repository source files were changed.
- First smoke observations were repeated immediately with signal delivery triggered at the first listener request. Definitive one-signal rerun: ExitCode 0 in about 1.75 s; row returned PENDING, attempts 0, last_error SHUTDOWN_RELEASED. Definitive double-signal rerun: ExitCode 1 after the second SIGTERM; row was DISPATCHING/attempts 0 at observation and then cleaned.
- Both webhook fixture operations and delivery rows were deleted; listener and smoke app containers were removed. Synthetic tokens are omitted from this report.

### Docker preflight raw output

```text
NAMES                STATUS                 PORTS
du-rework-redis      Up 4 hours (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 4 hours (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```

### Build gate raw output (npm run build; ExitCode 0)

```text

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json


```

### Migration status attempt 1 raw output (ExitCode 1; DATABASE_URL missing)

```text

> @du/orchestrator@0.1.0 migrate:status
> npm run build && node dist/migrate-cli.js status


> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

DATABASE_URL is required

```

### Migration status rerun raw output (test database configured; ExitCode 0)

```text

> @du/orchestrator@0.1.0 migrate:status
> npm run build && node dist/migrate-cli.js status


> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

Migrations: 14/14 applied
All migrations applied.

```

### Fence live raw output ??? npx jest tests/webhook-reclaim-fence.live.test.ts --runInBand (ExitCode 1)

```text
FAIL tests/webhook-reclaim-fence.live.test.ts (11.062 s)
  RR-Q3-4 live - reclaim generation fence + graceful release (real PG)
    ?— stale claimant A cannot clobber re-claimer B (RETURNING next_at fence over the wire) (1859 ms)
    ?— graceful shutdown releases the live claim to PENDING with budget intact (6199 ms)

  ?—? RR-Q3-4 live - reclaim generation fence + graceful release (real PG) ??? stale claimant A cannot clobber re-claimer B (RETURNING next_at fence over the wire)

    expect(received).toBe(expected) // Object.is equality

    Expected: "DELIVERED"
    Received: "PENDING"

      106 |     expect(attemptedB).toBe(1);
      107 |     const afterB = await readRow(deliveryId);
    > 108 |     expect(afterB.status).toBe('DELIVERED');
          |                           ^
      109 |     expect(afterB.attempts).toBe(1);
      110 |     // A wakes FAILED; its release must lose on the next_at generation predicate.
      111 |     releaseA({ status: 500 });

      at Object.<anonymous> (tests/webhook-reclaim-fence.live.test.ts:108:27)

  ?—? RR-Q3-4 live - reclaim generation fence + graceful release (real PG) ??? graceful shutdown releases the live claim to PENDING with budget intact

    expect(received).toBe(expected) // Object.is equality

    Expected: 0
    Received: 1

      137 |     const released = await readRow(deliveryId);
      138 |     expect(released.status).toBe('PENDING');
    > 139 |     expect(released.attempts).toBe(0); // retry budget untouched
          |                               ^
      140 |     expect(released.last_error).toBe('SHUTDOWN_RELEASED');
      141 |     // The late completion must not write anything over the released row.
      142 |     releaseLate({ status: 200 });

      at Object.<anonymous> (tests/webhook-reclaim-fence.live.test.ts:139:31)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 2 total
Snapshots:   0 total
Time:        11.278 s
Ran all test suites matching /tests\\webhook-reclaim-fence.live.test.ts/i.

```

### Regression raw output ??? npx jest tests/admin-error-boundary.test.ts --runInBand (ExitCode 0)

```text
{"errorName":"Error","pathname":"/api/v1/admin/businesses","timestamp":"2026-09-25T01:53:10.878Z","level":"error","service":"orchestrator","environment":"test","correlationId":"8fb6ffe5-7594-4b44-8db4-ab9a7521e87b","taskId":null,"invocationId":null,"message":"unhandled request error"}
PASS tests/admin-error-boundary.test.ts
  W46-C2: admin error boundary (sentinel non-leak)
    ??? DB rejection with sentinel secret ??? 500 problem+json, no sentinel on wire or log (20 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        3.123 s
Ran all test suites matching /tests\\admin-error-boundary.test.ts/i.

```

### Regression raw output ??? npx jest tests/runtime.test.ts --runInBand (ExitCode 1)

```text
FAIL tests/runtime.test.ts
  ?—? Test suite failed to run

    [96mtests/runtime.test.ts[0m:[93m87[0m:[93m9[0m - [91merror[0m[90m TS2451: [0mCannot redeclare block-scoped variable 'body'.

    [7m87[0m   const body = path.endsWith('/claim') && typeof opts.body === 'object' && opts.body !== null && !Array.isArray(opts.body)
    [7m  [0m [91m        ~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m90[0m:[93m9[0m - [91merror[0m[90m TS2451: [0mCannot redeclare block-scoped variable 'headers'.

    [7m90[0m   const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    [7m  [0m [91m        ~~~~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m91[0m:[93m42[0m - [91merror[0m[90m TS2339: [0mProperty 'authorization' does not exist on type '{ 'content-type': string; }'.

    [7m91[0m   if (path.endsWith('/claim') && headers.authorization === `Bearer ${RUNTIME_TOKEN}`) {
    [7m  [0m [91m                                         ~~~~~~~~~~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m92[0m:[93m13[0m - [91merror[0m[90m TS2339: [0mProperty 'authorization' does not exist on type '{ 'content-type': string; }'.

    [7m92[0m     headers.authorization = `Bearer ${WORKER_IDENTITY_TOKEN}`;
    [7m  [0m [91m            ~~~~~~~~~~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m100[0m:[93m9[0m - [91merror[0m[90m TS2451: [0mCannot redeclare block-scoped variable 'body'.

    [7m100[0m   const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    [7m   [0m [91m        ~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m101[0m:[93m9[0m - [91merror[0m[90m TS2451: [0mCannot redeclare block-scoped variable 'headers'.

    [7m101[0m   const headers: Record<string, string> = {};
    [7m   [0m [91m        ~~~~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m103[0m:[93m5[0m - [91merror[0m[90m TS7053: [0mElement implicitly has an 'any' type because expression of type 'string' can't be used to index type '{ 'content-type': string; }'.
      No index signature with a parameter of type 'string' was found on type '{ 'content-type': string; }'.

    [7m103[0m     headers[k] = v;
    [7m   [0m [91m    ~~~~~~~~~~[0m
    [96mtests/runtime.test.ts[0m:[93m105[0m:[93m32[0m - [91merror[0m[90m TS2322: [0mType 'unknown' is not assignable to type 'Record<string, unknown>'.

    [7m105[0m   return { status: res.status, body, headers };
    [7m   [0m [91m                               ~~~~[0m

      [96mtests/runtime.test.ts[0m:[93m86[0m:[93m30[0m
        [7m86[0m ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
        [7m  [0m [96m                             ~~~~[0m
        The expected type comes from property 'body' which is declared here on type '{ status: number; body: Record<string, unknown>; headers: Record<string, string>; }'

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        3.192 s, estimated 8 s
Ran all test suites matching /tests\\runtime.test.ts/i.

```

### Regression raw output ??? p8-04-security-isolation.integration.test.ts (ExitCode 1)

```text
FAIL tests/integration/p8-04-security-isolation.integration.test.ts
  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 1. Cross-Tenant Access Denied (SEC-01, OPS-04) ??? cross-tenant artifact access request is rejected with 409 PERMISSION_DENIED

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 409

      316 |         },
      317 |       });
    > 318 |       expect(uploadRes.status).toBe(201);
          |                                ^
      319 |       const artAId = uploadRes.body.artifactId as string;
      320 |
      321 |       // Tenant B worker attempts to request access to Tenant A's artifact

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:318:32)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? artifact blob upload with forged or invalid grant token is rejected with 403 PERMISSION_DENIED

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 409

      361 |         },
      362 |       });
    > 363 |       expect(uploadRes.status).toBe(201);
          |                                ^
      364 |       grantStorageKey = uploadRes.body.storageKey as string;
      365 |       const url = new URL(uploadRes.body.uploadUrl as string, 'http://localhost');
      366 |       validGrantToken = url.searchParams.get('grant')!;

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:363:32)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? artifact blob upload without grant query param is rejected with 403 PERMISSION_DENIED

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 409

      361 |         },
      362 |       });
    > 363 |       expect(uploadRes.status).toBe(201);
          |                                ^
      364 |       grantStorageKey = uploadRes.body.storageKey as string;
      365 |       const url = new URL(uploadRes.body.uploadUrl as string, 'http://localhost');
      366 |       validGrantToken = url.searchParams.get('grant')!;

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:363:32)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? artifact blob upload with mismatched storage key is rejected with 403 PERMISSION_DENIED

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 409

      361 |         },
      362 |       });
    > 363 |       expect(uploadRes.status).toBe(201);
          |                                ^
      364 |       grantStorageKey = uploadRes.body.storageKey as string;
      365 |       const url = new URL(uploadRes.body.uploadUrl as string, 'http://localhost');
      366 |       validGrantToken = url.searchParams.get('grant')!;

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:363:32)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? invocation grant with tampered HMAC signature is rejected by verifier

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 409

      361 |         },
      362 |       });
    > 363 |       expect(uploadRes.status).toBe(201);
          |                                ^
      364 |       grantStorageKey = uploadRes.body.storageKey as string;
      365 |       const url = new URL(uploadRes.body.uploadUrl as string, 'http://localhost');
      366 |       validGrantToken = url.searchParams.get('grant')!;

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:363:32)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? invocation grant with expired timestamp is rejected

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 409

      361 |         },
      362 |       });
    > 363 |       expect(uploadRes.status).toBe(201);
          |                                ^
      364 |       grantStorageKey = uploadRes.body.storageKey as string;
      365 |       const url = new URL(uploadRes.body.uploadUrl as string, 'http://localhost');
      366 |       validGrantToken = url.searchParams.get('grant')!;

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:363:32)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 4. Oversized or Wrong-Content-Type Upload Rejected Before Storage (ART-02, ART-03) ??? artifact upload grant request with negative size is rejected with 422 INVALID_SCHEMA

    expect(received).toBe(expected) // Object.is equality

    Expected: 422
    Received: 409

      561 |       });
      562 |
    > 563 |       expect(res.status).toBe(422);
          |                          ^
      564 |       expect(res.body.code).toBe('INVALID_SCHEMA');
      565 |     });
      566 |

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:563:26)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 4. Oversized or Wrong-Content-Type Upload Rejected Before Storage (ART-02, ART-03) ??? artifact upload grant request with invalid purpose or empty mimeType is rejected with 422 INVALID_SCHEMA

    expect(received).toBe(expected) // Object.is equality

    Expected: 422
    Received: 409

      577 |       });
      578 |
    > 579 |       expect(res.status).toBe(422);
          |                          ^
      580 |       expect(res.body.code).toBe('INVALID_SCHEMA');
      581 |     });
      582 |

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:579:26)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 6. No Secret Material in Any Response or Log Line (OPS-04, REG-04, SEC-04) ??? invocation grant JWT claims omit database secrets, encryption keys, and internal credentials

    expect(received).toBe(expected) // Object.is equality

    Expected: 201
    Received: 422

      757 |         },
      758 |       });
    > 759 |       expect(grantRes.status).toBe(201);
          |                               ^
      760 |       const grantToken = grantRes.body.grant as string;
      761 |
      762 |       // Decode JWT payload without signature check

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:759:31)

Test Suites: 1 failed, 1 total
Tests:       9 failed, 17 passed, 26 total
Snapshots:   0 total
Time:        2.875 s
Ran all test suites matching tests/integration/p8-04-security-isolation.integration.test.ts.

```

### SIGTERM smoke first one-signal attempt raw output (ExitCode 0; attempts observed as 1)

```text
SIGTERM_1_SENT=2026-09-25 09:18:19.807 +07:00
rr-q3-app-single-20260925
DOCKER_KILL_EXITCODE=0
CONTAINER_EXITCODE=0
PROCESS_EXIT_OBSERVED=2026-09-25 09:18:21.568 +07:00
--- APP LOG ---
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
RRQ3_MAIN_SERVER_REQUIRE=/app/services/orchestrator/dist/main.js
RRQ3_CREATEAPP_ENTER
RRQ3_CREATEAPP_RESOLVED
RRQ3_LISTEN_ENTER
RRQ3_LISTEN_RESOLVED
{"address":3123,"timestamp":"2026-09-25T02:18:01.102Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"072e6093-5790-4013-894f-76146c4dda2c","taskId":null,"invocationId":null,"message":"orchestrator listening"}
{"timestamp":"2026-09-25T02:18:19.859Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"c892c16a-d9e7-4cbf-98dc-cbee5e065966","taskId":null,"invocationId":null,"message":"shutdown shutdown-begin SIGTERM"}
{"timestamp":"2026-09-25T02:18:21.367Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"5f875877-c0df-42ae-9d29-f66161feda46","taskId":null,"invocationId":null,"message":"shutdown shutdown-complete exit=0"}
--- DELIVERY ROW ---
{"event":"ROW_STATE","row":{"delivery_id":"3f39a80a-69fc-439c-ab37-4f8365c81c48","operation_id":"9a40da5c-9487-4c6b-aea5-6361ed677bbe","status":"PENDING","attempts":1,"last_error":"SHUTDOWN_RELEASED"}}

```

### SIGTERM smoke first double-signal attempt raw output (process ExitCode 1; in-flight row cleaned)

```text
SIGTERM_1_SENT=2026-09-25 09:19:34.644 +07:00
rr-q3-app-double-20260925
SIGTERM_1_DOCKER_EXITCODE=0
SIGTERM_2_SENT=2026-09-25 09:19:34.839 +07:00
rr-q3-app-double-20260925
SIGTERM_2_DOCKER_EXITCODE=0
CONTAINER_EXITCODE=1
PROCESS_EXIT_OBSERVED=2026-09-25 09:19:35.105 +07:00
--- APP LOG ---
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
RRQ3_MAIN_SERVER_REQUIRE=/app/services/orchestrator/dist/main.js
RRQ3_CREATEAPP_ENTER
RRQ3_CREATEAPP_RESOLVED
RRQ3_LISTEN_ENTER
RRQ3_LISTEN_RESOLVED
{"address":3123,"timestamp":"2026-09-25T02:19:21.917Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"2422b650-c983-4611-b519-e1d894ad4a7f","taskId":null,"invocationId":null,"message":"orchestrator listening"}
{"timestamp":"2026-09-25T02:19:34.715Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"a8858239-a65c-4355-b625-76d1dc994788","taskId":null,"invocationId":null,"message":"shutdown shutdown-begin SIGTERM"}
{"timestamp":"2026-09-25T02:19:34.882Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"d353b603-fe61-415d-ab6b-15f5e9af7dde","taskId":null,"invocationId":null,"message":"shutdown shutdown-forced SIGTERM"}
--- DELIVERY ROW ---
{"event":"ROW_STATE","row":{"delivery_id":"99dcdc5c-4cf4-4f0d-9aff-2cf1181551fb","operation_id":"67d0b15a-f8b4-4d6b-b1bb-25209972d5fb","status":"DISPATCHING","attempts":1,"last_error":"WEBHOOK_TRANSPORT_FAILED (AbortError)"}}

```

### SIGTERM smoke definitive one-signal rerun raw output (ExitCode 0; PENDING/attempts 0/SHUTDOWN_RELEASED)

```text
{"event":"CLEANED","operationId":"67d0b15a-f8b4-4d6b-b1bb-25209972d5fb","operationsDeleted":1}
--- SEED ---
{"event":"SEEDED","scenario":"single-rerun","operationId":"6befeda2-19aa-4d6e-bc79-1140ee8deefa","deliveryId":"54d70599-7b98-438c-a782-754c0fd2ac94","status":"PENDING","attempts":0}
APP_CONTAINER_ID=fa6d62b0c37632848d1b40efc7cc7c614285f412e5b33d9b9947969337d9bd11
APP_STATE_AT_SIGNAL=running
REQUEST_SEEN=True
SIGTERM_1_SENT=2026-09-25 09:24:17.608 +07:00
DOCKER_KILL_OUTPUT=rr-q3-app-single-rerun-20260925
DOCKER_KILL_EXITCODE=0
CONTAINER_EXITCODE=0
PROCESS_EXIT_OBSERVED=2026-09-25 09:24:19.353 +07:00
--- APP LOG ---
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
RRQ3_MAIN_SERVER_REQUIRE=/app/services/orchestrator/dist/main.js
RRQ3_CREATEAPP_ENTER
RRQ3_CREATEAPP_RESOLVED
RRQ3_LISTEN_ENTER
RRQ3_LISTEN_RESOLVED
{"address":3123,"timestamp":"2026-09-25T02:24:17.354Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"a9cc3549-ea74-49b5-858f-9a6c86193ea0","taskId":null,"invocationId":null,"message":"orchestrator listening"}
{"timestamp":"2026-09-25T02:24:17.657Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"dc3d4182-41c6-432e-b8b2-a5687b84668f","taskId":null,"invocationId":null,"message":"shutdown shutdown-begin SIGTERM"}
{"timestamp":"2026-09-25T02:24:19.168Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"df9b2b66-32a1-4e30-8179-2974138b94c4","taskId":null,"invocationId":null,"message":"shutdown shutdown-complete exit=0"}
--- LISTENER LOG ---
LISTENER_READY port=3124
REQUEST_RECEIVED POST /stall/single
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/single
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/double
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/double
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/single-rerun
REQUEST_BODY_CONSUMED
--- DELIVERY ROW ---
{"event":"ROW_STATE","row":{"delivery_id":"54d70599-7b98-438c-a782-754c0fd2ac94","operation_id":"6befeda2-19aa-4d6e-bc79-1140ee8deefa","status":"PENDING","attempts":0,"last_error":"SHUTDOWN_RELEASED"}}
--- CLEANUP ---
{"event":"CLEANED","operationId":"6befeda2-19aa-4d6e-bc79-1140ee8deefa","operationsDeleted":1}
rr-q3-app-single-rerun-20260925

```

### SIGTERM smoke definitive double-signal rerun raw output (ExitCode 1; second signal forced exit)

```text
--- SEED ---
{"event":"SEEDED","scenario":"double-rerun","operationId":"f22509fa-e3a3-49c2-9bbd-462d29b99a1c","deliveryId":"4bd72a92-b861-4021-9895-faa02b6be718","status":"PENDING","attempts":0}
APP_CONTAINER_ID=4283cea94a5cdd74e7bcbf3a07811735677c87cf29217b55fd37f7605dd256ba
APP_STATE_AT_SIGNAL=running
REQUEST_SEEN=True
SIGTERM_1_SENT=2026-09-25 09:25:06.696 +07:00
SIGTERM_1_DOCKER_OUTPUT=rr-q3-app-double-rerun-20260925
SIGTERM_1_DOCKER_EXITCODE=0
SIGTERM_2_SENT=2026-09-25 09:25:06.866 +07:00
SIGTERM_2_DOCKER_OUTPUT=rr-q3-app-double-rerun-20260925
SIGTERM_2_DOCKER_EXITCODE=0
CONTAINER_EXITCODE=1
PROCESS_EXIT_OBSERVED=2026-09-25 09:25:07.116 +07:00
--- APP LOG ---
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
RRQ3_MAIN_SERVER_REQUIRE=/app/services/orchestrator/dist/main.js
RRQ3_CREATEAPP_ENTER
RRQ3_CREATEAPP_RESOLVED
RRQ3_LISTEN_ENTER
RRQ3_LISTEN_RESOLVED
{"address":3123,"timestamp":"2026-09-25T02:25:06.454Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"0a08b75b-348d-4264-a810-21957d6ff11d","taskId":null,"invocationId":null,"message":"orchestrator listening"}
{"timestamp":"2026-09-25T02:25:06.756Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"b35878fb-9868-4ae0-a939-cbc26bd74220","taskId":null,"invocationId":null,"message":"shutdown shutdown-begin SIGTERM"}
{"timestamp":"2026-09-25T02:25:06.912Z","level":"info","service":"orchestrator:main","environment":"prod","correlationId":"1d530830-f001-4aba-b280-7cfa5cc55d8d","taskId":null,"invocationId":null,"message":"shutdown shutdown-forced SIGTERM"}
--- LISTENER LOG ---
LISTENER_READY port=3124
REQUEST_RECEIVED POST /stall/single
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/single
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/double
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/double
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/single-rerun
REQUEST_BODY_CONSUMED
REQUEST_RECEIVED POST /stall/double-rerun
REQUEST_BODY_CONSUMED
--- DELIVERY ROW ---
{"event":"ROW_STATE","row":{"delivery_id":"4bd72a92-b861-4021-9895-faa02b6be718","operation_id":"f22509fa-e3a3-49c2-9bbd-462d29b99a1c","status":"DISPATCHING","attempts":0,"last_error":null}}
--- CLEANUP ---
{"event":"CLEANED","operationId":"f22509fa-e3a3-49c2-9bbd-462d29b99a1c","operationsDeleted":1}
rr-q3-app-double-rerun-20260925

```

### Post-release cleanup and Docker health raw output

```text
rr-q3-stall-listener-20260925
NAMES                STATUS                 PORTS
du-rework-redis      Up 4 hours (healthy)   0.0.0.0:6380->6379/tcp, [::]:6380->6379/tcp
du-rework-postgres   Up 4 hours (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
NAMES     STATUS
DB_WINDOW_RELEASE=2026-09-25 09:25:33.632 +07:00

```



### Smoke harness boot diagnostics (superseded before delivery; no application or DB writes)

### Initial Linux process startup diagnostic ??? missing workspace @du/contracts link

```text
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
node:internal/modules/cjs/loader:1210
  throw err;
  ^

Error: Cannot find module '@du/contracts'
Require stack:
- /app/packages/egress/dist/pinned-fetch.js
- /app/packages/egress/dist/index.js
- /app/services/orchestrator/dist/modules/webhooks/webhooks.js
- /app/services/orchestrator/dist/modules/runtime/runtime.js
- /app/services/orchestrator/dist/server.js
- /app/services/orchestrator/dist/main.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1207:15)
    at Module._load (node:internal/modules/cjs/loader:1038:27)
    at Module._load (/tmp/rrq3/preload.cjs:16:33)
    at Module.require (node:internal/modules/cjs/loader:1289:19)
    at require (node:internal/modules/helpers:182:18)
    at Object.<anonymous> (/app/packages/egress/dist/pinned-fetch.js:12:21)
    at Module._compile (node:internal/modules/cjs/loader:1521:14)
    at Module._extensions..js (node:internal/modules/cjs/loader:1623:10)
    at Module.load (node:internal/modules/cjs/loader:1266:32)
    at Module._load (node:internal/modules/cjs/loader:1091:12) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/app/packages/egress/dist/pinned-fetch.js',
    '/app/packages/egress/dist/index.js',
    '/app/services/orchestrator/dist/modules/webhooks/webhooks.js',
    '/app/services/orchestrator/dist/modules/runtime/runtime.js',
    '/app/services/orchestrator/dist/server.js',
    '/app/services/orchestrator/dist/main.js'
  ]
}

Node.js v20.20.2
exited exit=1

```

### Next startup diagnostic ??? pnpm dependency symlink resolution

```text
exited exit=1
node:internal/modules/cjs/loader:1210
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
  throw err;
  ^

Error: Cannot find module 'tslib'
Require stack:
- /host-pnpm/bullmq@5.81.5/node_modules/bullmq/dist/cjs/index.js
- /app/services/orchestrator/dist/server.js
- /app/services/orchestrator/dist/main.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1207:15)
    at Module._load (node:internal/modules/cjs/loader:1038:27)
    at Module._load (/tmp/rrq3/preload.cjs:32:33)
    at Module.require (node:internal/modules/cjs/loader:1289:19)
    at require (node:internal/modules/helpers:182:18)
    at Object.<anonymous> (/host-pnpm/bullmq@5.81.5/node_modules/bullmq/dist/cjs/index.js:3:17)
    at Module._compile (node:internal/modules/cjs/loader:1521:14)
    at Module._extensions..js (node:internal/modules/cjs/loader:1623:10)
    at Module.load (node:internal/modules/cjs/loader:1266:32)
    at Module._load (node:internal/modules/cjs/loader:1091:12) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/host-pnpm/bullmq@5.81.5/node_modules/bullmq/dist/cjs/index.js',
    '/app/services/orchestrator/dist/server.js',
    '/app/services/orchestrator/dist/main.js'
  ]
}

Node.js v20.20.2
RRQ3_MAIN_SERVER_REQUIRE=/app/services/orchestrator/dist/main.js
LISTENER_READY port=3124

```

### Next startup diagnostic ??? migration directory mount absent; fixture remained PENDING

```text
APP_STATE=exited
--- APP LOG ---
RRQ3_TEST_PRELOAD=local stalled listener allowed for process smoke
RRQ3_CREATEAPP_ERROR Error: ENOENT: no such file or directory, scandir '/app/services/orchestrator/migrations'
RRQ3_MAIN_SERVER_REQUIRE=/app/services/orchestrator/dist/main.js
RRQ3_CREATEAPP_ENTER
{"error":{"kind":"UNEXPECTED_ERROR","message":"Unexpected error; details redacted."},"timestamp":"2026-09-25T02:17:32.360Z","level":"error","service":"orchestrator:main","environment":"prod","correlationId":"941c0056-09c3-46d9-afee-caaf7d21aae3","taskId":null,"invocationId":null,"message":"orchestrator startup failed"}
    at readdirSync (node:fs:1521:26)
    at loadMigrationFiles (/app/services/orchestrator/dist/db/migrations.js:33:45)
    at verifyMigrations (/app/services/orchestrator/dist/db/migrations.js:121:19)
    at Object.createApp (/app/services/orchestrator/dist/server.js:87:49)
    at wrapped.createApp (/tmp/rrq3/preload.cjs:39:36)
    at main (/app/services/orchestrator/dist/main.js:94:46)
    at Object.<anonymous> (/app/services/orchestrator/dist/main.js:127:6)
    at Module._compile (node:internal/modules/cjs/loader:1521:14)
    at Module._extensions..js (node:internal/modules/cjs/loader:1623:10)
    at Module.load (node:internal/modules/cjs/loader:1266:32)
--- LISTENER LOG ---
LISTENER_READY port=3124
--- ROW ---
{"event":"ROW_STATE","row":{"delivery_id":"3f39a80a-69fc-439c-ab37-4f8365c81c48","operation_id":"9a40da5c-9487-4c6b-aea5-6361ed677bbe","status":"PENDING","attempts":0,"last_error":null}}

```


## Regression matrix rerun ??? 2026-09-25

Tester retained exclusive DB-window ownership for the requested sequence.

### DB window and outcomes

- CLAIM: 2026-09-25 10:00:56.049 +07:00
- RELEASE after the three requested suites: 2026-09-25 10:02:40.382 +07:00
- Build gate (`services/orchestrator`, `npm run build`): ExitCode 0.
- Runtime (`services/orchestrator`, `npx jest tests/runtime.test.ts --runInBand`): first invocation ExitCode 1. Its console response was truncated by the tool output limit and showed repeated `EADDRINUSE 127.0.0.1:5433` setup errors. To retain a complete literal log, the same suite was rerun in a short recapture window below; that rerun reported 3 failed, 94 passed, 97 total, ExitCode 1.
- P8-04 (`du-rework` root, `npx jest tests/integration/p8-04-security-isolation.integration.test.ts --runInBand`): 1 suite failed before tests ran; 0 tests total; ExitCode 1.
- Webhook reclaim fence (`services/orchestrator`, `npx jest tests/webhook-reclaim-fence.live.test.ts --runInBand`): 1 suite passed; 2 passed, 2 total; ExitCode 0.

The runtime recapture was performed after the requested matrix was released, under a separate short exclusive DB window:
- CLAIM: 2026-09-25 10:03:02.848 +07:00
- RELEASE: 2026-09-25 10:03:27.617 +07:00
- Recapture command: `npx jest tests/runtime.test.ts --runInBand` from `services/orchestrator`; ExitCode 1; 3 failed, 94 passed, 97 total.

### Raw output ??? build gate

```text
> npm run build

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json
```

### Raw output ??? runtime suite (complete recapture)

```text
node.exe : FAIL tests/runtime.test.ts (9.574 s)
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/runtime.test.ts (9.574 s):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  runtime vertical slice (isolated PG/Redis)
    ??? submit ??? outbox ??? dispatch ??? claim ??? heartbeat ??? checkpoint ??? complete ??? result (144 ms)
    ??? idempotency: same key + same body replays, different body ??? 409 (30 ms)
    ??? lease expiry allows reclaim by another worker (50 ms)
    ??? fail retryable enqueues continuation with future due_at; dispatch respects due_at (54 ms)
    ??? input validation returns 422 on bad submission (6 ms)
    ??? runtime auth rejects missing token (20 ms)
    ??? usage ingest accepts the Connector single-event shape with dedicated auth (24 ms)
    ??? usage batch projects totals and identical replay is a duplicate (40 ms)
    ??? same usage event ID with a conflicting payload returns 409 without changing totals (22 ms)
    ??? usage task must belong to the supplied operation and a rejected batch is atomic (29 ms)
    ??? usage arriving after terminal completion is reflected in the result (56 ms)
    ??? cancel is tenant-scoped, idempotent, and terminals the task (35 ms)
    ??? cancel of an unknown operation returns 404 (3 ms)
    ??? deadline sweeper times out past-due operations and cancels their tasks (31 ms)
    ??? deadline sweeper ignores operations whose deadline is in the future (24 ms)
    ??? cancel and sweep-deadlines reject missing auth (12 ms)
    ??? R08-01: unknown and revoked API keys are denied fail-closed (10 ms)
    ??? R08-01: admin and runtime credentials cannot substitute for each other (22 ms)
    ??? R08-01/W11-C1: unsafe credential configuration is rejected, not silently weakened (199 ms)
    ??? R08-02/W11-C1: invocation grants carry stable identity, replay the same ID, and conflict on differing hash (94 ms)
    ??? W12-C: expired lease cannot mint a grant even before sweep/reclaim (33 ms)
    ??? W12-C: concurrent identical grant requests converge on one identity and one row (117 ms)
    ??? W12-C: an action declaring no connector slots grants no slot (fail closed) (49 ms)
    ??? W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued (16 ms)
    ??? W13-C: pinned operations grant the pinned connector, and claims carry the pin (47 ms)
    ??? W13-C/PRF-02: a revision change mid-operation keeps the in-flight pin; new submissions pin the new revision (80 ms)
    ??? W13-C: a manifest-declared slot missing from the operation pin is denied (BINDING_DENIED) (44 ms)
    ??? W13-C/children: spawn ??? WAITING_CHILDREN ??? GET children ??? join completes exactly once (106 ms)
    ??? W13-C/children: concurrent completions emit exactly one parent continuation (94 ms)
    ??? W13-C/children: one child failure fails the parent join and cancels siblings (91 ms)
    ??? W13-C/children: spawn rejects stale lease, unknown kind, overlap, and capacity (107 ms)
    ??? W13-C/children: spawn on a terminal task is 410 TASK_TERMINAL (45 ms)
    ??? W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues (95 ms)
    ??? W13-C/resume: unknown wait ??? 404, terminal operation ??? 409, cross-tenant ??? 404 (58 ms)
    ??? W13-C/wait-input: rejects stale lease and terminal task (41 ms)
    ??? W13-C: continuation GET rejects missing runtime auth (1 ms)
    ??? W27-C/cancel: terminal operation closes OPEN human_waits to CANCELLED; no dispatch (48 ms)
    ??? W27-C/deadline: sweep closes OPEN human_waits to EXPIRED (49 ms)
    ??? W27-C/cancel-resume race: resume wins before cancel; wait is ANSWERED then closed (57 ms)
    ??? W27-C/repeated cancel: idempotent with no duplicate dispatch or state churn (49 ms)
  W28-C: version activation / drain / rollback
    ??? activate v2: new submissions select v2, in-flight v1 stays pinned (35 ms)
    ??? activate v1 rollback: re-activating v1 redirects new submissions back to v1 (17 ms)
    ??? drain v2: fail-closed when sole active version is drained; explicit re-activate restores (35 ms)
    ??? activate invalid version ??? 404 (5 ms)
    ??? activate rejects missing admin auth (401)
    ??? concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3) (15 ms)
    ??? activate is idempotent: re-activating the active version returns 200 replayed (12 ms)
  W29-C: Admin authorization negative tests
    ??? enable rejects missing admin auth (401) (1 ms)
    ??? deactivate rejects missing admin auth (401)
    ??? profile-bindings rejects missing admin auth (401) (1 ms)
    ??? enable rejects runtime token (401) ??? role substitution denied (1 ms)
    ??? enable on unregistered version ??? 404 NOT_FOUND (W29-C fix) (2 ms)
    ??? cross-tenant cancel ??? 404 (no information leakage) (32 ms)
    ??? cross-tenant resume ??? 404 (no information leakage) (23 ms)
  W30-C: expired-lease recovery
    ??? expired RUNNING task is recovered: re-dispatched via outbox, old epoch fenced (75 ms)
    ??? unexpired lease is not touched by sweep (41 ms)
    ??? READY task with NULL lease is excluded (idle, not crashed) (23 ms)
    ??? WAITING_INPUT and WAITING_CHILDREN tasks are excluded (21 ms)
    ??? terminal operation excludes a RUNNING task from sweep (15 ms)
    ??? terminal task (FAILED) with stale lease is excluded (13 ms)
    ??? budget exhaustion: expired lease with attempt >= max_attempts ??? terminal FAIL (19 ms)
    ??? repeated sweep is idempotent: second sweep touches nothing (53 ms)
    ??? production hook: listen() starts interval sweep that recovers without explicit call (660 ms)
  W32-C: webhook delivery outbox & dispatch
    ??? callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row (39 ms)
    ??? no callback_url ??? no webhook row on terminal transition (39 ms)
    ??? terminal FAILED via failTask schedules a webhook (36 ms)
    ??? terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate (26 ms)
    ??? terminal TIMED_OUT via deadline sweep schedules a webhook (23 ms)
    ??? signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection
    ?— dispatcher: successful delivery marks DELIVERED with correct signed headers (142 ms)
    ?— dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected (62 ms)
    ?— dispatcher: idempotent ??? no due rows means no attempts; delivered rows stay delivered (51 ms)
  W36-C: operations status & result facade
    ??? toOperationView: canonical shape includes name, links, progress (1 ms)
    ??? isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal
    ??? resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others (1 ms)
    ??? waitForTerminal: returns immediately for terminal op (40 ms)
    ??? GET /operations/:id: returns canonical OperationView with name, links, progress (13 ms)
    ??? GET /operations/:id: non-existent returns 404 (2 ms)
    ??? GET /operations/:id/result: SUCCEEDED returns ResultEnvelope (42 ms)
    ??? GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT (12 ms)
    ??? GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT (22 ms)
    ??? GET /operations/:id/result: TIMED_OUT returns 410 GONE (22 ms)
    ??? GET /operations/:id/result: non-existent returns 404 (2 ms)
    ??? ?wait=0 or absent: returns immediately (no blocking) (13 ms)
    ??? ?wait=5: long-poll holds until operation reaches SUCCEEDED (520 ms)
    ??? ?wait=1: timeout returns current (non-terminal) state (1022 ms)
  W37-C: P2-06 composite ??? children, human wait, deadline, cancel
    ??? RUN-05 composite: fan-out ??? children complete ??? join closes ??? parent resumes to terminal SUCCEEDED (128 ms)
    ??? RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock (83 ms)
    ??? RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED (85 ms)
    ??? RUN-06 composite: wait OPEN ??? resume ANSWERED ??? task QUEUED ??? completion SUCCEEDED (86 ms)
    ??? RUN-06 composite: unknown wait ??? 404; terminal operation resume ??? 409 (82 ms)
    ??? RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation (57 ms)
    ??? RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed) (62 ms)
  W38-A6: P2-09 health and graceful shutdown
    ??? health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases (51 ms)
    ??? health endpoint returns 503 degraded when DB or Redis is unreachable (5 ms)
    ??? drain stops accepting new claims and close() waits for active leases to complete (256 ms)
    ??? graceful shutdown force-closes when active lease exceeds timeout (279 ms)

  ?—? W32-C: webhook delivery outbox & dispatch ??? dispatcher: successful delivery marks DELIVERED with correct signed headers

    expect(received).toBeDefined()

    Received: undefined

      2918 |     expect(attempted).toBeGreaterThanOrEqual(1);
      2919 |     const s = sent.find((x) => x.headers['x-du-delivery-id'] === myDeliveryId);
    > 2920 |     expect(s).toBeDefined();
           |               ^
      2921 |     expect(s!.url).toBe(CALLBACK_URL);
      2922 |     // Signature verifies against the exact sent body + timestamp.
      2923 |     expect(

      at Object.<anonymous> (tests/runtime.test.ts:2920:15)

  ?—? W32-C: webhook delivery outbox & dispatch ??? dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected

    expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 0

      2951 |     expect(row.status).toBe('FAILED');
      2952 |     expect(row.attempts).toBe(2);
    > 2953 |     expect(calls).toBe(2);
           |                   ^
      2954 |     // Delivery failure never changed the operation outcome.
      2955 |     const op = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [operationId]);
      2956 |     expect(op.rows[0]!.state).toBe('SUCCEEDED');

      at Object.<anonymous> (tests/runtime.test.ts:2953:19)

  ?—? W32-C: webhook delivery outbox & dispatch ??? dispatcher: idempotent ??? no due rows means no attempts; delivered rows stay delivered

    expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 0

      2971 |     };
      2972 |     await deliverWebhooks(app.db, { secret, fetchFn: ok });
    > 2973 |     expect(calls).toBe(1);
           |                   ^
      2974 |     // Second sweep: the row is DELIVERED (not PENDING), so nothing is re-sent.
      2975 |     const second = await deliverWebhooks(app.db, { secret, fetchFn: ok });
      2976 |     expect(second).toBe(0);

      at Object.<anonymous> (tests/runtime.test.ts:2973:19)

Test Suites: 1 failed, 1 total
Tests:       3 failed, 94 passed, 97 total
Snapshots:   0 total
Time:        9.767 s
Ran all test suites matching /tests\\runtime.test.ts/i.
```

### Raw output ??? P8-04 isolation suite

```text
node.exe : FAIL tests/integration/p8-04-security-isolation.integration.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/inte...gration.test.ts:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? Test suite failed to run

    SyntaxError: D:\Git\dugate\du-rework\tests\integration\p8-04-security-isolation.integration.test.ts: Unexpected token, expected "from" (2:12)

      1 | import { createHash, randomBytes, randomUUID } from 'node:crypto';
    > 2 | import type { AddressInfo } from 'node:net';
        |             ^
      3 | import { Queue } from 'bullmq';
      4 | import {
      5 |   BusinessManifestSchema,

      at constructor (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parse-error.ts:96:45)
      at Parser.toParseError [as raise] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/tokenizer/index.ts:1504:19)
      at Parser.raise [as unexpected] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/tokenizer/index.ts:1544:16)
      at Parser.unexpected [as expectContextual] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/util.ts:114:12)
      at Parser.expectContextual [as parseImportSpecifiersAndAfter] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3180:10)
      at Parser.parseImportSpecifiersAndAfter [as parseImport] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3148:17)
      at Parser.parseImport [as parseStatementContent] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:647:25)
      at Parser.parseStatementContent [as parseStatementLike] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:482:17)
      at Parser.parseStatementLike [as parseModuleItem] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:419:17)
      at Parser.parseModuleItem [as parseBlockOrModuleBlockBody] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:1443:16)
      at Parser.parseBlockOrModuleBlockBody [as parseBlockBody] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:1417:10)
      at Parser.parseBlockBody [as parseProgram] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:229:10)
      at Parser.parseProgram [as parseTopLevel] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:203:25)
      at Parser.parseTopLevel [as parse] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/index.ts:83:25)
      at parse (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/index.ts:86:38)
      at parser (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/parser/index.ts:29:19)
          at parser.next (<anonymous>)
      at normalizeFile (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transformation/normalize-file.ts:49:24)
          at normalizeFile.next (<anonymous>)
      at run (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transformation/index.ts:41:36)
          at run.next (<anonymous>)
      at transform (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transform.ts:29:20)
          at transform.next (<anonymous>)
      at evaluateSync (../node_modules/.pnpm/gensync@1.0.0-beta.2/node_modules/gensync/index.js:251:28)
      at sync (../node_modules/.pnpm/gensync@1.0.0-beta.2/node_modules/gensync/index.js:89:14)
      at fn (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/errors/rewrite-stack-trace.ts:99:14)
      at transformSync (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transform.ts:66:52)

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        1.858 s
Ran all test suites matching tests/integration/p8-04-security-isolation.integration.test.ts.
```

### Raw output ??? webhook reclaim fence suite

```text
node.exe : PASS tests/webhook-reclaim-fence.live.test.ts (5.196 s)
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (PASS tests/webh...st.ts (5.196 s):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  RR-Q3-4 live - reclaim generation fence + graceful release (real PG, loopback mesh)
    ??? stale claimant A cannot clobber re-claimer B (RETURNING next_at fence over the wire) (1853 ms)
    ??? graceful shutdown releases the live claim to PENDING with budget intact (606 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        5.4 s, estimated 6 s
Ran all test suites matching /tests\\webhook-reclaim-fence.live.test.ts/i.
```

## Tester-1 live rerun ??? final gate verification (2026-09-25)

### DB window

- CLAIM: 2026-09-25 10:24:15.666 +07:00
- RELEASE: 2026-09-25 10:26:33.424 +07:00

### Commands and results

1. Cwd `services/orchestrator`; command `npx jest tests/runtime.test.ts --runInBand`.
   - Jest summary: 1 failed, 96 passed, 97 total; runtime 11.461 s.
   - Jest printed that it did not exit after one second due to asynchronous operations. After confirming the summary had been written, the hanging process was interrupted with Ctrl+C. The exec session ExitCode was 1; the PowerShell post-command `$LASTEXITCODE` echo did not run because of the interrupt.
2. Cwd `du-rework` root; command `npx jest --config tests/integration/jest.config.cjs tests/integration/p8-04-security-isolation.integration.test.ts --runInBand`.
   - ExitCode 1; 1 suite failed, 3 failed, 23 passed, 26 total.

Raw output below is captured from both commands, including Jest diagnostics.

### Raw output ??? runtime suite

```text
node.exe : FAIL tests/runtime.test.ts (11.253 s)
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/runtime.test.ts (11.253 s):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  runtime vertical slice (isolated PG/Redis)
    ??? submit ??? outbox ??? dispatch ??? claim ??? heartbeat ??? checkpoint ??? complete ??? result (170 ms)
    ??? idempotency: same key + same body replays, different body ??? 409 (36 ms)
    ??? lease expiry allows reclaim by another worker (60 ms)
    ??? fail retryable enqueues continuation with future due_at; dispatch respects due_at (61 ms)
    ??? input validation returns 422 on bad submission (7 ms)
    ??? runtime auth rejects missing token (23 ms)
    ??? usage ingest accepts the Connector single-event shape with dedicated auth (28 ms)
    ??? usage batch projects totals and identical replay is a duplicate (43 ms)
    ??? same usage event ID with a conflicting payload returns 409 without changing totals (26 ms)
    ??? usage task must belong to the supplied operation and a rejected batch is atomic (28 ms)
    ??? usage arriving after terminal completion is reflected in the result (73 ms)
    ??? cancel is tenant-scoped, idempotent, and terminals the task (29 ms)
    ??? cancel of an unknown operation returns 404 (3 ms)
    ??? deadline sweeper times out past-due operations and cancels their tasks (31 ms)
    ??? deadline sweeper ignores operations whose deadline is in the future (32 ms)
    ??? cancel and sweep-deadlines reject missing auth (12 ms)
    ??? R08-01: unknown and revoked API keys are denied fail-closed (9 ms)
    ??? R08-01: admin and runtime credentials cannot substitute for each other (22 ms)
    ??? R08-01/W11-C1: unsafe credential configuration is rejected, not silently weakened (203 ms)
    ??? R08-02/W11-C1: invocation grants carry stable identity, replay the same ID, and conflict on differing hash (137 ms)
    ??? W12-C: expired lease cannot mint a grant even before sweep/reclaim (53 ms)
    ??? W12-C: concurrent identical grant requests converge on one identity and one row (189 ms)
    ??? W12-C: an action declaring no connector slots grants no slot (fail closed) (61 ms)
    ??? W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued (23 ms)
    ??? W13-C: pinned operations grant the pinned connector, and claims carry the pin (66 ms)
    ??? W13-C/PRF-02: a revision change mid-operation keeps the in-flight pin; new submissions pin the new revision (99 ms)
    ??? W13-C: a manifest-declared slot missing from the operation pin is denied (BINDING_DENIED) (64 ms)
    ??? W13-C/children: spawn ??? WAITING_CHILDREN ??? GET children ??? join completes exactly once (190 ms)
    ??? W13-C/children: concurrent completions emit exactly one parent continuation (128 ms)
    ??? W13-C/children: one child failure fails the parent join and cancels siblings (95 ms)
    ??? W13-C/children: spawn rejects stale lease, unknown kind, overlap, and capacity (100 ms)
    ??? W13-C/children: spawn on a terminal task is 410 TASK_TERMINAL (43 ms)
    ??? W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues (96 ms)
    ??? W13-C/resume: unknown wait ??? 404, terminal operation ??? 409, cross-tenant ??? 404 (64 ms)
    ??? W13-C/wait-input: rejects stale lease and terminal task (41 ms)
    ??? W13-C: continuation GET rejects missing runtime auth (1 ms)
    ??? W27-C/cancel: terminal operation closes OPEN human_waits to CANCELLED; no dispatch (55 ms)
    ??? W27-C/deadline: sweep closes OPEN human_waits to EXPIRED (57 ms)
    ??? W27-C/cancel-resume race: resume wins before cancel; wait is ANSWERED then closed (57 ms)
    ??? W27-C/repeated cancel: idempotent with no duplicate dispatch or state churn (56 ms)
  W28-C: version activation / drain / rollback
    ??? activate v2: new submissions select v2, in-flight v1 stays pinned (40 ms)
    ??? activate v1 rollback: re-activating v1 redirects new submissions back to v1 (21 ms)
    ??? drain v2: fail-closed when sole active version is drained; explicit re-activate restores (32 ms)
    ??? activate invalid version ??? 404 (2 ms)
    ??? activate rejects missing admin auth (401) (1 ms)
    ??? concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3) (17 ms)
    ??? activate is idempotent: re-activating the active version returns 200 replayed (10 ms)
  W29-C: Admin authorization negative tests
    ??? enable rejects missing admin auth (401) (2 ms)
    ??? deactivate rejects missing admin auth (401) (1 ms)
    ??? profile-bindings rejects missing admin auth (401)
    ??? enable rejects runtime token (401) ??? role substitution denied (1 ms)
    ??? enable on unregistered version ??? 404 NOT_FOUND (W29-C fix) (3 ms)
    ??? cross-tenant cancel ??? 404 (no information leakage) (33 ms)
    ??? cross-tenant resume ??? 404 (no information leakage) (24 ms)
  W30-C: expired-lease recovery
    ??? expired RUNNING task is recovered: re-dispatched via outbox, old epoch fenced (81 ms)
    ??? unexpired lease is not touched by sweep (42 ms)
    ??? READY task with NULL lease is excluded (idle, not crashed) (26 ms)
    ??? WAITING_INPUT and WAITING_CHILDREN tasks are excluded (23 ms)
    ??? terminal operation excludes a RUNNING task from sweep (13 ms)
    ??? terminal task (FAILED) with stale lease is excluded (12 ms)
    ??? budget exhaustion: expired lease with attempt >= max_attempts ??? terminal FAIL (19 ms)
    ??? repeated sweep is idempotent: second sweep touches nothing (63 ms)
    ?— production hook: listen() starts interval sweep that recovers without explicit call (305 ms)
  W32-C: webhook delivery outbox & dispatch
    ??? callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row (50 ms)
    ??? no callback_url ??? no webhook row on terminal transition (50 ms)
    ??? terminal FAILED via failTask schedules a webhook (63 ms)
    ??? terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate (43 ms)
    ??? terminal TIMED_OUT via deadline sweep schedules a webhook (25 ms)
    ??? signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection
    ??? dispatcher: successful delivery marks DELIVERED with correct signed headers (58 ms)
    ??? dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected (74 ms)
    ??? dispatcher: idempotent ??? no due rows means no attempts; delivered rows stay delivered (49 ms)
  W36-C: operations status & result facade
    ??? toOperationView: canonical shape includes name, links, progress
    ??? isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal (1 ms)
    ??? resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others
    ??? waitForTerminal: returns immediately for terminal op (37 ms)
    ??? GET /operations/:id: returns canonical OperationView with name, links, progress (14 ms)
    ??? GET /operations/:id: non-existent returns 404 (2 ms)
    ??? GET /operations/:id/result: SUCCEEDED returns ResultEnvelope (43 ms)
    ??? GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT (13 ms)
    ??? GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT (21 ms)
    ??? GET /operations/:id/result: TIMED_OUT returns 410 GONE (23 ms)
    ??? GET /operations/:id/result: non-existent returns 404 (2 ms)
    ??? ?wait=0 or absent: returns immediately (no blocking) (12 ms)
    ??? ?wait=5: long-poll holds until operation reaches SUCCEEDED (515 ms)
    ??? ?wait=1: timeout returns current (non-terminal) state (1028 ms)
  W37-C: P2-06 composite ??? children, human wait, deadline, cancel
    ??? RUN-05 composite: fan-out ??? children complete ??? join closes ??? parent resumes to terminal SUCCEEDED (124 ms)
    ??? RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock (88 ms)
    ??? RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED (83 ms)
    ??? RUN-06 composite: wait OPEN ??? resume ANSWERED ??? task QUEUED ??? completion SUCCEEDED (89 ms)
    ??? RUN-06 composite: unknown wait ??? 404; terminal operation resume ??? 409 (78 ms)
    ??? RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation (60 ms)
    ??? RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed) (57 ms)
  W38-A6: P2-09 health and graceful shutdown
    ??? health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases (43 ms)
    ??? health endpoint returns 503 degraded when DB or Redis is unreachable (4 ms)
    ??? drain stops accepting new claims and close() waits for active leases to complete (259 ms)
    ??? graceful shutdown force-closes when active lease exceeds timeout (294 ms)

  ?—? W30-C: expired-lease recovery ??? production hook: listen() starts interval sweep that recovers without explicit call

    connect ETIMEDOUT 127.0.0.1:5433

      94 |  */
      95 | async function trackingTableExists(db: Db): Promise<boolean> {
    > 96 |   const res = await db.query<{ exists: boolean }>(
         |               ^
      97 |     `SELECT EXISTS (
      98 |        SELECT 1 FROM information_schema.tables
      99 |        WHERE table_schema = 'public' AND table_name = 'schema_migrations'

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at trackingTableExists (src/db/migrations.ts:96:15)
      at verifyMigrations (src/db/migrations.ts:141:20)
      at createApp (src/server.ts:224:5)
      at Object.<anonymous> (tests/runtime.test.ts:2704:21)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 96 passed, 97 total
Snapshots:   0 total
Time:        11.461 s
Ran all test suites matching /tests\\runtime.test.ts/i.
Jest did not exit one second after the test run has completed.

'This usually means that there are asynchronous operations that weren't stopped in your tests. Consider running Jest with `--detectOpenHandles` to troubleshoot this issue.
```

### Raw output ??? P8-04 security isolation suite

```text
node.exe : FAIL tests/integration/p8-04-security-isolation.integration.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/inte...gration.test.ts:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 1. Cross-Tenant Access Denied (SEC-01, OPS-04) ??? cross-tenant artifact access request is rejected with 409 PERMISSION_DENIED

    expect(received).toMatch(expected)

    Expected pattern: /not belong to task/i
    Received string:  "task is not authorized to read artifact"

      348 |       expect(accessRes.status).toBe(409);
      349 |       expect(accessRes.body.code).toBe('PERMISSION_DENIED');
    > 350 |       expect((accessRes.body.detail as string) || (accessRes.body.title as string)).toMatch(/not belong to task/i);
          |                                                                                     ^
      351 |     });
      352 |   });
      353 |

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:350:85)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? artifact blob upload with forged or invalid grant token is rejected 
with 403 PERMISSION_DENIED

    expect(received).toBe(expected) // Object.is equality

    Expected: 403
    Received: 404

      392 |       });
      393 |
    > 394 |       expect(res.status).toBe(403);
          |                          ^
      395 |       expect(res.body.code).toBe('PERMISSION_DENIED');
      396 |       expect(res.body.message || res.body.title || res.body.detail).toMatch(/invalid artifact blob grant/i);
      397 |     });

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:394:26)

  ?—? P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04) ??? 2. Expired or Foreign Artifact Grant Denied (ART-03) ??? artifact blob upload without grant query param is rejected with 403 
PERMISSION_DENIED

    expect(received).toBe(expected) // Object.is equality

    Expected: 403
    Received: 404

      403 |       });
      404 |
    > 405 |       expect(res.status).toBe(403);
          |                          ^
      406 |       expect(res.body.code).toBe('PERMISSION_DENIED');
      407 |       expect(res.body.message || res.body.title || res.body.detail).toMatch(/invalid artifact blob grant/i);
      408 |     });

      at Object.<anonymous> (p8-04-security-isolation.integration.test.ts:405:26)

Test Suites: 1 failed, 1 total
Tests:       3 failed, 23 passed, 26 total
Snapshots:   0 total
Time:        2.88 s, estimated 3 s
Ran all test suites matching tests/integration/p8-04-security-isolation.integration.test.ts.
```

## Tester-1 live verification ??? 97/97 runtime & 26/26 P8-04 (2026-09-25)

### DB window

- CLAIM: 2026-09-25 10:44:06.653 +07:00
- RELEASE: 2026-09-25 10:44:40.874 +07:00

### Commands and results

1. Cwd `services/orchestrator`; command `npx jest tests/runtime.test.ts --runInBand`.
   - ExitCode 1; 1 suite failed, 97 failed, 97 total (5.25 s). The failures show `connect ETIMEDOUT 127.0.0.1:5433` during PostgreSQL schema setup.
2. Cwd `du-rework` root; command `npx jest --config tests/integration/jest.config.cjs tests/integration/p8-04-security-isolation.integration.test.ts --runInBand`.
   - ExitCode 0; 1 suite passed, 26 passed, 26 total (3.312 s).

### Raw output ??? runtime suite

```text
node.exe : FAIL tests/runtime.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/runtime.test.ts:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? runtime vertical slice (isolated PG/Redis) ??? submit ??? outbox ??? dispatch ??? claim ??? heartbeat ??? checkpoint ??? complete ??? result

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? idempotency: same key + same body replays, different body ??? 409

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? lease expiry allows reclaim by another worker

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? fail retryable enqueues continuation with future due_at; dispatch respects due_at

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? input validation returns 422 on bad submission

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? runtime auth rejects missing token

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? usage ingest accepts the Connector single-event shape with dedicated auth

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? usage batch projects totals and identical replay is a duplicate

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? same usage event ID with a conflicting payload returns 409 without changing totals

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? usage task must belong to the supplied operation and a rejected batch is atomic

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? usage arriving after terminal completion is reflected in the result

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? cancel is tenant-scoped, idempotent, and terminals the task

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? cancel of an unknown operation returns 404

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? deadline sweeper times out past-due operations and cancels their tasks

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? deadline sweeper ignores operations whose deadline is in the future

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? cancel and sweep-deadlines reject missing auth

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? R08-01: unknown and revoked API keys are denied fail-closed

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? R08-01: admin and runtime credentials cannot substitute for each other

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? R08-01/W11-C1: unsafe credential configuration is rejected, not silently weakened

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? R08-02/W11-C1: invocation grants carry stable identity, replay the same ID, and conflict on differing hash

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W12-C: expired lease cannot mint a grant even before sweep/reclaim

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W12-C: concurrent identical grant requests converge on one identity and one row

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W12-C: an action declaring no connector slots grants no slot (fail closed)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C: pinned operations grant the pinned connector, and claims carry the pin

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/PRF-02: a revision change mid-operation keeps the in-flight pin; new submissions pin the new revision

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C: a manifest-declared slot missing from the operation pin is denied (BINDING_DENIED)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/children: spawn ??? WAITING_CHILDREN ??? GET children ??? join completes exactly once

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/children: concurrent completions emit exactly one parent continuation

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/children: one child failure fails the parent join and cancels siblings

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/children: spawn rejects stale lease, unknown kind, overlap, and capacity

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/children: spawn on a terminal task is 410 TASK_TERMINAL

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/resume: unknown wait ??? 404, terminal operation ??? 409, cross-tenant ??? 404

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C/wait-input: rejects stale lease and terminal task

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W13-C: continuation GET rejects missing runtime auth

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W27-C/cancel: terminal operation closes OPEN human_waits to CANCELLED; no dispatch

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W27-C/deadline: sweep closes OPEN human_waits to EXPIRED

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W27-C/cancel-resume race: resume wins before cancel; wait is ANSWERED then closed

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? runtime vertical slice (isolated PG/Redis) ??? W27-C/repeated cancel: idempotent with no duplicate dispatch or state churn

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? activate v2: new submissions select v2, in-flight v1 stays pinned

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? activate v2: new submissions select v2, in-flight v1 stays pinned

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W28-C: version activation / drain / rollback ??? activate v1 rollback: re-activating v1 redirects new submissions back to v1

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? activate v1 rollback: re-activating v1 redirects new submissions back to v1

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W28-C: version activation / drain / rollback ??? drain v2: fail-closed when sole active version is drained; explicit re-activate restores

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? drain v2: fail-closed when sole active version is drained; explicit re-activate restores

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W28-C: version activation / drain / rollback ??? activate invalid version ??? 404

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? activate invalid version ??? 404

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W28-C: version activation / drain / rollback ??? activate rejects missing admin auth (401)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? activate rejects missing admin auth (401)

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W28-C: version activation / drain / rollback ??? concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3)

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W28-C: version activation / drain / rollback ??? activate is idempotent: re-activating the active version returns 200 replayed

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W28-C: version activation / drain / rollback ??? activate is idempotent: re-activating the active version returns 200 replayed

    TypeError: Cannot read properties of undefined (reading 'db')

      2054 |     // Register v2 via direct DB insert (avoids going through the public register
      2055 |     // endpoint, which requires a full manifest shape).
    > 2056 |     await app.db.query(
           |               ^
      2057 |       `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
      2058 |        VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
      2059 |        ON CONFLICT (business_id, version) DO NOTHING`,

      at registerV2 (tests/runtime.test.ts:2056:15)
      at Object.<anonymous> (tests/runtime.test.ts:2066:11)

  ?—? W29-C: Admin authorization negative tests ??? enable rejects missing admin auth (401)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W29-C: Admin authorization negative tests ??? deactivate rejects missing admin auth (401)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W29-C: Admin authorization negative tests ??? profile-bindings rejects missing admin auth (401)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W29-C: Admin authorization negative tests ??? enable rejects runtime token (401) ??? role substitution denied

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W29-C: Admin authorization negative tests ??? enable on unregistered version ??? 404 NOT_FOUND (W29-C fix)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W29-C: Admin authorization negative tests ??? cross-tenant cancel ??? 404 (no information leakage)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W29-C: Admin authorization negative tests ??? cross-tenant resume ??? 404 (no information leakage)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? expired RUNNING task is recovered: re-dispatched via outbox, old epoch fenced

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? unexpired lease is not touched by sweep

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? READY task with NULL lease is excluded (idle, not crashed)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? WAITING_INPUT and WAITING_CHILDREN tasks are excluded

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? terminal operation excludes a RUNNING task from sweep

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? terminal task (FAILED) with stale lease is excluded

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? budget exhaustion: expired lease with attempt >= max_attempts ??? terminal FAIL

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? repeated sweep is idempotent: second sweep touches nothing

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W30-C: expired-lease recovery ??? production hook: listen() starts interval sweep that recovers without explicit call

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? no callback_url ??? no webhook row on terminal transition

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? terminal FAILED via failTask schedules a webhook

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? terminal TIMED_OUT via deadline sweep schedules a webhook

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? dispatcher: successful delivery marks DELIVERED with correct signed headers

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W32-C: webhook delivery outbox & dispatch ??? dispatcher: idempotent ??? no due rows means no attempts; delivered rows stay delivered

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? toOperationView: canonical shape includes name, links, progress

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? waitForTerminal: returns immediately for terminal op

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id: returns canonical OperationView with name, links, progress

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id: non-existent returns 404

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id/result: SUCCEEDED returns ResultEnvelope

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id/result: TIMED_OUT returns 410 GONE

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? GET /operations/:id/result: non-existent returns 404

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? ?wait=0 or absent: returns immediately (no blocking)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? ?wait=5: long-poll holds until operation reaches SUCCEEDED

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W36-C: operations status & result facade ??? ?wait=1: timeout returns current (non-terminal) state

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-05 composite: fan-out ??? children complete ??? join closes ??? parent resumes to terminal SUCCEEDED

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-06 composite: wait OPEN ??? resume ANSWERED ??? task QUEUED ??? completion SUCCEEDED

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-06 composite: unknown wait ??? 404; terminal operation resume ??? 409

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W37-C: P2-06 composite ??? children, human wait, deadline, cancel ??? RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed)

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases

    TypeError: Cannot read properties of undefined (reading 'db')

      3640 |   beforeAll(async () => {
      3641 |     // Clear any uncompleted RUNNING tasks from prior test cases so active lease baseline is 0
    > 3642 |     await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE state='RUNNING'");
           |               ^
      3643 |   });
      3644 |
      3645 |   test('health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases', async () => {

      at Object.<anonymous> (tests/runtime.test.ts:3642:15)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? health endpoint returns 503 degraded when DB or Redis is unreachable

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? health endpoint returns 503 degraded when DB or Redis is unreachable

    TypeError: Cannot read properties of undefined (reading 'db')

      3640 |   beforeAll(async () => {
      3641 |     // Clear any uncompleted RUNNING tasks from prior test cases so active lease baseline is 0
    > 3642 |     await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE state='RUNNING'");
           |               ^
      3643 |   });
      3644 |
      3645 |   test('health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases', async () => {

      at Object.<anonymous> (tests/runtime.test.ts:3642:15)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? drain stops accepting new claims and close() waits for active leases to complete

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? drain stops accepting new claims and close() waits for active leases to complete

    TypeError: Cannot read properties of undefined (reading 'db')

      3640 |   beforeAll(async () => {
      3641 |     // Clear any uncompleted RUNNING tasks from prior test cases so active lease baseline is 0
    > 3642 |     await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE state='RUNNING'");
           |               ^
      3643 |   });
      3644 |
      3645 |   test('health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases', async () => {

      at Object.<anonymous> (tests/runtime.test.ts:3642:15)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? graceful shutdown force-closes when active lease exceeds timeout

    connect ETIMEDOUT 127.0.0.1:5433

      169 |     const { Pool: AdminPool } = await import('pg');
      170 |     const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    > 171 |     await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
          |     ^
      172 |     await adminPool.end();
      173 |   }
      174 |

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (tests/runtime.test.ts:171:5)

  ?—? W38-A6: P2-09 health and graceful shutdown ??? graceful shutdown force-closes when active lease exceeds timeout

    TypeError: Cannot read properties of undefined (reading 'db')

      3640 |   beforeAll(async () => {
      3641 |     // Clear any uncompleted RUNNING tasks from prior test cases so active lease baseline is 0
    > 3642 |     await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE state='RUNNING'");
           |               ^
      3643 |   });
      3644 |
      3645 |   test('health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases', async () => {

      at Object.<anonymous> (tests/runtime.test.ts:3642:15)


  ?—? Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'enableVersionForTest')

      2074 |   afterAll(async () => {
      2075 |     // Restore v1 as the only active+enabled version.
    > 2076 |     await app.enableVersionForTest(BIZ, V1);
           |               ^
      2077 |     // Remove v2 row so it doesn't leak into other test suites.
      2078 |     await app.db.query('DELETE FROM business_versions WHERE business_id=$1 AND version=$2', [BIZ, V2]);
      2079 |     const { Queue: Q } = await import('bullmq');

      at Object.<anonymous> (tests/runtime.test.ts:2076:15)

Test Suites: 1 failed, 1 total
Tests:       97 failed, 97 total
Snapshots:   0 total
Time:        5.25 s, estimated 12 s
Ran all test suites matching /tests\\runtime.test.ts/i.
```

### Raw output ??? P8-04 security isolation suite

```text
node.exe : Test Suites: 1 passed, 1 total
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (Test Suites: 1 passed, 1 total:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
Tests:       26 passed, 26 total
Snapshots:   0 total
Time:        3.312 s
Ran all test suites matching tests/integration/p8-04-security-isolation.integration.test.ts.
```

## Tester-1 runtime isolated rerun (2026-09-25)

Waited 5 seconds before claiming the DB window, as requested.

### DB window

- CLAIM: 2026-09-25 10:46:09.712 +07:00
- RELEASE: 2026-09-25 10:46:49.847 +07:00

### Command and result

- Cwd: `services/orchestrator`
- Command: `npx jest tests/runtime.test.ts --runInBand`
- ExitCode: 0
- Result: 1 suite passed; 97 passed, 97 total (10.317 s).

### Raw output

```text
node.exe : PASS tests/runtime.test.ts (10.104 s)
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (PASS tests/runtime.test.ts (10.104 s):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  runtime vertical slice (isolated PG/Redis)
    ??? submit ??? outbox ??? dispatch ??? claim ??? heartbeat ??? checkpoint ??? complete ??? result (156 ms)
    ??? idempotency: same key + same body replays, different body ??? 409 (27 ms)
    ??? lease expiry allows reclaim by another worker (53 ms)
    ??? fail retryable enqueues continuation with future due_at; dispatch respects due_at (49 ms)
    ??? input validation returns 422 on bad submission (5 ms)
    ??? runtime auth rejects missing token (20 ms)
    ??? usage ingest accepts the Connector single-event shape with dedicated auth (24 ms)
    ??? usage batch projects totals and identical replay is a duplicate (52 ms)
    ??? same usage event ID with a conflicting payload returns 409 without changing totals (47 ms)
    ??? usage task must belong to the supplied operation and a rejected batch is atomic (33 ms)
    ??? usage arriving after terminal completion is reflected in the result (60 ms)
    ??? cancel is tenant-scoped, idempotent, and terminals the task (36 ms)
    ??? cancel of an unknown operation returns 404 (3 ms)
    ??? deadline sweeper times out past-due operations and cancels their tasks (31 ms)
    ??? deadline sweeper ignores operations whose deadline is in the future (23 ms)
    ??? cancel and sweep-deadlines reject missing auth (17 ms)
    ??? R08-01: unknown and revoked API keys are denied fail-closed (11 ms)
    ??? R08-01: admin and runtime credentials cannot substitute for each other (21 ms)
    ??? R08-01/W11-C1: unsafe credential configuration is rejected, not silently weakened (208 ms)
    ??? R08-02/W11-C1: invocation grants carry stable identity, replay the same ID, and conflict on differing hash (95 ms)
    ??? W12-C: expired lease cannot mint a grant even before sweep/reclaim (31 ms)
    ??? W12-C: concurrent identical grant requests converge on one identity and one row (140 ms)
    ??? W12-C: an action declaring no connector slots grants no slot (fail closed) (44 ms)
    ??? W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued (19 ms)
    ??? W13-C: pinned operations grant the pinned connector, and claims carry the pin (54 ms)
    ??? W13-C/PRF-02: a revision change mid-operation keeps the in-flight pin; new submissions pin the new revision (83 ms)
    ??? W13-C: a manifest-declared slot missing from the operation pin is denied (BINDING_DENIED) (47 ms)
    ??? W13-C/children: spawn ??? WAITING_CHILDREN ??? GET children ??? join completes exactly once (115 ms)
    ??? W13-C/children: concurrent completions emit exactly one parent continuation (90 ms)
    ??? W13-C/children: one child failure fails the parent join and cancels siblings (82 ms)
    ??? W13-C/children: spawn rejects stale lease, unknown kind, overlap, and capacity (102 ms)
    ??? W13-C/children: spawn on a terminal task is 410 TASK_TERMINAL (37 ms)
    ??? W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues (97 ms)
    ??? W13-C/resume: unknown wait ??? 404, terminal operation ??? 409, cross-tenant ??? 404 (74 ms)
    ??? W13-C/wait-input: rejects stale lease and terminal task (46 ms)
    ??? W13-C: continuation GET rejects missing runtime auth (1 ms)
    ??? W27-C/cancel: terminal operation closes OPEN human_waits to CANCELLED; no dispatch (57 ms)
    ??? W27-C/deadline: sweep closes OPEN human_waits to EXPIRED (96 ms)
    ??? W27-C/cancel-resume race: resume wins before cancel; wait is ANSWERED then closed (88 ms)
    ??? W27-C/repeated cancel: idempotent with no duplicate dispatch or state churn (68 ms)
  W28-C: version activation / drain / rollback
    ??? activate v2: new submissions select v2, in-flight v1 stays pinned (51 ms)
    ??? activate v1 rollback: re-activating v1 redirects new submissions back to v1 (24 ms)
    ??? drain v2: fail-closed when sole active version is drained; explicit re-activate restores (48 ms)
    ??? activate invalid version ??? 404 (4 ms)
    ??? activate rejects missing admin auth (401) (4 ms)
    ??? concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3) (19 ms)
    ??? activate is idempotent: re-activating the active version returns 200 replayed (13 ms)
  W29-C: Admin authorization negative tests
    ??? enable rejects missing admin auth (401) (1 ms)
    ??? deactivate rejects missing admin auth (401) (1 ms)
    ??? profile-bindings rejects missing admin auth (401) (2 ms)
    ??? enable rejects runtime token (401) ??? role substitution denied (1 ms)
    ??? enable on unregistered version ??? 404 NOT_FOUND (W29-C fix) (3 ms)
    ??? cross-tenant cancel ??? 404 (no information leakage) (34 ms)
    ??? cross-tenant resume ??? 404 (no information leakage) (22 ms)
  W30-C: expired-lease recovery
    ??? expired RUNNING task is recovered: re-dispatched via outbox, old epoch fenced (93 ms)
    ??? unexpired lease is not touched by sweep (45 ms)
    ??? READY task with NULL lease is excluded (idle, not crashed) (24 ms)
    ??? WAITING_INPUT and WAITING_CHILDREN tasks are excluded (23 ms)
    ??? terminal operation excludes a RUNNING task from sweep (14 ms)
    ??? terminal task (FAILED) with stale lease is excluded (14 ms)
    ??? budget exhaustion: expired lease with attempt >= max_attempts ??? terminal FAIL (20 ms)
    ??? repeated sweep is idempotent: second sweep touches nothing (53 ms)
    ??? production hook: listen() starts interval sweep that recovers without explicit call (660 ms)
  W32-C: webhook delivery outbox & dispatch
    ??? callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row (40 ms)
    ??? no callback_url ??? no webhook row on terminal transition (42 ms)
    ??? terminal FAILED via failTask schedules a webhook (37 ms)
    ??? terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate (30 ms)
    ??? terminal TIMED_OUT via deadline sweep schedules a webhook (25 ms)
    ??? signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection (1 ms)
    ??? dispatcher: successful delivery marks DELIVERED with correct signed headers (59 ms)
    ??? dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected (63 ms)
    ??? dispatcher: idempotent ??? no due rows means no attempts; delivered rows stay delivered (55 ms)
  W36-C: operations status & result facade
    ??? toOperationView: canonical shape includes name, links, progress (1 ms)
    ??? isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal
    ??? resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others
    ??? waitForTerminal: returns immediately for terminal op (38 ms)
    ??? GET /operations/:id: returns canonical OperationView with name, links, progress (15 ms)
    ??? GET /operations/:id: non-existent returns 404 (4 ms)
    ??? GET /operations/:id/result: SUCCEEDED returns ResultEnvelope (42 ms)
    ??? GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT (14 ms)
    ??? GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT (25 ms)
    ??? GET /operations/:id/result: TIMED_OUT returns 410 GONE (25 ms)
    ??? GET /operations/:id/result: non-existent returns 404 (3 ms)
    ??? ?wait=0 or absent: returns immediately (no blocking) (15 ms)
    ??? ?wait=5: long-poll holds until operation reaches SUCCEEDED (526 ms)
    ??? ?wait=1: timeout returns current (non-terminal) state (1025 ms)
  W37-C: P2-06 composite ??? children, human wait, deadline, cancel
    ??? RUN-05 composite: fan-out ??? children complete ??? join closes ??? parent resumes to terminal SUCCEEDED (216 ms)
    ??? RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock (126 ms)
    ??? RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED (143 ms)
    ??? RUN-06 composite: wait OPEN ??? resume ANSWERED ??? task QUEUED ??? completion SUCCEEDED (97 ms)
    ??? RUN-06 composite: unknown wait ??? 404; terminal operation resume ??? 409 (91 ms)
    ??? RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation (62 ms)
    ??? RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed) (74 ms)
  W38-A6: P2-09 health and graceful shutdown
    ??? health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases (46 ms)
    ??? health endpoint returns 503 degraded when DB or Redis is unreachable (4 ms)
    ??? drain stops accepting new claims and close() waits for active leases to complete (248 ms)
    ??? graceful shutdown force-closes when active lease exceeds timeout (288 ms)

Test Suites: 1 passed, 1 total
Tests:       97 passed, 97 total
Snapshots:   0 total
Time:        10.317 s
Ran all test suites matching /tests\\runtime.test.ts/i.
```

## Cycle 126+ Reviewer Finding 5 ??? guard-wrapped live suites

Docker precheck during the first claimed window: `du-rework-postgres` Up (healthy) on host port 5433; `du-rework-redis` Up (healthy) on host port 6380.

### Requested root invocations

- DB Window CLAIM: 2026-09-25 11:42:36.066 +07:00
- DB Window RELEASE: 2026-09-25 11:43:08.749 +07:00
- `DU_LIVE_INFRA=1 npx jest services/orchestrator/tests/runtime.test.ts --runInBand` from `du-rework` root: ExitCode 1; suite failed during parse, 0 tests. The root has no Jest config, so Jest used its Babel default and rejected TypeScript `import { createApp, type App }`.
- `DU_LIVE_INFRA=1 npx jest services/orchestrator/tests/webhook-reclaim-fence.live.test.ts --runInBand` from `du-rework` root: ExitCode 1; suite failed during parse, 0 tests. Same root Babel config issue.

### Correct-config rerun

Added the existing `services/orchestrator/jest.config.cjs` (`ts-jest`) while retaining `DU_LIVE_INFRA=1` and the same two suites.

- DB Window CLAIM: 2026-09-25 11:44:34.738 +07:00
- DB Window RELEASE: 2026-09-25 11:45:16.145 +07:00
- Runtime: ExitCode 0; 1 suite passed; 97 passed, 97 total; 13.699 s.
- Webhook reclaim fence: ExitCode 0; 1 suite passed; 2 passed, 2 total; 6.348 s.

### Raw output ??? requested root runtime invocation (parse failure)

```text
node.exe : FAIL services/orchestrator/tests/runtime.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL services/o...runtime.test.ts:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? Test suite failed to run

    SyntaxError: D:\Git\dugate\du-rework\services\orchestrator\tests\runtime.test.ts: Unexpected token, expected "," (3:25)

      1 | import { createHash, randomUUID } from 'node:crypto';
      2 | import { Queue } from 'bullmq';
    > 3 | import { createApp, type App } from '../src/server';
        |                          ^
      4 | import { contentHash, hashInvocationInput } from '@du/contracts';
      5 | import {
      6 |   deliverWebhooks,

      at constructor (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parse-error.ts:96:45)
      at Parser.toParseError [as raise] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/tokenizer/index.ts:1504:19)
      at Parser.raise [as unexpected] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/tokenizer/index.ts:1544:16)
      at Parser.unexpected [as expect] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/util.ts:157:12)
      at Parser.expect [as parseNamedImportSpecifiers] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3443:14)
      at Parser.parseNamedImportSpecifiers [as parseImportSpecifiersAndAfter] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3179:37)
      at Parser.parseImportSpecifiersAndAfter [as parseImport] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3148:17)
      at Parser.parseImport [as parseStatementContent] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:647:25)
      at Parser.parseStatementContent [as parseStatementLike] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:482:17)
      at Parser.parseStatementLike [as parseModuleItem] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:419:17)
      at Parser.parseModuleItem [as parseBlockOrModuleBlockBody] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:1443:16)
      at Parser.parseBlockOrModuleBlockBody [as parseBlockBody] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:1417:10)
      at Parser.parseBlockBody [as parseProgram] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:229:10)
      at Parser.parseProgram [as parseTopLevel] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:203:25)
      at Parser.parseTopLevel [as parse] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/index.ts:83:25)
      at parse (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/index.ts:86:38)
      at parser (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/parser/index.ts:29:19)
          at parser.next (<anonymous>)
      at normalizeFile (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transformation/normalize-file.ts:49:24)
          at normalizeFile.next (<anonymous>)
      at run (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transformation/index.ts:41:36)
          at run.next (<anonymous>)
      at transform (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transform.ts:29:20)
          at transform.next (<anonymous>)
      at evaluateSync (../node_modules/.pnpm/gensync@1.0.0-beta.2/node_modules/gensync/index.js:251:28)
      at sync (../node_modules/.pnpm/gensync@1.0.0-beta.2/node_modules/gensync/index.js:89:14)
      at fn (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/errors/rewrite-stack-trace.ts:99:14)
      at transformSync (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transform.ts:66:52)

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        1.113 s
Ran all test suites matching services/orchestrator/tests/runtime.test.ts.
```

### Raw output ??? requested root webhook fence invocation (parse failure)

```text
node.exe : FAIL services/orchestrator/tests/webhook-reclaim-fence.live.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL services/o...ce.live.test.ts:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? Test suite failed to run

    SyntaxError: D:\Git\dugate\du-rework\services\orchestrator\tests\webhook-reclaim-fence.live.test.ts: Unexpected token, expected "from" (32:12)

      30 | const LIVE = process.env.DU_LIVE_INFRA === '1';
      31 | import { randomUUID } from 'node:crypto';
    > 32 | import type { AddressInfo } from 'node:net';
         |             ^
      33 | import { createApp, type App } from '../src/server';
      34 | import { deliverWebhooks } from '../src/modules/webhooks/webhooks';
      35 | import { BoundaryListener } from '../../../tests/harness/network-boundaries/mock-listener';

      at constructor (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parse-error.ts:96:45)
      at Parser.toParseError [as raise] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/tokenizer/index.ts:1504:19)
      at Parser.raise [as unexpected] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/tokenizer/index.ts:1544:16)
      at Parser.unexpected [as expectContextual] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/util.ts:114:12)
      at Parser.expectContextual [as parseImportSpecifiersAndAfter] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3180:10)
      at Parser.parseImportSpecifiersAndAfter [as parseImport] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:3148:17)
      at Parser.parseImport [as parseStatementContent] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:647:25)
      at Parser.parseStatementContent [as parseStatementLike] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:482:17)
      at Parser.parseStatementLike [as parseModuleItem] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:419:17)
      at Parser.parseModuleItem [as parseBlockOrModuleBlockBody] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:1443:16)
      at Parser.parseBlockOrModuleBlockBody [as parseBlockBody] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:1417:10)
      at Parser.parseBlockBody [as parseProgram] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:229:10)
      at Parser.parseProgram [as parseTopLevel] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/statement.ts:203:25)
      at Parser.parseTopLevel [as parse] (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/parser/index.ts:83:25)
      at parse (../node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser/src/index.ts:86:38)
      at parser (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/parser/index.ts:29:19)
          at parser.next (<anonymous>)
      at normalizeFile (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transformation/normalize-file.ts:49:24)
          at normalizeFile.next (<anonymous>)
      at run (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transformation/index.ts:41:36)
          at run.next (<anonymous>)
      at transform (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transform.ts:29:20)
          at transform.next (<anonymous>)
      at evaluateSync (../node_modules/.pnpm/gensync@1.0.0-beta.2/node_modules/gensync/index.js:251:28)
      at sync (../node_modules/.pnpm/gensync@1.0.0-beta.2/node_modules/gensync/index.js:89:14)
      at fn (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/errors/rewrite-stack-trace.ts:99:14)
      at transformSync (../node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/src/transform.ts:66:52)

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        0.483 s
Ran all test suites matching services/orchestrator/tests/webhook-reclaim-fence.live.test.ts.
```

### Raw output ??? runtime with orchestrator ts-jest config and DU_LIVE_INFRA=1

```text
node.exe : Test Suites: 1 passed, 1 total
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (Test Suites: 1 passed, 1 total:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
Tests:       97 passed, 97 total
Snapshots:   0 total
Time:        13.699 s, estimated 22 s
Ran all test suites matching services/orchestrator/tests/runtime.test.ts.
```

### Raw output ??? webhook fence with orchestrator ts-jest config and DU_LIVE_INFRA=1

```text
node.exe : Test Suites: 1 passed, 1 total
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (Test Suites: 1 passed, 1 total:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        6.348 s
Ran all test suites matching services/orchestrator/tests/webhook-reclaim-fence.live.test.ts.
```

## P8-01 Live Traceability Gate ??? 2026-09-25

### DB window

- CLAIM: 2026-09-25 11:51:04.954 +07:00
- RELEASE: 2026-09-25 11:51:22.716 +07:00

### Run result

- Cwd: `du-rework` root.
- Command: `DU_LIVE_INFRA=1 npx jest --config tests/integration/jest.config.cjs tests/integration/p8-01-traceability.integration.test.ts --runInBand`.
- ExitCode: 1; suite failed during fixture setup at test line 336.
- Finding: PostgreSQL reports `column "credential_source" of relation "connector_revisions" does not exist`. The raw output contains one failing test case and no `Tests:` summary line.

### Raw output

```text
node.exe : FAIL tests/integration/p8-01-traceability.integration.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/inte...gration.test.ts:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? P8-01 persisted operation-to-audit traceability ??? joins operation, root task, invocation grant, provider request, usage, and audit event

    error: column "credential_source" of relation "connector_revisions" does not exist

      82 |     }
      83 |     async query(text, parameters = []) {
    > 84 |         const result = await this.client.query(text, parameters);
         |                        ^
      85 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      86 |     }
      87 |     async transaction(callback) {

      at ../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:694:17
      at PgTransactionClient.query (../../services/connector/dist/db/pg-client.js:84:24)
      at ../../services/connector/dist/db/repository.js:184:28
      at PgSqlClient.transaction (../../services/connector/dist/db/pg-client.js:23:28)
      at Object.<anonymous> (p8-01-traceability.integration.test.ts:336:22)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Snapshots:   0 total
Time:        3.67 s
Ran all test suites matching tests/integration/p8-01-traceability.integration.test.ts.
```

## P8-01 migration 007 and live rerun ??? 2026-09-25

### DB window

- CLAIM: 2026-09-25 12:01:14.611 +07:00
- RELEASE after Jest completed: 2026-09-25 12:07:32.214 +07:00
- Docker precheck: Postgres `du-rework-postgres` and Redis `du-rework-redis` were both healthy.

### Migration preparation

- Suite DB target is the isolated schema on `du_orchestrator_test`, not `public`.
- Applying 007 directly to `public` returned `ERROR: relation "connector_revisions" does not exist`; it changed no schema.
- Prepared isolated schema `du_test_p801_c126_20260925_1201_a91f` for `TEST_RUN_ID=p801_c126_20260925_1201_a91f`.
- Applied `001_connector.sql` to provide the base connector tables, then applied `007_connector_credential_source.sql` in the same schema. The outputs were `CREATE TABLE`/`CREATE INDEX` and `ALTER TABLE`.
- Read-only verification returned `du_test_p801_c126_20260925_1201_a91f|connector_revisions|credential_source|jsonb`.
- Important migration observation: `services/connector/src/db/pg-client.ts` currently enumerates connector migrations 001???005 only. A fresh run will not auto-apply 007 through `PgSqlClient.migrate()`; this run used the explicit schema-scoped application above.

### Suite result

- Command: `DU_LIVE_INFRA=1 TEST_RUN_ID=p801_c126_20260925_1201_a91f npx jest --config tests/integration/jest.config.cjs tests/integration/p8-01-traceability.integration.test.ts --runInBand` from `du-rework` root.
- ExitCode: 1.
- Test failed after 90 seconds with Jest timeout. The `afterAll` hook also exceeded its 30-second timeout; the log shows a post-teardown `require` error, so isolated-schema cleanup is unconfirmed.
- Worker log lines showed `lease lost during heartbeat` followed by `ambiguous runtime report; ending delivery for redelivery`. P8-01 traceability assertions did not pass.

### Raw output ??? failed public-schema apply

```text
ERROR:  relation "connector_revisions" does not exist
```

### Raw output ??? isolated migration apply and verification

```text
CREATE SCHEMA
CREATE TABLE
CREATE TABLE
CREATE INDEX
CREATE TABLE
CREATE INDEX
CREATE TABLE
CREATE INDEX
ALTER TABLE
du_test_p801_c126_20260925_1201_a91f|connector_revisions|credential_source|jsonb
```

### Raw output ??? P8-01 live suite

```text
{"operationId":"d79f83f2-dcdf-4268-9e35-6b896b55ff1d","businessId":"document-core","businessVersion":"1.0.0","timestamp":"2026-09-25T05:06:19.525Z","level":"warn","service":"worker:document-core","environment":"test","correlationId":"p8-01-submit-73492c75-6a81-4a43-bef3-0e138d709f55","taskId":"e01314bb-ea80-407a-b44a-4b367b809327","invocationId":null,"message":"lease lost during heartbeat; aborting context"}
{"operationId":"d79f83f2-dcdf-4268-9e35-6b896b55ff1d","businessId":"document-core","businessVersion":"1.0.0","timestamp":"2026-09-25T05:06:49.452Z","level":"warn","service":"worker:document-core","environment":"test","correlationId":"p8-01-submit-73492c75-6a81-4a43-bef3-0e138d709f55","taskId":"e01314bb-ea80-407a-b44a-4b367b809327","invocationId":null,"message":"ambiguous runtime report; ending delivery for redelivery"}
node.exe : FAIL tests/integration/p8-01-traceability.integration.test.ts (121.302 s)
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/inte....ts (121.302 s):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? P8-01 persisted operation-to-audit traceability ??? joins operation, root task, invocation grant, provider request, usage, and audit event

    thrown: "Exceeded timeout of 90000 ms for a test.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

      at _getError (../../../node_modules/.pnpm/jest-circus@30.5.2/node_modules/jest-circus/build/jestAdapterInit.js:1985:12)
          at Array.map (<anonymous>)

    Cause:
        thrown: "Exceeded timeout of 90000 ms for a test.
        Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

          464 |   }, 30_000);
          465 |
        > 466 |   test('joins operation, root task, invocation grant, provider request, usage, and audit event', async () => {
              |   ^
          467 |     if (!app) throw new Error('Orchestrator fixture was not initialized');
          468 |
          469 |     const submissionCorrelationId = `p8-01-submit-${randomUUID()}`;

          at p8-01-traceability.integration.test.ts:466:3
          at Object.<anonymous> (p8-01-traceability.integration.test.ts:154:1)


  ?—? Test suite failed to run

    thrown: "Exceeded timeout of 30000 ms for a hook.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

      at _getError (../../../node_modules/.pnpm/jest-circus@30.5.2/node_modules/jest-circus/build/jestAdapterInit.js:1985:12)
          at Array.map (<anonymous>)

    Cause:
     

          421 |   }, 45_000);
          422 |
        > 423 |   afterAll(async () => {
              |   ^
          424 |     releaseStepSave?.();
          425 |     const cleanupErrors: Error[] = [];
          426 |     const attemptCleanup = async (name: string, cleanup: () => Promise<void>): Promise<void> => {

          at p8-01-traceability.integration.test.ts:423:3
          at Object.<anonymous> (p8-01-traceability.integration.test.ts:154:1)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Snapshots:   0 total
Time:        121.55 s
Ran all test suites matching tests/integration/p8-01-traceability.integration.test.ts.

ReferenceError: You are trying to `require` a file after the Jest environment has been torn down. From p8-01-traceability.integration.test.ts.

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at getStream (../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/stream.js:22:17)
      at new Connection (../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/connection.js:19:36)
      at new Client (../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:91:7)
      at BoundPool.newClient (../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:241:20)
      at BoundPool.connect (../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:235:10)
      at BoundPool.query (../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:449:10)
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:40)
      at p8-01-traceability.integration.test.ts:454:31
      at attemptCleanup (p8-01-traceability.integration.test.ts:428:15)
      at Object.<anonymous> (p8-01-traceability.integration.test.ts:453:15)
```

## OIDC-02 multi-replica live Redis run ??? 2026-09-25

- DB window CLAIM: 2026-09-25 12:14:46.589 +07:00
- DB window RELEASE: 2026-09-25 12:16:40.851 +07:00 (Jest had printed its suite summary but remained alive on an open handle; stopped with Ctrl+C, the OIDC-02 Jest workload had ended)
- CWD: D:\Git\dugate\du-rework\services\orchestrator
- Command: npx jest tests/oidc02-multi-replica-offline.test.ts --runInBand
- Environment: DU_LIVE_INFRA=true; REDIS_URL=redis://127.0.0.1:6380
- Prerun infra: docker compose reported du-rework-postgres and du-rework-redis Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; pg_isready: /var/run/postgresql:5432 - accepting connections.
- Actual: ExitCode 1; 1 suite failed; 3 failed, 13 passed, 16 total. The 13 offline/fake-backed cases passed. All 3 real-Redis cases (SHARE, REVOKE, EXPIRY) failed before their assertions because the initial session SET was rejected with 'Stream isn't writeable and enableOfflineQueue options is false'. Therefore cross-replica behavior against :6380 is NOT verified by this run.
- The failure points to the live test starting Redis commands before its ioredis connection is ready (test beforeAll constructs the gateway synchronously; live gateway disables offline queue). Redis health probes were successful immediately before CLAIM.
- Process note: Jest printed the failed summary and open-handle warning; the command did not terminate on its own, so it was interrupted after the summary. Captured runner/session exit was 1. No key writes were observed before the initial SET rejected; live test cleanup attempted gateway close but also reported the stream error.
- Captured output file: %TEMP%\oidc02-multi-replica-live-20260925.log

### Raw Jest output (captured with Tee-Object)

```text
node.exe : FAIL tests/oidc02-multi-replica-offline.test.ts
At C:\nvm4w\nodejs\npx.ps1:29 char:3
+   & $NODE_EXE $NPX_CLI_JS $args
+   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (FAIL tests/oidc...offline.test.ts:Strin 
   g) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  ?—? DU_LIVE_INFRA=1 ??? real Redis edition (Tester-1 window) ??? SHARE: mint on A, 
authenticate on B through the dispatcher resolver

    Stream isn't writeable and enableOfflineQueue options is false

      196 |     },
      197 |     async set(key, value, ttlSeconds) {
    > 198 |       await client.set(key, value, 'EX', ttlSeconds);
          |                    ^
      199 |     },
      200 |     async del(...keys) {
      201 |       return keys.length > 0 ? client.del(...keys) : 0;

      at EventEmitter.sendCommand 
(../../node_modules/.pnpm/ioredis@5.11.1/node_modules/ioredis/built/Redis.js:376:32)
      at EventEmitter.set (../../node_modules/.pnpm/ioredis@5.11.1/node_modules/iored
is/built/utils/Commander.js:90:25)
      at Object.set (src/modules/auth/redis-session-repository.ts:198:20)
      at Object.set (src/modules/auth/redis-session-repository.ts:147:19)
      at Object.create (src/modules/auth/session-store.ts:169:21)
      at Object.<anonymous> (tests/oidc02-multi-replica-offline.test.ts:339:29)

  ?—? DU_LIVE_INFRA=1 ??? real Redis edition (Tester-1 window) ??? REVOKE: revokePrincipal 
on A removes both sessions from B (real clock, real Redis)

    Stream isn't writeable and enableOfflineQueue options is false

      196 |     },
      197 |     async set(key, value, ttlSeconds) {
    > 198 |       await client.set(key, value, 'EX', ttlSeconds);
          |                    ^
      199 |     },
      200 |     async del(...keys) {
      201 |       return keys.length > 0 ? client.del(...keys) : 0;

      at EventEmitter.sendCommand 
(../../node_modules/.pnpm/ioredis@5.11.1/node_modules/ioredis/built/Redis.js:376:32)
      at EventEmitter.set (../../node_modules/.pnpm/ioredis@5.11.1/node_modules/iored
is/built/utils/Commander.js:90:25)
      at Object.set (src/modules/auth/redis-session-repository.ts:198:20)
      at Object.set (src/modules/auth/redis-session-repository.ts:147:19)
      at Object.create (src/modules/auth/session-store.ts:169:21)
      at Object.<anonymous> (tests/oidc02-multi-replica-offline.test.ts:352:24)

  ?—? DU_LIVE_INFRA=1 ??? real Redis edition (Tester-1 window) ??? EXPIRY on the real 
clock: idle-dead while the absolute is far, then absolute-dead despite recent 
activity

    Stream isn't writeable and enableOfflineQueue options is false

      196 |     },
      197 |     async set(key, value, ttlSeconds) {
    > 198 |       await client.set(key, value, 'EX', ttlSeconds);
          |                    ^
      199 |     },
      200 |     async del(...keys) {
      201 |       return keys.length > 0 ? client.del(...keys) : 0;

      at EventEmitter.sendCommand 
(../../node_modules/.pnpm/ioredis@5.11.1/node_modules/ioredis/built/Redis.js:376:32)
      at EventEmitter.set (../../node_modules/.pnpm/ioredis@5.11.1/node_modules/iored
is/built/utils/Commander.js:90:25)
      at Object.set (src/modules/auth/redis-session-repository.ts:198:20)
      at Object.set (src/modules/auth/redis-session-repository.ts:147:19)
      at Object.create (src/modules/auth/session-store.ts:169:21)
      at Object.<anonymous> (tests/oidc02-multi-replica-offline.test.ts:367:30)


  ?—? Test suite failed to run

    Stream isn't writeable and enableOfflineQueue options is false

      217 |     },
      218 |     async close() {
    > 219 |       await client.quit();
          |                    ^
      220 |     },
      221 |   };
      222 | }

      at EventEmitter.sendCommand 
(../../node_modules/.pnpm/ioredis@5.11.1/node_modules/ioredis/built/Redis.js:376:32)
      at EventEmitter.quit (../../node_modules/.pnpm/ioredis@5.11.1/node_modules/iore
dis/built/utils/Commander.js:90:25)
      at Object.close (src/modules/auth/redis-session-repository.ts:219:20)
      at Object.<anonymous> (tests/oidc02-multi-replica-offline.test.ts:332:28)

Test Suites: 1 failed, 1 total
Tests:       3 failed, 13 passed, 16 total
Snapshots:   0 total
Time:        2.202 s
Ran all test suites matching /tests\\oidc02-multi-replica-offline.test.ts/i.
Jest did not exit one second after the test run has completed.

'This usually means that there are asynchronous operations that weren't stopped in 
your tests. Consider running Jest with `--detectOpenHandles` to troubleshoot this 
issue.

```

- Post-release process audit: unrelated Connector Jest runner processes were present (observed PIDs 23740, 9076, 9184; command lines referenced connector Jest). Their owner and whether they used the DB window could not be established; no OIDC-02 Jest process remained.

## OIDC-02 multi-replica live Redis rerun (Qwen-2 fix) ??? 2026-09-25

- DB window CLAIM: 2026-09-25 12:31:11.992 +07:00
- DB window RELEASE: 2026-09-25 12:31:18.887 +07:00 (suite exited; window released immediately after command completion)
- CWD: D:\Git\dugate\du-rework\services\orchestrator
- Command: npx.cmd jest tests/oidc02-multi-replica-offline.test.ts --runInBand (PowerShell npx entrypoint)
- Environment: DU_LIVE_INFRA=1; REDIS_URL=redis://127.0.0.1:6380
- Pre-run source check: guard is process.env.DU_LIVE_INFRA === '1'; async beforeAll awaits gateway.ready?.() before tests.
- Prerun infra: du-rework-postgres and du-rework-redis Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; pg_isready: /var/run/postgresql:5432 - accepting connections.
- Result: ExitCode 0; 1 suite passed; 16 passed, 16 total. All 13 offline cases and all 3 real-Redis cases passed.
- Live Redis evidence: SHARE passed with session minted on replica A authenticating on B; REVOKE passed with A revoking both sessions and B observing both absent; EXPIRY passed for idle and absolute expiry on the real clock. Redis endpoint was redis://127.0.0.1:6380.
- Captured output file: %TEMP%\oidc02-multi-replica-live-rerun-20260925.log

### Raw Jest output (captured with Tee-Object)

```text
npx.cmd : PASS tests/oidc02-multi-replica-offline.test.ts (5.381 s)
At line:2 char:245
+ ... .0.1:6380'; npx.cmd jest tests/oidc02-multi-replica-offline.test.ts - ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (PASS tests/oidc...st.ts (5.381 s):Strin 
   g) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
  OIDC-02 SHARE: one Redis, every replica sees the same truth
    ??? session minted on A authenticates on B through the REAL dispatcher resolver 
(role+tenant+CSRF) (5 ms)
    ??? logout on B is immediately dead on A (one-key truth, not per-process tables)
  OIDC-02 REVOKE: one decision kills every live session of a principal
    ??? two replicas each mint a session for the SAME principal; revokePrincipal on A 
??? 0 left on B (1 ms)
    ??? revoke survives a full process restart (nothing to resurrect ??? deletion IS the 
state)
    ??? a NEW login after revoke works (revoke kills sessions, never blacklists 
principals)
  OIDC-02 FAIL-CLOSED + ROTATION across replicas (cycle 127)
    ??? A destroys; B-side dispatcher resolution is null from that instant (401 at the 
route) (1 ms)
    ??? revokePrincipal on A also nullifies B-side resolution for BOTH sessions of the 
principal
    ??? rotate on A (post-login fixation defense): old id dead on B, new id 
authenticates on B (5 ms)
    ??? double rotate: the pre-rotation id can never rotate again on ANY replica (1 ms)
  OIDC-02 EXPIRY: absolute never extends, idle slides, Redis TTL agrees
    ??? absolute TTL: activity on another replica must NOT buy extra life
    ??? idle expiry is judged on the SHARED lastSeenAt: a stranger replica evicts it 
(1 ms)
    ??? Redis-native TTL fires even with ZERO readers (a totally idle cluster 
self-cleans)
  OIDC-02 LOAD BALANCER: rotation across four replicas
    ??? alternating reads keep ONE key with the newest lastSeenAt; destroy once kills 
four (1 ms)
  DU_LIVE_INFRA=1 ??? real Redis edition (Tester-1 window)
    ??? SHARE: mint on A, authenticate on B through the dispatcher resolver (5 ms)
    ??? REVOKE: revokePrincipal on A removes both sessions from B (real clock, real 
Redis) (6 ms)
    ??? EXPIRY on the real clock: idle-dead while the absolute is far, then 
absolute-dead despite recent activity (3446 ms)

Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total
Snapshots:   0 total
Time:        5.583 s
Ran all test suites matching /tests\\oidc02-multi-replica-offline.test.ts/i.

```



## P8-01 live traceability final rerun ??? 2026-09-25

- DB window CLAIM: 2026-09-25 12:44:28.243 +07:00
- DB window RELEASE: 2026-09-25 12:46:32.103 +07:00 (Jest had completed the test and cleanup timeouts; runner was interrupted to release the window)
- Pre-claim build: services/connector ??? npm run build, ExitCode 0. Verified connector dist migration runner lists 006_connector_revision_lifecycle and 007_connector_credential_source.
- CWD for suite: D:\Git\dugate\du-rework
- Command: npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/p8-01-traceability.integration.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; database postgresql://du:du-test-only@localhost:5433/du_orchestrator_test; Redis redis://localhost:6380.
- Prerun infra: docker compose showed du-rework-postgres and du-rework-redis Up (healthy). Final direct TCP probes: 5433=True, 6380=True; Redis PING=PONG; pg_isready accepted connections. Test-NetConnection initially reported 6380=False once; direct TCP retry succeeded before CLAIM.
- Result: Jest ExitCode 1; 1 suite failed, 1 test failed. The traceability test exceeded its 90,000 ms timeout. afterAll then exceeded its 30,000 ms hook timeout. Jest reported total time 122.834 s.
- Runtime evidence: worker logged ambiguous runtime report and ended delivery for redelivery. The final ReferenceError occurred during cleanup after Jest environment teardown while PgSqlClient attempted a query. Isolated-schema cleanup completion is unconfirmed.
- Captured output: %TEMP%\p8-01-live-traceability-final-20260925.log

### Raw Jest output (UTF-8 redirected stdout and stderr)

```text
{"operationId":"3975363f-ae86-4f72-ac51-62b4593a8baa","businessId":"document-core","businessVersion":"1.0.0","timestamp":"2026-09-25T05:46:01.929Z","level":"warn","service":"worker:document-core","environment":"test","correlationId":"p8-01-submit-29f80c7c-dea9-4e19-99cc-3067c950ef8c","taskId":"53537a86-5491-41a2-aeea-93d3eb7c9e20","invocationId":null,"message":"ambiguous runtime report; ending delivery for redelivery"}
FAIL tests/integration/p8-01-traceability.integration.test.ts (122.566 s)
  ?—? P8-01 persisted operation-to-audit traceability ??? joins operation, root task, invocation grant, provider request, usage, and audit event

    thrown: "Exceeded timeout of 90000 ms for a test.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

      at _getError (../../../node_modules/.pnpm/jest-circus@30.5.2/node_modules/jest-circus/build/jestAdapterInit.js:1985:12)
          at Array.map (<anonymous>)

    Cause:
        thrown: "Exceeded timeout of 90000 ms for a test.
        Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

          464 |   }, 30_000);
          465 |
        > 466 |   test('joins operation, root task, invocation grant, provider request, usage, and audit event', async () => {
              |   ^
          467 |     if (!app) throw new Error('Orchestrator fixture was not initialized');
          468 |
          469 |     const submissionCorrelationId = `p8-01-submit-${randomUUID()}`;

          at p8-01-traceability.integration.test.ts:466:3
          at Object.<anonymous> (p8-01-traceability.integration.test.ts:154:1)


  ?—? Test suite failed to run

    thrown: "Exceeded timeout of 30000 ms for a hook.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."

      at _getError (../../../node_modules/.pnpm/jest-circus@30.5.2/node_modules/jest-circus/build/jestAdapterInit.js:1985:12)
          at Array.map (<anonymous>)

    Cause:
     

          421 |   }, 45_000);
          422 |
        > 423 |   afterAll(async () => {
              |   ^
          424 |     releaseStepSave?.();
          425 |     const cleanupErrors: Error[] = [];
          426 |     const attemptCleanup = async (name: string, cleanup: () => Promise<void>): Promise<void> => {

          at p8-01-traceability.integration.test.ts:423:3
          at Object.<anonymous> (p8-01-traceability.integration.test.ts:154:1)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Snapshots:   0 total
Time:        122.834 s
Ran all test suites matching tests/integration/p8-01-traceability.integration.test.ts.

ReferenceError: You are trying to `require` a file after the Jest environment has been torn down. From p8-01-traceability.integration.test.ts.

      14 |     }
      15 |     async query(text, parameters = []) {
    > 16 |         const result = await this.pool.query(text, parameters);
         |                                        ^
      17 |         return { rows: result.rows, rowCount: result.rowCount ?? undefined };
      18 |     }
      19 |     async transaction(callback) {

      at getStream (../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/stream.js:22:17)
      at new Connection (../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/connection.js:19:36)
      at new Client (../../node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js:91:7)
      at BoundPool.newClient (../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:241:20)
      at BoundPool.connect (../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:235:10)
      at BoundPool.query (../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:449:10)
      at PgSqlClient.query (../../services/connector/dist/db/pg-client.js:16:40)
      at p8-01-traceability.integration.test.ts:454:31
      at attemptCleanup (p8-01-traceability.integration.test.ts:428:15)
      at Object.<anonymous> (p8-01-traceability.integration.test.ts:453:15)

```



## SEC-INT-01 credential lifecycle live run ??? 2026-09-25

- DB window CLAIM: 2026-09-25 12:55:24.538 +07:00
- DB window RELEASE: 2026-09-25 12:55:38.334 +07:00 (suite command completed; released immediately)
- CWD: D:\Git\dugate\du-rework
- Command: npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/sec-int-01-credential-lifecycle.integration.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; DU_SECINT=1; PostgreSQL :5433; Redis :6380.
- Prerun infra: both Docker containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; pg_isready accepted connections.
- Result: Jest ExitCode 1; 1 suite failed; 2 failed, 3 passed, 5 total.
- Finding 1: revoke/rotation fail-closed test expected HTTP 404 but received 500 at sec-int-01-credential-lifecycle.integration.test.ts:211; orchestrator logged an unhandled request error for /api/v1/admin/connectors/secint-openai/credentials.
- Finding 2: audit/log hygiene test failed because relation admin_audit does not exist in the isolated test schema at line 248.
- Jest printed an open-handle warning after its summary; the test command returned and the DB window was released. Raw output is below.
- Captured output: %TEMP%\sec-int-01-credential-lifecycle-20260925.log

### Raw Jest output (UTF-8 redirected stdout and stderr)

```text
{"errorName":"HttpError","pathname":"/api/v1/admin/connectors/secint-openai/credentials","timestamp":"2026-09-25T05:55:28.275Z","level":"error","service":"orchestrator","environment":"test","correlationId":"0713bf45-d79b-4378-aa5c-55c25a8f7cbb","taskId":null,"invocationId":null,"message":"unhandled request error"}
FAIL tests/integration/sec-int-01-credential-lifecycle.integration.test.ts
  ?—? SEC-INT-01 rotation/revocation across orchestrator???connector???vault ??? revoke action retires the whole chain; further rotations 404 fail-closed

    expect(received).toBe(expected) // Object.is equality

    Expected: 404
    Received: 500

      209 |       body: { ...VAULT_REF, value: SENTINEL },
      210 |     });
    > 211 |     expect(again.status).toBe(404);
          |                          ^
      212 |   });
      213 |
      214 |   it('reader identity survives lease rotation via the renewal daemon (no failed reads)', async () => {

      at Object.<anonymous> (sec-int-01-credential-lifecycle.integration.test.ts:211:26)

  ?—? SEC-INT-01 rotation/revocation across orchestrator???connector???vault ??? audit + log hygiene: no sentinel anywhere after the full cycle

    error: relation "admin_audit" does not exist

      246 |
      247 |   it('audit + log hygiene: no sentinel anywhere after the full cycle', async () => {
    > 248 |     const audit = await orch.db.query('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 50');
          |                   ^
      249 |     expect(JSON.stringify(audit.rows)).not.toContain(SENTINEL);
      250 |     const dumps = await orch.db.query(
      251 |       `SELECT to_jsonb(t)::text AS j FROM admin_idempotency t ORDER BY created_at DESC LIMIT 50`,

      at ../../node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js:45:11
      at Object.<anonymous> (sec-int-01-credential-lifecycle.integration.test.ts:248:19)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 3 passed, 5 total
Snapshots:   0 total
Time:        3.012 s
Ran all test suites matching tests/integration/sec-int-01-credential-lifecycle.integration.test.ts.
Jest did not exit one second after the test run has completed.

'This usually means that there are asynchronous operations that weren't stopped in your tests. Consider running Jest with `--detectOpenHandles` to troubleshoot this issue.

```


## SEC-INT-01 credential lifecycle live rerun (Qwen-3 fixes) ??? 2026-09-25

- DB window CLAIM: 2026-09-25 13:12:30.938 +07:00
- DB window RELEASE: 2026-09-25 13:12:44.993 +07:00 (suite command completed; released immediately)
- CWD: D:\Git\dugate\du-rework
- Command: npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/sec-int-01-credential-lifecycle.integration.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; DU_SECINT=1; PostgreSQL :5433; Redis :6380.
- Prerun: both Docker containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; PostgreSQL ready. Verified orchestrator dist exports/uses isHttpError; suite query uses admin_audit_events.
- Result: ExitCode 0; 1 suite passed; 5 passed, 5 total.
- Jest emitted its open-handle warning after the passing summary; the command returned successfully and DB window was released.
- Captured output: %TEMP%\sec-int-01-credential-lifecycle-rerun-20260925.log

### Raw Jest output (UTF-8 redirected stdout and stderr)
```
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        2.612 s, estimated 3 s
Ran all test suites matching tests/integration/sec-int-01-credential-lifecycle.integration.test.ts.
Jest did not exit one second after the test run has completed.

'This usually means that there are asynchronous operations that weren't stopped in your tests. Consider running Jest with `--detectOpenHandles` to troubleshoot this issue.

```


## P8-01 live traceability barrier/teardown rerun ??? 2026-09-25

- DB window CLAIM: 2026-09-25 13:14:39.296 +07:00
- DB window RELEASE: 2026-09-25 13:14:48.821 +07:00 (suite command completed; released immediately)
- CWD: D:\Git\dugate\du-rework
- Command: npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/p8-01-traceability.integration.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; PostgreSQL :5433; Redis :6380.
- Prerun infra: both Docker containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; PostgreSQL ready.
- Source precheck: live gate is DU_LIVE_INFRA=1; fixture has a 5s safety release timer and idempotent barrier release; afterAll logs cleanup errors.
- Result: ExitCode 0; 1 suite passed; 1 passed, 1 total. No Jest open-handle warning.
- Captured output: %TEMP%\p8-01-live-traceability-barrier-rerun-20260925.log

### Raw Jest output (UTF-8 redirected stdout and stderr)
```
{"operationId":"dbc84c80-9355-42b7-aba8-3a4deaca0580","businessId":"document-core","businessVersion":"1.0.0","errorCode":"STATE_CONFLICT","timestamp":"2026-09-25T06:14:48.442Z","level":"error","service":"worker:document-core","environment":"test","correlationId":"p8-01-submit-d26516d7-ad6e-469b-8e68-59419f3a9eb5","taskId":"5b7b450a-3b13-456e-9d01-2590dfb888d7","invocationId":null,"message":"handler failed"}
{"operationId":"dbc84c80-9355-42b7-aba8-3a4deaca0580","businessId":"document-core","businessVersion":"1.0.0","code":"TASK_TERMINAL","timestamp":"2026-09-25T06:14:48.449Z","level":"warn","service":"worker:document-core","environment":"test","correlationId":"p8-01-submit-d26516d7-ad6e-469b-8e68-59419f3a9eb5","taskId":"5b7b450a-3b13-456e-9d01-2590dfb888d7","invocationId":null,"message":"fail report fenced"}
Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        8.348 s, estimated 123 s
Ran all test suites matching tests/integration/p8-01-traceability.integration.test.ts.

```


## SEC-INT-01 live rerun after connection-pool cleanup ??? 2026-09-25

- DB window CLAIM: 2026-09-25 13:31:31.836 +07:00
- DB window RELEASE: 2026-09-25 13:31:36.374 +07:00 (suite command completed; released immediately)
- CWD: D:\Git\dugate\du-rework
- Command: npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/sec-int-01-credential-lifecycle.integration.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; DU_SECINT=1; PostgreSQL :5433; Redis :6380.
- Prerun infra: both Docker containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; PostgreSQL ready.
- Result: ExitCode 0; 1 suite passed; 5 passed, 5 total.
- Open-handle verification: no Jest open-handle warning appeared in the captured output.
- Captured output: %TEMP%\sec-int-01-credential-lifecycle-poolcleanup-20260925.log

### Raw Jest output (UTF-8 redirected stdout and stderr)
```
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        3.037 s
Ran all test suites matching tests/integration/sec-int-01-credential-lifecycle.integration.test.ts.

```


## OIDC-02 process replicas live Redis rerun ??? 2026-09-25

- DB window CLAIM: 2026-09-25 14:12:10.277 +07:00
- DB window RELEASE: 2026-09-25 14:12:32.290 +07:00 (suite completed; released immediately)
- CWD: D:\Git\dugate\du-rework\services\orchestrator
- Build command: pnpm.cmd run build; ExitCode 0.
- Jest command: npx.cmd jest tests/oidc02-process-replicas-offline.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; REDIS_URL=redis://127.0.0.1:6380; PostgreSQL :5433 and Redis :6380 window claimed.
- Prerun infra: both containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; PostgreSQL ready.
- Result: Jest ExitCode 1; 1 suite failed; 2 failed, 8 passed, 10 total; no skipped tests reported.
- Live cases: 3/4 passed (logout, rotation, expiry); SHARE failed because login returned HTTP 500 instead of expected 302. Offline cases: 5/6 passed; login/callback test failed with fetch ETIMEDOUT connecting to 127.0.0.1:58024 in tests/fixtures/oidc02-replica-harness.ts:84.
- Teardown: post-run process query found no node processes matching oidc02-replica-probe.js or oidc02-process-replicas-offline.test.ts; no Jest open-handle warning appeared.
- Captured logs: %TEMP%\oidc02-process-replicas-build-20260925.log and %TEMP%\oidc02-process-replicas-live-20260925.log

### Raw build output
```text

> @du/orchestrator@0.1.0 build D:\Git\dugate\du-rework\services\orchestrator
> tsc -p tsconfig.json


```
### Raw Jest output

```text
FAIL tests/oidc02-process-replicas-offline.test.ts (14.928 s)
  cross-process callback + cookie
    ?— login STARTED on A COMPLETES on B; the cookie serves BOTH routers (same SEC-00 plane) (316 ms)
  cross-process cookie logout
    ??? logout AT B clears the cookie AND kills the session for A (30 ms)
  cross-process rotation (session-fixation defense)
    ??? rotate on B: OLD cookie dies everywhere, rotated cookie lives everywhere (12 ms)
  cross-process restart + revoke
    ??? a RESTARTED replica serves the pre-restart session; revoke before restart stays dead after (31 ms)
  cross-process expiry (real clock, short windows)
    ??? ABSOLUTE deadline evicts on every replica ??? activity cannot buy life (1767 ms)
    ??? SLIDING idle uses the SHARED lastSeenAt: a touch on B keeps A alive too (2818 ms)
  DU_LIVE_INFRA='1' ??? TWO REAL PROCESSES, real Redis
    ?— mint through A callback-onto-B; BOTH processes resolve the cookie (real Redis, real procs) (11 ms)
    ??? logout AT B kills the session for A (server-side, cross-process) (104 ms)
    ??? rotation through B: old cookie dead on BOTH processes, rotated live on BOTH (39 ms)
    ??? idle expiry on the REAL clock evicts on every process (idle 5s window) (5636 ms)

  ?—? cross-process callback + cookie ??? login STARTED on A COMPLETES on B; the cookie serves BOTH routers (same SEC-00 plane)

    TypeError: fetch failed

      82 |
      83 | const fetchImpl: FetchLike = async (url, init) => {
    > 84 |   const r = await fetch(url, {
         |             ^
      85 |     method: init.method as 'GET' | 'POST',
      86 |     headers: init.headers,
      87 |     body: init.body,

      at fetchImpl (tests/fixtures/oidc02-replica-harness.ts:84:13)
      at jsonFetch (src/modules/auth/oidc-client.ts:360:17)
      at discover (src/modules/auth/oidc-client.ts:368:18)
      at Object.authorizationUrl (src/modules/auth/oidc-client.ts:491:17)
      at Object.handleLogin (src/app/admin/oidc-flow.ts:129:17)
      at dispatchShellRequestAsync (src/app/admin/shell-router.ts:1033:49)
      at loginAt (tests/fixtures/oidc02-replica-harness.ts:152:15)
      at Object.<anonymous> (tests/oidc02-process-replicas-offline.test.ts:67:23)

    Cause:
    connect ETIMEDOUT 127.0.0.1:58024



  ?—? DU_LIVE_INFRA='1' ??? TWO REAL PROCESSES, real Redis ??? mint through A callback-onto-B; BOTH processes resolve the cookie (real Redis, real procs)

    expect(received).toBe(expected) // Object.is equality

    Expected: 302
    Received: 500

      266 |   async function mintLive(): Promise<{ sid: string }> {
      267 |     const login = await get(a, '/admin/login');
    > 268 |     expect(login.status).toBe(302);
          |                          ^
      269 |     const idpLeg = await fetch(login.headers.get('location') ?? '', { redirect: 'manual' });
      270 |     expect(idpLeg.status).toBe(302);
      271 |     const back = new URL(idpLeg.headers.get('location') ?? 'http://x/');

      at mintLive (tests/oidc02-process-replicas-offline.test.ts:268:26)
      at Object.<anonymous> (tests/oidc02-process-replicas-offline.test.ts:289:21)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 8 passed, 10 total
Snapshots:   0 total
Time:        15.184 s
Ran all test suites matching /tests\\oidc02-process-replicas-offline.test.ts/i.

```


## OIDC-02 process replicas live rerun after fetchWithRetry ??? 2026-09-25

- DB window CLAIM: 2026-09-25 14:51:51.188 +07:00
- DB window RELEASE: 2026-09-25 14:52:11.623 +07:00 (suite completed; released immediately)
- CWD: D:\Git\dugate\du-rework\services\orchestrator
- Build command: pnpm.cmd run build; ExitCode 0.
- Jest command: npx.cmd jest tests/oidc02-process-replicas-offline.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; REDIS_URL=redis://127.0.0.1:6380; PostgreSQL :5433 and Redis :6380 window claimed.
- Prerun infra: both containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; PostgreSQL ready.
- Result: Jest ExitCode 1; 1 suite failed; 1 failed, 9 passed, 10 total; no skipped tests reported.
- Offline block: 6/6 passed. Live two-process Redis block: 3/4 passed (logout, rotation, expiry); SHARE/login failed because expected HTTP 302 but received 500 at tests/oidc02-process-replicas-offline.test.ts:271. The prior offline/mock-IdP ETIMEDOUT did not recur.
- Teardown: post-run process query found no node processes matching oidc02-replica-probe.js or oidc02-process-replicas-offline.test.ts; no Jest open-handle warning appeared.
- Captured logs: %TEMP%\oidc02-process-replicas-build-rerun-20260925.log and %TEMP%\oidc02-process-replicas-live-rerun-20260925.log

### Raw build output
```text

> @du/orchestrator@0.1.0 build D:\Git\dugate\du-rework\services\orchestrator
> tsc -p tsconfig.json


```
### Raw Jest output

```text
FAIL tests/oidc02-process-replicas-offline.test.ts (14.47 s)
  cross-process callback + cookie
    ??? login STARTED on A COMPLETES on B; the cookie serves BOTH routers (same SEC-00 plane) (47 ms)
  cross-process cookie logout
    ??? logout AT B clears the cookie AND kills the session for A (27 ms)
  cross-process rotation (session-fixation defense)
    ??? rotate on B: OLD cookie dies everywhere, rotated cookie lives everywhere (23 ms)
  cross-process restart + revoke
    ??? a RESTARTED replica serves the pre-restart session; revoke before restart stays dead after (42 ms)
  cross-process expiry (real clock, short windows)
    ??? ABSOLUTE deadline evicts on every replica ??? activity cannot buy life (1784 ms)
    ??? SLIDING idle uses the SHARED lastSeenAt: a touch on B keeps A alive too (2833 ms)
  DU_LIVE_INFRA='1' ??? TWO REAL PROCESSES, real Redis
    ?— mint through A callback-onto-B; BOTH processes resolve the cookie (real Redis, real procs) (8 ms)
    ??? logout AT B kills the session for A (server-side, cross-process) (94 ms)
    ??? rotation through B: old cookie dead on BOTH processes, rotated live on BOTH (37 ms)
    ??? idle expiry on the REAL clock evicts on every process (idle 5s window) (5625 ms)

  ?—? DU_LIVE_INFRA='1' ??? TWO REAL PROCESSES, real Redis ??? mint through A callback-onto-B; BOTH processes resolve the cookie (real Redis, real procs)

    expect(received).toBe(expected) // Object.is equality

    Expected: 302
    Received: 500

      269 |   async function mintLive(): Promise<{ sid: string }> {
      270 |     const login = await get(a, '/admin/login');
    > 271 |     expect(login.status).toBe(302);
          |                          ^
      272 |     const idpLeg = await fetchWithRetry(login.headers.get('location') ?? '', { redirect: 'manual' });
      273 |     expect(idpLeg.status).toBe(302);
      274 |     const back = new URL(idpLeg.headers.get('location') ?? 'http://x/');

      at mintLive (tests/oidc02-process-replicas-offline.test.ts:271:26)
      at Object.<anonymous> (tests/oidc02-process-replicas-offline.test.ts:292:21)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 9 passed, 10 total
Snapshots:   0 total
Time:        14.798 s, estimated 15 s
Ran all test suites matching /tests\\oidc02-process-replicas-offline.test.ts/i.

```


## OIDC-02 process replicas final rerun after gateway.ready ??? 2026-09-25

- DB window CLAIM: 2026-09-25 15:00:51.876 +07:00
- DB window RELEASE: 2026-09-25 15:01:13.043 +07:00 (suite completed; released immediately)
- CWD: D:\Git\dugate\du-rework\services\orchestrator
- Build command: pnpm.cmd run build; ExitCode 0.
- Jest command: npx.cmd jest tests/oidc02-process-replicas-offline.test.ts --runInBand
- Environment: DU_LIVE_INFRA=1; REDIS_URL=redis://127.0.0.1:6380; PostgreSQL :5433 and Redis :6380 window claimed.
- Prerun infra: both containers Up (healthy); TCP 5433=True, TCP 6380=True; Redis PING=PONG; PostgreSQL ready. Confirmed the probe awaits gateway.ready().
- Result: Jest ExitCode 0; 1 suite passed; 10 passed, 10 total; 0 skipped.
- Coverage: all 6 offline cases and all 4 two-process live Redis cases (SHARE, logout, rotation, expiry) passed.
- Teardown: no Jest open-handle warning. Targeted query found no oidc02-replica-probe.js child processes. A separate orchestrator test:unit process using jest.unit.config.cjs was visible after release; its owner/environment/DB use are unverified.
- Captured logs: %TEMP%\oidc02-process-replicas-build-final-20260925.log and %TEMP%\oidc02-process-replicas-live-final-20260925.log

### Raw build output
```text

> @du/orchestrator@0.1.0 build D:\Git\dugate\du-rework\services\orchestrator
> tsc -p tsconfig.json


```
### Raw Jest output

```text
PASS tests/oidc02-process-replicas-offline.test.ts (15.668 s)
  cross-process callback + cookie
    ??? login STARTED on A COMPLETES on B; the cookie serves BOTH routers (same SEC-00 plane) (45 ms)
  cross-process cookie logout
    ??? logout AT B clears the cookie AND kills the session for A (35 ms)
  cross-process rotation (session-fixation defense)
    ??? rotate on B: OLD cookie dies everywhere, rotated cookie lives everywhere (16 ms)
  cross-process restart + revoke
    ??? a RESTARTED replica serves the pre-restart session; revoke before restart stays dead after (44 ms)
  cross-process expiry (real clock, short windows)
    ??? ABSOLUTE deadline evicts on every replica ??? activity cannot buy life (1778 ms)
    ??? SLIDING idle uses the SHARED lastSeenAt: a touch on B keeps A alive too (2849 ms)
  DU_LIVE_INFRA='1' ??? TWO REAL PROCESSES, real Redis
    ??? mint through A callback-onto-B; BOTH processes resolve the cookie (real Redis, real procs) (689 ms)
    ??? logout AT B kills the session for A (server-side, cross-process) (34 ms)
    ??? rotation through B: old cookie dead on BOTH processes, rotated live on BOTH (49 ms)
    ??? idle expiry on the REAL clock evicts on every process (idle 5s window) (5636 ms)

Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
Snapshots:   0 total
Time:        15.894 s
Ran all test suites matching /tests\\oidc02-process-replicas-offline.test.ts/i.

```


## Controlled DB window: apply migration 0015 and verify ??? 2026-09-25

- CLAIM_DB_WINDOW: 2026-09-25 16:57:19.361 +07:00
- RELEASE_DB_WINDOW: 2026-09-25 16:59:12.048 +07:00 (migration test command completed; CLI/test pools closed; no open-handle warning)
- Database target: PostgreSQL 127.0.0.1:5433/du_orchestrator_test. DATABASE_URL was unset, so the standard migration-test target was set explicitly. Redis 127.0.0.1:6380 was included in the claimed window and health-checked.
- Prerun: Docker PostgreSQL and Redis Up (healthy); TCP 5433/6380 connected; Redis PING=PONG; PostgreSQL ready.
- Step 3 status: ExitCode 0; 14/15 applied; 0015_artifact_multipart.sql pending.
- Step 4 migrate: ExitCode 0; applied exactly 0015_artifact_multipart.sql; CLI verification passed.
- Step 5 migrate:verify: ExitCode 0; all migrations verified.
- Step 6 test: DU_LIVE_INFRA=1; `pnpm.cmd --filter @du/orchestrator test -- tests/migrations.test.ts`; ExitCode 0; 1 suite passed, 9 passed, 9 total, 0 failed, 0 skipped.
- Scratch DB safety: read-only query before tests returned no existing du_orchestrator_migrate_scratch database; migrations.test.ts then created and cleaned its disposable scratch DB.
- Raw logs: %TEMP%\migration-0015-status-20260925.log; %TEMP%\migration-0015-apply-20260925.log; %TEMP%\migration-0015-verify-20260925.log; %TEMP%\migration-tests-0015-20260925.log

### Raw status output
```text

> @du/orchestrator@0.1.0 migrate:status D:\Git\dugate\du-rework\services\orchestrator
> npm run build && node dist/migrate-cli.js status


> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

Migrations: 14/15 applied
Pending:
  ?—? 0015_artifact_multipart.sql

```
### Raw migrate output

```text

> @du/orchestrator@0.1.0 migrate D:\Git\dugate\du-rework\services\orchestrator
> npm run build && node dist/migrate-cli.js migrate


> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

Applied 1 migration(s):
  ??? 0015_artifact_multipart.sql
Verification passed.

```
### Raw verify output

```text

> @du/orchestrator@0.1.0 migrate:verify D:\Git\dugate\du-rework\services\orchestrator
> npm run build && node dist/migrate-cli.js verify


> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

Schema verification passed. All migrations applied.

```
### Raw migrations test output

```text

> @du/orchestrator@0.1.0 test D:\Git\dugate\du-rework\services\orchestrator
> jest --runInBand "--" "tests/migrations.test.ts"

PASS tests/migrations.test.ts
  WINDOW-GATED live suite (DU_LIVE_INFRA=1)
    migration tracking (R08-06 / P2-01)
      ??? migrate() is idempotent ??? second call applies nothing (34 ms)
      ??? verifyMigrations() passes after migrate() (12 ms)
      ??? migrationStatus() reports consistent counts (6 ms)
      ??? schema_migrations table exists and is queryable (2 ms)
      ??? core tables exist after migration (5 ms)
      ??? concurrent migrate() calls do not double-insert (idempotent under contention) (21 ms)
    migration boot boundary on empty scratch DB
      ??? verifyMigrations fails on empty DB (no hidden write) (28 ms)
      ??? migrate() on empty DB creates all tables, then verifyMigrations passes (323 ms)
      ??? repeated migrate() is idempotent on scratch DB (18 ms)

Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
Snapshots:   0 total
Time:        2.77 s, estimated 15 s
Ran all test suites matching /tests\\migrations.test.ts/i.

```


## Packet T-DBW-P803-1 ??? P8-03 provider convergence DB window ??? 2026-09-25

- CLAIM_DB_WINDOW: 2026-09-25 19:44:51.065 +07:00
- RELEASE_DB_WINDOW: 2026-09-25 19:44:54.017 +07:00 (suite completed; window released immediately)
- CWD: D:\Git\dugate\du-rework\businesses\document-core
- Command: npx.cmd jest tests/p8-03-provider-convergence.test.ts --runInBand
- Database: PostgreSQL 127.0.0.1:5433/du_orchestrator_test (DATABASE_URL set explicitly).
- Prerun: PostgreSQL and Redis containers Up (healthy); PostgreSQL :5433 connected and ready.
- Result: ExitCode 0; 1 suite passed; 7 passed, 7 total, 0 failed, 0 skipped.
- Source boundary: no source files changed.
- Raw log path: %TEMP%\p8-03-provider-convergence-dbwindow-20260925.log

### Raw Jest output
```text
PASS tests/p8-03-provider-convergence.test.ts
  P8-03: Document-Core Provider & Usage Convergence (CON-01..05, USE-01/02)
    CON-01 & CON-05: Adapter Facade & INVOCATION_UNKNOWN Fault Handling
      ??? extract/invoice invokes connector reasoning slot and produces structured output (4 ms)
      ??? INVOCATION_UNKNOWN from connector fails task non-retryable and halts execution (1 ms)
      ??? transport disconnect throws ConnectorTransportError with INVOCATION_UNKNOWN and halts
    CON-02 & USE-02: Checkpoint Deduplication & Zero Double-Billing
      ??? step checkpoint replay restores cached output with 0 connector calls and 0 duplicate usage (1 ms)
    CON-03: Quota Exhaustion Backpressure
      ??? 429 QUOTA_EXHAUSTED from connector throws retryable error with backpressure delay
    USE-01: Structured Usage Accounting & Schema Compliance
      ??? usage metadata from provider execution conforms to UsageEventSchema (1 ms)
      ??? live usage_events projection query aggregates provider tokens and costs matching UsageSchema (51 ms)

Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
Snapshots:   0 total
Time:        1.738 s
Ran all test suites matching /tests\\p8-03-provider-convergence.test.ts/i.

```

## T-DATA-LIVE-1 ??? NO-S3-ENVIRONMENTS

- Survey timestamp: 2026-09-25 20:06:26 +07:00 (Asia/Bangkok).
- Decision: STOP before step 2.3. No real or mock S3-compatible endpoint is running/configured in the surveyed local environment, so the live multipart suite was not created or run.
- Docker evidence (docker ps): no MinIO, LocalStack, or other S3-compatible service in the running container list. The existing du-rework-postgres and du-rework-redis containers are healthy, but are not S3 services.
- Docker evidence (docker ps -a): the only S3-compatible candidate found was minio/minio:latest, container minio, status Exited (255) 7 months ago (published ports 9001 and 9003).
- Environment scan: 0 env files discovered under the requested du-rework scan; searched ARTIFACT_STORAGE_BACKEND, DU_S3*, and AWS_*. Matching variable names found: NONE in env files and NONE in process environments. Secret values were not collected or printed.
- Endpoint/process probes: S3 candidate ports 9000, 9001, 9003, 4566, 5000, 8333, and 7480 were closed; no S3 server process was found.
- Fixture review: services/orchestrator/tests/fixtures/multipart-offline-harness.ts is an in-memory fake (zero DB/Redis/network); it points to offline-only S3 command wiring coverage. No live S3 gate/endpoint is provided by this fixture.
- DB Window: NOT CLAIMED; no live test or database operation was performed. No source files were changed.
- Survey evidence/raw output: %TEMP%\T-DATA-LIVE-1-s3-environment-20260925.txt.

## T-DATA-LIVE-2 - BLOCKED (schema gate)

- Pilot timestamp: 2026-09-25 21:39:19 +07:00. docker start minio ExitCode 0. Existing command: server /data --console-address :9001. Container API port 9000 is published to host :9003; console is :9001. Data bind: /data/compose/16/minio_data -> /data. Root credential variable names present in container config: MINIO_ROOT_USER, MINIO_ROOT_PASSWORD; values intentionally omitted. No fallback container was started.
- S3 readiness: http://127.0.0.1:9003/minio/health/ready returned 200. Bucket du-artifacts-live2 created; anonymous policy verified private; versioning verified enabled. Bucket setup corrected-run ExitCode 0 (initial wrapper syntax attempt ExitCode 2; no bucket-side failure).
- Prerun: du-rework-postgres and du-rework-redis Up (healthy); TCP :5433/:6380 connected. PostgreSQL target 127.0.0.1:5433/du_orchestrator_test; Redis 127.0.0.1:6380.
- CLAIM_DB_WINDOW: 2026-09-25 21:58:52 +07:00 (PostgreSQL :5433 + Redis :6380).
- Suite CWD: D:/Git/dugate/du-rework/services/orchestrator.
- Command: npx.cmd jest tests/data-02-04-live-s3.test.ts --runInBand with DU_LIVE_INFRA=1, S3 endpoint/bucket and AWS credential variable names loaded only into this process. Credential values are not in this receipt or raw log.
- Attempt 1: 2026-09-25 21:59:17 +07:00; ExitCode 1; TypeScript error was in the new test (app.multipart is not public). Fixed within the test file only; no source file edited. Jest assertions run: 0.
- Attempt 2: 2026-09-25 22:00:22 +07:00; ExitCode 1. createApp(autoMigrate=false) failed its read-only migration verification: missing migrations [0016_public_upload_token_index.sql]. Jest reports 1 suite failed and 5/5 tests failed at the shared beforeAll; no test body/assertion executed.
- RELEASE_DB_WINDOW: 2026-09-25 22:01:46 +07:00. Failed startup closed its PostgreSQL pool; Redis was not opened by createApp before migration verification. No migration was applied, and no DB rows or S3 multipart parts/objects were written.
- Outcome: DATA-02/DATA-04 live PG+S3 flow is BLOCKED, not VERIFIED. The blocker is pending migration 0016_public_upload_token_index.sql; this packet did not apply it. Signed values were wired into the test configuration (8 GiB maximum, 64 MiB part cap, 1 MiB JSON ingress, 24 h session TTL), but acceptance assertions did not run.
- Source boundary: only the permitted new file services/orchestrator/tests/data-02-04-live-s3.test.ts was added; no src file was changed and no commit/push was made. The MinIO pilot remains running and the bucket remains private.
- Raw output for both attempts and window timestamps: %TEMP%/T-DATA-LIVE-2-multipart-live-20260925.log.
## T-WINDOW-4 ??? T-DATA-LIVE-3 ??? BLOCKED at migration status

- CLAIM_DB_WINDOW: 2026-09-25 22:36:57.876 +07:00 (PostgreSQL :5433 + Redis :6380).
- RELEASE_DB_WINDOW: 2026-09-25 22:37:40.638 +07:00. Released immediately after the failed status command; no Jest suite was active.
- Preflight: `docker ps` showed `du-rework-postgres` and `du-rework-redis` Up (healthy); TCP probes to :5433 and :6380 returned True. MinIO was Up with host :9003 mapped to container :9000. This turn did not re-probe the MinIO HTTP health endpoint; prior T-DATA-LIVE-2 receipt had recorded HTTP 200.
- CWD: `D:\Git\dugate\du-rework`.
- Command: `pnpm --filter @du/orchestrator run migrate:status`.
- Observed output: package script started `npm run build && node dist/migrate-cli.js status`; `tsc -p tsconfig.json` emitted no error. CLI then failed with literal `DATABASE_URL is required` (`NativeCommandError`). The PowerShell wrapper terminated before it persisted the child process ExitCode; **ExitCode: not captured**.
- Result: no DB migration status was read; 0016 pending state was not confirmed; no migration was applied; `migrate:verify` and `tests/data-02-04-live-s3.test.ts` were not run. No DATA test count exists. No DB connection was opened by the CLI after its missing-DATABASE_URL validation.
- Required stop rule followed. OIDC02 was not run because Phase A stopped before migration status; no OIDC window was claimed and no test count/ExitCode exists. No source or test files were modified; no commit made.
- Raw logs: `%TEMP%\T-DATA-LIVE-3-20260925.log` and `%TEMP%\T-WINDOW-4-T-DATA-LIVE-3-20260925.log` (timestamp/raw command output); blocked OIDC receipt `%TEMP%\T-OIDC02-LIVE-1-20260925.log`.

### Literal output ??? migrate:status

```text
> @du/orchestrator@0.1.0 migrate:status D:\Git\dugate\du-rework\services\orchestrator
> npm run build && node dist/migrate-cli.js status

> @du/orchestrator@0.1.0 build
> tsc -p tsconfig.json

node.exe : DATABASE_URL is required
At C:\nvm4w\nodejs\pnpm.ps1:16 char:5
+     & "$basedir/node$exe"  "$basedir/node_modules/corepack/dist/pnpm. ...
+     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (DATABASE_URL is required:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```

## T-WINDOW-4 ??? T-OIDC02-LIVE-1 ??? NOT RUN

- Status: NOT RUN; the packet's stop-on-failure rule was triggered in DATA Phase A at `migrate:status` before OIDC02.
- Exact W49-Q3-25 handoff reviewed: `pnpm run build`, `DU_LIVE_INFRA=1`, `REDIS_URL=redis://127.0.0.1:6380`, and `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts`. The real-Redis block including KILL+RESPAWN process B was not executed.
- DB window: not separately claimed for OIDC; the common window was released at 2026-09-25 22:37:40.638 +07:00.
- CWD planned by handoff: `D:\Git\dugate\du-rework\services\orchestrator`. Command ExitCode/test counts: none; command not run.
- Raw status log: `%TEMP%\T-OIDC02-LIVE-1-20260925.log`.

## T-WINDOW-5 ??? CLAIM

- CLAIM_DB_WINDOW: 2026-09-25 22:45:33.970 +07:00, PostgreSQL :5433 + Redis :6380. Window claimed before DB access.
- CWD: D:\Git\dugate\du-rework.
- Raw log: %TEMP%\T-WINDOW-5-20260925.log.
- Status: CLOSED; detailed results are in the receipts below.

## T-WINDOW-5 / T-OIDC02-LIVE-1R ??? CLAIM

- CLAIM_DB_WINDOW: 2026-09-25 22:51:01.986 +07:00, PostgreSQL :5433 + Redis :6380. Fresh claim after DATA suite window was released.
- CWD: D:\Git\dugate\du-rework\services\orchestrator.
- Planned command: pnpm run build, then pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts with DU_LIVE_INFRA=1, REDIS_URL=redis://127.0.0.1:6380.
- Raw log: %TEMP%\T-OIDC02-LIVE-1R-20260925.txt.
- Status: CLOSED; detailed results are in the receipts below.

## T-DATA-LIVE-3R - DATA-02/DATA-04 live PG + private S3

- CLAIM_DB_WINDOW: 2026-09-25 22:45:33.970 +07:00 (PostgreSQL :5433 + Redis :6380).
- RELEASE_DB_WINDOW: 2026-09-25 22:49:38.285 +07:00. The window was released after the failed live suite; no command remained active.
- Migration status CWD: `D:\Git\dugate\du-rework`; command: `pnpm --filter @du/orchestrator run migrate:status`; environment variable name: `DATABASE_URL` (value omitted); literal ExitCode 0. Output: 15/16 applied; only `0016_public_upload_token_index.sql` pending.
- Migration apply CWD: `D:\Git\dugate\du-rework`; command: `pnpm --filter @du/orchestrator run migrate`; environment variable name: `DATABASE_URL` (value omitted); literal ExitCode 0. Applied exactly one migration: `0016_public_upload_token_index.sql`; output also reported `Verification passed.`
- Migration verify CWD: `D:\Git\dugate\du-rework`; command: `pnpm --filter @du/orchestrator run migrate:verify`; environment variable name: `DATABASE_URL` (value omitted); literal ExitCode 0. Output: `Schema verification passed. All migrations applied.`
- Live test CWD: `D:\Git\dugate\du-rework\services\orchestrator`.
- Live test command: `npx jest tests/data-02-04-live-s3.test.ts --runInBand`.
- Environment variable names set: `DATABASE_URL`, `REDIS_URL`, `DU_LIVE_INFRA`, `ARTIFACT_S3_ENDPOINT`, `ARTIFACT_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Secret values omitted. Endpoint was MinIO host :9003; bucket `du-artifacts-live2`; readiness probe HTTP 200.
- Literal Jest ExitCode: 1. Result: 1 suite failed; 2 passed, 3 failed, 0 skipped, 5 total.
- Failure evidence: three multipart-init calls returned HTTP 503, surfaced as `AmbiguousReportError` for `POST /tasks/.../artifacts/multipart`. The afterAll cleanup then reported `InvalidAccessKeyId` from `ListObjectVersions`. The test output logged policy values and `expiredSubmit=404 code=NOT_FOUND`; this run did not report a ??1-??3 assertion failure. Result is RED / not verified; evidence points to S3 authentication configuration. No retry was run.
- Raw logs: `%TEMP%\T-WINDOW-5-migrate-status-20260925.txt`, `%TEMP%\T-WINDOW-5-migrate-apply-20260925.txt`, `%TEMP%\T-WINDOW-5-migrate-verify-20260925.txt`, `%TEMP%\T-DATA-LIVE-3R-jest-20260925.txt`, `%TEMP%\T-WINDOW-5-20260925.log`.
- No source or test file changed. No commit/push.

## T-OIDC02-LIVE-1R - real Redis multi-process verification

- CLAIM_DB_WINDOW: 2026-09-25 22:51:01.986 +07:00 (PostgreSQL :5433 + Redis :6380; fresh claim after DATA window release).
- Build command: `pnpm run build`; CWD `D:\Git\dugate\du-rework\services\orchestrator`; literal ExitCode 0.
- Test command: `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts`; CWD `D:\Git\dugate\du-rework\services\orchestrator`.
- Environment variable names set: `DU_LIVE_INFRA`, `REDIS_URL` (live Redis `redis://127.0.0.1:6380`).
- Literal Jest ExitCode: 0. Result: 1 suite passed; 13 passed, 0 failed, 0 skipped, 13 total. The actual output shows all 7 real-Redis tests passed, including `KILL + RESPAWN process B: in-date session still valid; expired one dies everywhere`; the other 6 offline tests also passed.
- RELEASE_DB_WINDOW: 2026-09-25 22:52:11.299 +07:00. No DB window remains claimed.
- Raw logs: `%TEMP%\T-OIDC02-LIVE-1R-build-20260925.txt`, `%TEMP%\T-OIDC02-LIVE-1R-jest-20260925.txt`, `%TEMP%\T-OIDC02-LIVE-1R-20260925.txt`, `%TEMP%\T-WINDOW-5-20260925.log`.
- No source or test file changed. No commit/push.

## T-CODEX-TEST-1 ??? Offline Connector & Contracts

- Receipt time: 2026-09-26 00:21 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local build/typecheck/Jest run; no DB, Redis, or S3 service started. No product source files were edited for this task.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; test counts: N/A (build command). Raw output: `coordination/reports/T-CODEX-TEST-1-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; test counts: N/A (typecheck command). Raw output: `coordination/reports/T-CODEX-TEST-1-connector-typecheck.log`.
- Command: `pnpm --filter @du/connector test -- tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts` ??? literal ExitCode: `0`; suites: 2 passed, 0 failed; tests: 28 passed, 0 failed, 0 skipped (28 total). Raw output: `coordination/reports/T-CODEX-TEST-1-connector-tests.log`.
- The PowerShell `pnpm.ps1` wrapper emitted a `NativeCommandError` record while displaying Jest's `PASS` line; Jest's final summary reports both suites and all 28 tests passed, and the captured process ExitCode is `0`.

## T-CODEX-TEST-2 ??? Offline Orchestrator aggregate and Vault reference contracts

- Receipt time: 2026-09-26 01:11:16 +07:00. CWDs: `D:\Git\dugate\du-rework\services\orchestrator` and `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest runs only; no PostgreSQL `:5433`, Redis `:6380`, or S3 service was connected and no DB window was claimed. No product source files were edited. No commit/push.
- Command: `npx jest --runInBand --config jest.unit.config.cjs` (CWD `D:\Git\dugate\du-rework\services\orchestrator`) ??? literal ExitCode: `0`; suites: 57 passed, 0 failed, 1 skipped (58 total); tests: 1342 passed, 0 failed, 15 skipped (1357 total). Raw output: `coordination/reports/T-CODEX-TEST-2-orchestrator.log`.
- Command: `pnpm --filter @du/contracts test -- --runTestsByPath tests/vault-ref.test.ts` (CWD `D:\Git\dugate\du-rework`) ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 59 passed, 0 failed, 0 skipped (59 total). Raw output: `coordination/reports/T-CODEX-TEST-2-contracts.log`.
- Jest output included PowerShell `NativeCommandError` records while forwarding PASS lines through `npx.ps1`/`pnpm.ps1`; final Jest summaries were green. The aggregate run was observed to complete with `Ran all test suites.`

## T-CODEX-TEST-3 ??? Offline SEC-00 role-action-tenant and Worker-SDK acquisition

- Receipt time: 2026-09-26 01:17:13 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest runs only; no PostgreSQL, Redis, or S3 connection and no DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/orchestrator test -- tests/oidc03-role-action-tenant-offline.test.ts tests/admin-action-dispatcher.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/admin-audit-scope.test.ts` ??? literal ExitCode: `0`; suites: 4 passed, 0 failed, 0 skipped; tests: 109 passed, 0 failed, 0 skipped (109 total). Raw output: `coordination/reports/T-CODEX-TEST-3-orchestrator.log`.
- Command: `pnpm --filter @du/worker-sdk test -- tests/source-acquisition.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 40 passed, 0 failed, 0 skipped (40 total). Raw output: `coordination/reports/T-CODEX-TEST-3-worker-sdk.log`.
- The pnpm wrapper emitted `NativeCommandError` records while forwarding Jest PASS lines; final Jest summaries were green.

## T-CODEX-TEST-10 ??? Offline aggregate Contracts verification

- Receipt time: 2026-09-26 02:11:37 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no live DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/contracts test` ??? literal ExitCode: `0`; suites: 10 passed, 0 failed, 0 skipped; tests: 192 passed, 0 failed, 0 skipped (192 total). Raw output: `coordination/reports/T-CODEX-TEST-10-contracts.log`.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-10-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-10-connector-typecheck.log`.
- The pnpm wrapper emitted a `NativeCommandError` record while forwarding a Jest PASS line; the final aggregate Jest summary was green.

## T-CODEX-TEST-11 ??? Offline root unit sentinel, BR05, and UC07 suites

- Receipt time: 2026-09-26 02:48:24 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest run using `tests/unit/jest.config.cjs`; no PostgreSQL, Redis, or S3 connection and no DB window claimed. No source files were edited. No commit/push.
- Command: `pnpm -C services/orchestrator exec jest -c ../../tests/unit/jest.config.cjs tests/unit/sentinel-sink-matrix.test.ts tests/unit/br05-artifact-ttl-quota.functional.test.ts tests/unit/uc07-version-drain.functional.test.ts` ??? literal ExitCode: `0`; suites: 3 passed, 0 failed, 0 skipped; tests: 23 passed, 0 failed, 0 skipped (23 total). Raw output: `coordination/reports/T-CODEX-TEST-11-root-unit.log`.
- The pnpm wrapper emitted a `NativeCommandError` record while forwarding a Jest PASS line; final Jest summary was green.

## T-CODEX-TEST-12 ??? Offline Worker-SDK DATA-03 URL acquisition

- Receipt time: 2026-09-26 02:50:51 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest run only; injected fetchers and loopback test listener, no external DB/Redis/S3 connection and no DB window claimed. No source files were edited. No commit/push.
- Command: `pnpm --filter @du/worker-sdk test -- tests/source-acquisition.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 40 passed, 0 failed, 0 skipped (40 total). Raw output: `coordination/reports/T-CODEX-TEST-12-source-acquisition.log`.
- The pnpm wrapper emitted a `NativeCommandError` record while forwarding the Jest PASS line; final Jest summary was green.

## T-CODEX-TEST-17 ??? W-DOC-ISOLATE-1 Document-Core offline aggregate

- Receipt time: 2026-09-26 04:56:22 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline aggregate Jest run with the package's `__offline_default_excludes_integration__` path ignore, followed by integration test discovery only. No PostgreSQL, Redis, or S3 connection and no DB window claimed. No source files were edited. No commit/push.
- Command: `pnpm --filter @du/document-core test` ??? literal ExitCode: `0`; suites: 42 passed, 0 failed, 0 skipped (42 total); tests: 506 passed, 0 failed, 0 skipped (506 total). Raw output: `coordination/reports/T-CODEX-TEST-17-document-core-offline-green.log`.
- Command: `pnpm --filter @du/document-core run test:integration --listTests` ??? literal ExitCode: `0`; discovery returned `tests/multi-container-e2e.integration.test.ts` (no test execution). Raw output: `coordination/reports/T-CODEX-TEST-17-document-core-offline-green.log`.
- The pnpm wrapper emitted `NativeCommandError` records while forwarding Jest PASS lines; final offline aggregate summary was green.

## T-CODEX-TEST-15 ??? Offline DATA-04 direct band and parser budget suites

- Receipt time: 2026-09-26 03:11:37 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest runs only; Worker-SDK used fake/loopback test seams and Document-Core used local disk fixtures. No PostgreSQL, Redis, or S3 connection and no DB window claimed. No source files were edited. No commit/push.
- Command: `pnpm --filter @du/worker-sdk test -- tests/artifact-direct-band.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 12 passed, 0 failed, 0 skipped (12 total).
- Command: `pnpm --filter @du/document-core test -- tests/parser-budget-band.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 8 passed, 0 failed, 0 skipped (8 total).
- Combined raw output: `coordination/reports/T-CODEX-TEST-15-direct-band.log`.

## T-CODEX-TEST-16 ??? Offline LOG-01 login redaction suite

- Receipt time: 2026-09-26 03:27:05 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest and TypeScript lint only; package description confirms no DB. No PostgreSQL, Redis, or S3 connection and no DB window claimed. No source files were edited. No commit/push.
- Command: `pnpm --filter @du/login-tests test` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 27 passed, 0 failed, 0 skipped (27 total).
- Command: `pnpm --filter @du/login-tests run lint` ??? literal ExitCode: `0`; TypeScript no-emit lint completed successfully (test counts: N/A).
- Combined raw output: `coordination/reports/T-CODEX-TEST-16-login-redaction.log`.

## T-CODEX-TEST-13 ??? Offline Document-Core aggregate verification

- Receipt time: 2026-09-26 03:01:29 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: invoked as an offline validation run with no DB window claimed and no source edits/commit/push. The package aggregate includes `tests/multi-container-e2e.integration.test.ts`, which is a live cross-service suite and was not isolated by the package's default `test` script.
- Command: `pnpm --filter @du/document-core test` ??? literal ExitCode: `1`; suites: 42 passed, 1 failed, 0 skipped (43 total); tests: 507 passed, 12 failed, 0 skipped (519 total). Raw output: `coordination/reports/T-CODEX-TEST-13-document-core-aggregate.log`.
- Failure evidence: `tests/multi-container-e2e.integration.test.ts` failed 12 assertions/timeouts, including expected operation state `SUCCEEDED` but received `ACCEPTED`, missing invocation/ledger evidence, and child-worker/pinning barrier timeouts. The other 42 suites passed.

## T-CODEX-TEST-14 ??? Offline DATA-03 URL ingestion server slice

- Receipt time: 2026-09-26 03:06:00 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest run only; no database calls were made by the suite, no PostgreSQL/Redis/S3 connection and no DB window claimed. No source files were edited. No commit/push.
- Command: `pnpm --filter @du/orchestrator test -- tests/url-ingestion-offline.functional.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 3 passed, 0 failed, 0 skipped (3 total). Raw output: `coordination/reports/T-CODEX-TEST-14-url-ingestion.log`.
- The pnpm wrapper emitted a `NativeCommandError` record while forwarding the Jest PASS line; final Jest summary was green.

## T-CODEX-TEST-4 ??? Offline Document-Core streaming acquisition and package builds

- Receipt time: 2026-09-26 01:22:05 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local test/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/document-core test -- tests/parser-budgets.test.ts tests/read-stream-acquisition.test.ts` ??? literal ExitCode: `0`; suites: 2 passed, 0 failed, 0 skipped; tests: 56 passed, 0 failed, 0 skipped (56 total). Raw output: `coordination/reports/T-CODEX-TEST-4-document-core.log`.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-4-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-4-connector-typecheck.log`.
- The pnpm wrapper emitted `NativeCommandError` records while forwarding Jest PASS lines; final Jest summary was green.

## T-CODEX-TEST-5 ??? Offline Document-Core actions and SDK consumer suites

- Receipt time: 2026-09-26 01:25:32 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no live DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/document-core test -- tests/ingest.test.ts tests/extract.test.ts tests/analyze.test.ts tests/transform.test.ts tests/generate.test.ts tests/compare.test.ts tests/six-action-fail-closed-matrix.functional.test.ts tests/sdk-consumer.test.ts` ??? literal ExitCode: `0`; suites: 8 passed, 0 failed, 0 skipped; tests: 105 passed, 0 failed, 0 skipped (105 total). Raw output: `coordination/reports/T-CODEX-TEST-5-document-core.log`.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-5-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-5-connector-typecheck.log`.
- The pnpm wrapper emitted a `NativeCommandError` record while forwarding a Jest PASS line; the final Jest summary was green.

## T-CODEX-TEST-23 ??? Admin keyset query-plan multi-tenant live verification

- Receipt time: 2026-09-26T09:01:26.7288061+07:00. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- `CLAIM_DB_WINDOW`: `2026-09-26T09:01:21.6776460+07:00`, PostgreSQL `localhost:5433/du_orchestrator_test`, Redis `localhost:6380`. `RELEASE_DB_WINDOW`: `2026-09-26T09:01:26.7288061+07:00`, immediately after suite completion.
- Environment: `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@localhost:5433/du_orchestrator_test`, `REDIS_URL=redis://localhost:6380`. No source edits, commit, or push.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 6 passed, 0 failed, 0 skipped.
- Query-plan evidence: cross-tenant and tenant-scoped page queries used `Index Scan using operations_created_id_idx`; neither contained `Seq Scan` or `Sort`. The backward page used the same keyset index via `Bitmap Index Scan`/`Bitmap Heap Scan`, with a PostgreSQL `Sort` node on `(created_at, id)`; the suite's backward keyset assertion passed. The seeded keyset walk covered all 1,240 rows without skips/repeats, and insert-between-pages passed.
- Raw output: `coordination/reports/T-CODEX-TEST-23-keyset-explain-live.log`.

## T-CODEX-TEST-24 ??? Admin audit/API-keys/business list contract verification

- Receipt time: `2026-09-26T09:36:00.8078825+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline only; `DU_LIVE_INFRA`, `DATABASE_URL`, and `REDIS_URL` unset. No PostgreSQL/Redis window opened or claimed. No source or test files modified; no commit/push.
- Existing coverage found: `services/orchestrator/tests/admin-audit.test.ts`, `admin-audit-scope.test.ts`, `admin-api-key-view-model.test.ts`, and `admin-business-view-model.test.ts`. No separate offline HTTP integration suites for API-key or business GET list endpoints were found.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts tests/admin-audit-scope.test.ts tests/admin-api-key-view-model.test.ts tests/admin-business-view-model.test.ts` ??? literal ExitCode: `0`; suites: 3 passed, 1 skipped, 0 failed (4 total); tests: 100 passed, 11 skipped, 0 failed (111 total).
- Offline limitation: `admin-audit.test.ts` is explicitly live-only and its full suite was skipped without `DU_LIVE_INFRA=1`; therefore this run does not verify live audit response envelope/limit behavior. `admin-audit-scope.test.ts` verifies tenant authorization helper behavior, while API-key and business files verify view-model projections rather than HTTP list pagination/cursor contracts. Coordinator should assign implementation/tests if endpoint-level offline coverage is required.
- Raw output: `coordination/reports/T-CODEX-TEST-24-admin-lists.log`.

## T-CODEX-TEST-25 ??? Live admin audit and keyset regression

- CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No source/test edits, commit, or push.
- Initial live claim: `2026-09-26T09:39:15.1684653+07:00`; initial release: `2026-09-26T09:39:21.8813626+07:00`.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts`; initial literal ExitCode: `1`; suites `0 passed, 1 failed, 0 skipped`; tests `0 passed, 0 failed, 0 skipped`. Jest could not compile `src/server.ts:2620` because `hasPageAbove` is undefined. A second exact invocation was run after a fresh claim to rule out wrapper argument handling.
- Retry live claim: `2026-09-26T09:39:58` (timestamp emitted by the retry process); retry release: `2026-09-26T09:41:10.2025043+07:00`.
- Retry command: same exact command with `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@localhost:5433/du_orchestrator_test`, `REDIS_URL=redis://localhost:6380`; literal ExitCode: `1`; suites `0 passed, 1 failed, 0 skipped`; tests `5 passed, 6 failed, 0 skipped` (11 total). The live harness reached the endpoint, but six audit assertions failed, including the unknown-bearer 401 contract, while five passed. This is a RED result; no acceptance claim.
- Keyset regression was not run because the requested audit suite failed and the live window was released immediately after the retry.
- Raw output: `coordination/reports/T-CODEX-TEST-25-live-audit.log`.

## T-CODEX-TEST-26 ??? Vault offline test inventory and policy execution

- Receipt time: `2026-09-26T09:50:09.5557419+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline only; `DU_LIVE_INFRA`, `DATABASE_URL`, and `REDIS_URL` unset. No DB/Redis window claimed or opened. No source/test edits, commit, or push.
- Inventory (package ownership): Contracts ??? `packages/contracts/tests/vault-ref.test.ts`, `vault-policies.test.ts`; Connector ??? `services/connector/tests/vault-account-isolation.test.ts`, `secret-resolver.test.ts`, `vault-machine-policies-offline.test.ts`; Orchestrator ??? `services/orchestrator/tests/admin-actions-vault04-offline.functional.test.ts`, `connector-credentials-offline.functional.test.ts`, `mock-vault-harness-offline.functional.test.ts`.
- Contracts command: `pnpm --filter @du/contracts test -- tests/vault-ref.test.ts tests/vault-policies.test.ts` ??? ExitCode `0`; suites 2 passed/0 failed/0 skipped; tests 81 passed/0 failed/0 skipped.
- Connector command: `pnpm --filter @du/connector test -- tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts tests/vault-machine-policies-offline.test.ts` ??? ExitCode `0`; suites 3 passed/0 failed/0 skipped; tests 38 passed/0 failed/0 skipped.
- Orchestrator command: `pnpm --filter @du/orchestrator test -- tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts tests/mock-vault-harness-offline.functional.test.ts` ??? ExitCode `1`; suites 2 passed/1 failed/0 skipped; tests 44 passed/7 failed/0 skipped. All seven failures are in `mock-vault-harness-offline.functional.test.ts`, returning `BINDING_DENIED` because connector ownership binding is unavailable; the two other suites passed.
- Raw output: `coordination/reports/T-CODEX-TEST-26-vault-offline.log`.

## T-CODEX-TEST-27 ??? Post-splice Orchestrator typecheck and admin list contract offline verification

- Receipt time: `2026-09-26T10:56:11.1993638+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline only; `DU_LIVE_INFRA`, `DATABASE_URL`, and `REDIS_URL` unset. No DB/Redis window claimed. No source/test edits, commit, or push.
- `pnpm --filter @du/contracts build` ??? literal ExitCode `0`; build passed (test counts N/A).
- `pnpm --filter @du/orchestrator exec tsc --noEmit` ??? literal ExitCode `0`; clean typecheck, including the prior `hasPageAbove` compile error being resolved.
- `pnpm --filter @du/orchestrator test -- tests/admin-list-contract-conformance.test.ts tests/admin-operations-list-pagination.test.ts tests/admin-actions-dispatch-offline.test.ts` ??? literal ExitCode `0`; Jest discovered 2 suites (the requested `admin-actions-dispatch-offline.test.ts` file is absent and was ignored), 2 passed/0 failed/0 skipped; 94 passed/0 failed/0 skipped tests.
- Raw output: `coordination/reports/T-CODEX-TEST-27-admin-conformance.log`.

## T-CODEX-TEST-28 ??? Vault mock-harness and MM-05 queue integrity offline verification

- Receipt time: `2026-09-26T11:46:30.8101605+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline only; `DU_LIVE_INFRA`, `DATABASE_URL`, and `REDIS_URL` unset. No DB/Redis window claimed. No source/test edits, commit, or push.
- `pnpm --filter @du/contracts build` ??? literal ExitCode `0`; build passed.
- Vault suites: `pnpm --filter @du/orchestrator test -- tests/mock-vault-harness-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts` ??? literal ExitCode `0`; 3 suites passed, 0 failed/skipped; 52 tests passed, 0 failed/skipped. No `BINDING_DENIED` failures.
- MM-05 suites: `pnpm --filter @du/orchestrator test -- tests/mm05-queue-integrity-sweep.test.ts tests/mm05-queue-integrity-offline.functional.test.ts` ??? literal ExitCode `0`; 2 suites passed, 0 failed/skipped; 15 tests passed, 0 failed/skipped.
- Raw output: `coordination/reports/T-CODEX-TEST-28-vault-mm05-verify.log`.

## T-CODEX-TEST-29 ??? Live T130-A1 / Delta 12 admin re-validation

- Receipt time: `2026-09-26T13:23:20.2932970+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No source edits, commit, or push.
- `CLAIM_DB_WINDOW`: `2026-09-26T13:21:20.1853041+07:00`, PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`. `RELEASE_DB_WINDOW`: `2026-09-26T13:23:20.2932970+07:00` immediately after the final suite.
- Preflight `pnpm --filter @du/orchestrator run migrate` ??? ExitCode `0`; database up to date. `migrate:verify` ??? ExitCode `0`; all migrations applied.
- `pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts` ??? ExitCode `0`; 1 suite passed, 11 tests passed, 0 failed/skipped. Live audit endpoint behavior passed.
- `pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts` ??? ExitCode `1`; 1 suite failed, 6 passed/1 failed tests. Failure: API-key list response did not provide the expected `body.rows` array; the other five Admin GET route checks passed.
- `pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts` ??? ExitCode `1`; 1 suite failed, 11 passed/1 failed tests. Failure: M4 API-key list read expected `list.body.rows`, which was undefined; D1-D4, M1-M3, M5-M6, X1-X2 passed.
- Raw output: `coordination/reports/T-CODEX-TEST-29-live-audit.log`.

## T-CODEX-TEST-30 ??? Live API-key envelope re-validation

- Receipt time: `2026-09-26T13:52:59.2147493+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No source edits, commit, or push.
- `CLAIM_DB_WINDOW`: `2026-09-26T13:50:57.0334685+07:00`, PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`. `RELEASE_DB_WINDOW`: `2026-09-26T13:52:59.2147493+07:00` after all suites completed.
- Migrations: `migrate` ExitCode `0` (up to date); `migrate:verify` ExitCode `0` (all applied).
- `admin-base-routes.test.ts`: ExitCode `1`; 6 passed, 1 failed (7 total). Envelope alignment was accepted (`items ?? rows`), but the expected seeded key was absent from the returned items, so `foundKey` was undefined. Other five Admin GET checks passed.
- `admin-action-rbac-live.test.ts`: ExitCode `0`; 1 suite, 12/12 tests passed.
- `admin-audit.test.ts`: ExitCode `0`; 1 suite, 11/11 tests passed.
- Raw output: `coordination/reports/T-CODEX-TEST-30-live-audit.log`.

## T-CODEX-TEST-31 ??? Live admin-base-routes tenant-scoped API-key verification

- Receipt time: `2026-09-26T14:11:56.6069816+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No source edits, commit, or push.
- `CLAIM_DB_WINDOW`: `2026-09-26T14:11:07.4163302+07:00`, PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`. `RELEASE_DB_WINDOW`: `2026-09-26T14:11:56.6069816+07:00` immediately after suite completion.
- `pnpm --filter @du/orchestrator run migrate` ??? ExitCode `0`; database up to date. `migrate:verify` ??? ExitCode `0`; all migrations applied.
- `pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts` with `DU_LIVE_INFRA=1` ??? literal ExitCode `0`; 1 suite passed, 7 passed, 0 failed/skipped tests. API-key tenant-scoped query and no-tenant probe passed, along with all six other Admin GET route checks.
- Raw output: `coordination/reports/T-CODEX-TEST-31-live-base-routes.log`.

## T-CODEX-TEST-32 ??? Admin keyset, shell live-pane, tenant fence and sort wiring

- Receipt time: `2026-09-26T15:30:53.5506257+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No source edits, commit, or push.
- `CLAIM_DB_WINDOW`: `2026-09-26T15:30:13.2366039+07:00`, PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`. `RELEASE_DB_WINDOW`: `2026-09-26T15:30:45.7502864+07:00`, before offline suites.
- Migrations: `migrate` ExitCode `0`; `migrate:verify` ExitCode `0`.
- Live `admin-keyset-explain.test.ts`: ExitCode `0`; 1 suite, 6/6 tests passed. Cross-tenant and tenant-scoped plans used `Index Scan`; keyset assertions passed.
- Live `admin-shell-live-pane.test.ts`: ExitCode `0`; 1 suite, 1/1 test passed.
- Live `operation-tenant-fence.test.ts`: ExitCode `0`; 1 suite, 4/4 tests passed.
- Offline sort suites (`admin-operations-list-pagination`, `operations-list-cursor-sort-binding`, `admin-operations-sort-wiring`): ExitCode `0`; 3 suites, 190/190 tests passed.
- Raw output: `coordination/reports/T-CODEX-TEST-32-live-admin-keyset-shell.log`.

## T-CODEX-TEST-33 ??? Live migration 0018 and keyset regression

- Receipt time: `2026-09-26T15:46:44.8335425+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No product source edits, commit, or push.
- Initial `CLAIM_DB_WINDOW`: `2026-09-26T15:42:59.0008898+07:00`, PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`; initial release after migration/keyset run: `2026-09-26T15:43:19.5652992+07:00`.
- `pnpm --filter @du/orchestrator run migrate` ??? ExitCode `0`; applied `0018_operations_sort_keyset_indexes.sql` (1 migration).
- `pnpm --filter @du/orchestrator run migrate:verify` ??? ExitCode `0`; all migrations applied.
- Initial index-check command had a quoting syntax error (ExitCode `1`), so a fresh short claim was made for direct verification: `CLAIM_DB_WINDOW_RETRY=2026-09-26T15:44:34.4121169+07:00`, `RELEASE_DB_WINDOW_RETRY=2026-09-26T15:46:44.8335425+07:00`. The PostgreSQL query confirmed all four indexes: `operations_tenant_updated_id_idx`, `operations_updated_id_idx`, `operations_tenant_deadline_id_idx`, `operations_deadline_id_idx` (retry ExitCode `0`).
- `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` with `DU_LIVE_INFRA=1` ??? ExitCode `0`; 1 suite, 6/6 tests passed. Index presence, no-Sort forward/tenant plans, backward keyset, 1,240-row walk, and insert-between-pages assertions passed.
- Raw output: `coordination/reports/T-CODEX-TEST-33-live-migration-0018.log`.

## T-CODEX-TEST-34 ??? Live S3 pilot and webhook reclaim fence

- Receipt time: `2026-09-26T15:55:23.0662373+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No source edits, commit, or push.
- `CLAIM_DB_WINDOW`: `2026-09-26T15:54:28.1839158+07:00`, PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`, MinIO `127.0.0.1:9003`, bucket `du-artifacts-live2`. `RELEASE_DB_WINDOW`: `2026-09-26T15:55:23.0662373+07:00` immediately after both suites.
- `pnpm --filter @du/orchestrator run migrate:verify` ??? ExitCode `0`; schema verification passed, all migrations applied.
- `pnpm --filter @du/orchestrator test -- tests/data-02-04-live-s3.test.ts` with `DU_LIVE_INFRA=1` and S3 env ??? ExitCode `0`; 1 suite, 5/5 tests passed. Multipart streaming, replay safety, private GET denial, tenant fencing, abort cleanup, TTL sweep, and expired submit all passed.
- `pnpm --filter @du/orchestrator test -- tests/webhook-reclaim-fence.live.test.ts` ??? ExitCode `0`; 1 suite, 2/2 tests passed. Stale claimant fencing and graceful release behavior passed.
- Raw output: `coordination/reports/T-CODEX-TEST-34-live-s3-webhook.log`.

## T-CODEX-TEST-22 ??? Admin browser harness and operator journey verification

- Receipt time: 2026-09-26T08:46:10+07:00. CWD: `D:\Git\dugate\du-rework`. Build/HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline Playwright Chromium with `createAdminShellServer` on loopback OS-assigned ports and synthetic in-process stubs. No PostgreSQL, Redis, S3, platform HTTP, or DB window was used or claimed. No product source files were edited; no commit/push.
- `pnpm --filter @du/browser-tests run lint` ??? literal ExitCode: `0`; TypeScript lint passed (test counts: N/A).
- `pnpm --filter @du/browser-tests run smoke -- tests/journeys.spec.ts` ??? literal ExitCode: `0`; 82 passed, 0 failed, 0 skipped.
- `pnpm --filter @du/browser-tests run smoke -- tests/interactions.spec.ts` ??? literal ExitCode: `0`; 82 passed, 0 failed, 0 skipped.
- `pnpm --filter @du/browser-tests run smoke -- tests/sections.spec.ts` ??? literal ExitCode: `0`; 82 passed, 0 failed, 0 skipped.
- Each smoke invocation reported the configured aggregate 82-test Playwright run. The final `tests/browser/artifacts/artifacts-summary.json` reports 158 axe scans, critical `0`, serious `0`, moderate `12`, minor `0`; no critical/serious axe findings. Journey assertions explicitly checked `scrollWidth <= clientWidth` for 1440x900 desktop, 390x844 mobile, and 320 CSS px reflow; all corresponding no-horizontal-overflow assertions passed.
- Scope evidence: C0 build/harness, C1 filter hooks, C2 pagination/deep-link hooks, and C3 responsive/axe/overflow checks are synthetic in-process evidence. C4 role/action/tenant HTTP authorization, CSRF negative cases, DB state immutability, and audit side effects require live PG/Redis seed; C5 requires live seeded evidence, timestamps/window details, and per-journey screenshots. This packet does not claim C4/C5 live acceptance or close ADM-UX-00/01/03???07/G-ADMIN-OPS.
- Raw output: `coordination/reports/T-CODEX-TEST-22-admin-browser.log`. Artifacts: `tests/browser/artifacts/artifacts-summary.json` and generated screenshots under `tests/browser/artifacts/`.

## T-CODEX-TEST-21 ??? Live PG + S3/MinIO DATA-02/DATA-04 pilot verification

- Receipt time: 2026-09-26T08:24:31.085+07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- `CLAIM_DB_WINDOW`: `2026-09-26T08:21:26.354+07:00`. `RELEASE_DB_WINDOW`: `2026-09-26T08:24:31.085+07:00`.
- Live endpoints: PostgreSQL `127.0.0.1:5433/du_orchestrator_test`; Redis `127.0.0.1:6380`; S3 `http://127.0.0.1:9003`, bucket `du-artifacts-live2`. Credential variable names were set (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`); secret values are omitted.
- Preflight: `pnpm --filter @du/orchestrator run migrate:status` literal ExitCode `0` (`17/17 applied`); `pnpm --filter @du/orchestrator run migrate:verify` literal ExitCode `0` (`Schema verification passed`). AWS CLI was unavailable; equivalent AWS SDK probes succeeded: LIST `KeyCount=0`, HEAD OK, VERSIONING `Enabled`.
- Command run twice: `pnpm --filter @du/orchestrator test -- tests/data-02-04-live-s3.test.ts` (with `DU_LIVE_INFRA=1` and the live PG/Redis/S3 environment). Run 1 literal ExitCode `0`; suites `1 passed, 0 failed, 0 skipped`; tests `5 passed, 0 failed, 0 skipped`. Run 2 literal ExitCode `0`; suites `1 passed, 0 failed, 0 skipped`; tests `5 passed, 0 failed, 0 skipped`.
- Both runs exercised >64 MiB multipart streaming, replay-safe init/complete, private anonymous GET denial, 8 GiB cap, 1 MiB JSON limit, tenant fencing, abort cleanup, TTL orphan sweep, and expired submission rejection. Raw output: `coordination/reports/T-CODEX-TEST-21-live-s3.log`.
- No product source files were edited. No commit or push performed. DB window released immediately after both live runs.

## T-CODEX-TEST-18 ??? LIVE operations keyset index and EXPLAIN validation

- `CLAIM_DB_WINDOW`: 2026-09-26 05:04:23 +07:00. Target: PostgreSQL `localhost:5433/du_orchestrator_test`. `RELEASE_DB_WINDOW`: 2026-09-26 05:04:48 +07:00 after suite cleanup; no further DB commands ran.
- CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Environment variables: `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@localhost:5433/du_orchestrator_test`; no source edits, commit, or push.
- Migration command: `pnpm --filter @du/orchestrator run migrate` ??? literal ExitCode: `0`; migration 0017 was already applied on rerun (`Database is up-to-date. No pending migrations.`) and verification passed.
- Migration verify command: `pnpm --filter @du/orchestrator run migrate:verify` ??? literal ExitCode: `0`; `Schema verification passed. All migrations applied.`
- Live test command: `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` ??? literal ExitCode: `1`; suites: 0 passed, 1 failed, 0 skipped; tests: 4 passed, 2 failed, 0 skipped (6 total). Raw output: `coordination/reports/T-CODEX-TEST-18-keyset-explain.log`.
- EXPLAIN evidence: cross-tenant and tenant-scoped page queries had no `Sort` and used `operations_created_id_idx`; the seeded keyset walk covered 1,240 rows without skips/repeats. The backward page query contained a `Sort` node and failed its no-Sort assertion. The insert-between-pages test also failed because the inserted newer row was not found in page 1 under the current query/fixture behavior.
- RED gate remains open for the backward-plan and insert-between-pages findings; DB window is released.

## T-CODEX-TEST-19 ??? LIVE OIDC-03 HTTP role/action/tenant matrix

- Initial `CLAIM_DB_WINDOW`: 2026-09-26 05:07:01 +07:00. Target: PostgreSQL `localhost:5433/du_orchestrator_test` and Redis `localhost:6380`. Initial run failed during `createApp` migration connection setup (`AggregateError` at `schema_migrations`) before cells could execute; initial `RELEASE_DB_WINDOW`: 05:07:38 +07:00.
- Retry `CLAIM_DB_WINDOW`: 2026-09-26 05:07:41 +07:00. Retry suite completed and cleanup finished; `RELEASE_DB_WINDOW`: 2026-09-26 05:08:38 +07:00. No source edits, commit, or push. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@localhost:5433/du_orchestrator_test`, `REDIS_URL=redis://localhost:6380`.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts` ??? final retry literal ExitCode: `1`; suites: 0 passed, 1 failed, 0 skipped; tests: 9 passed, 3 failed, 0 skipped (12 total). Raw output: `coordination/reports/T-CODEX-TEST-19-admin-rbac-live.log`.
- Cell result: D1, D2, D3, D4, M1, M4, M6, X1, X2 passed. M2 failed because operator operations response did not expose the expected `rows` array; M3 failed for the same response-shape issue before tenant-B comparison; M5 failed because platform envelope was `{items, limit, nextCursor, prevCursor, total}` instead of the expected `{rows, limit, total}`.
- The retry reached the live app and exercised tenant isolation, audit, CSRF, idempotency, and cancellation cells. The three response-contract failures keep the OIDC-03 live gate RED. Initial DB connection failure and retry are both preserved in the raw log.

## T-CODEX-TEST-20 ??? LIVE keyset EXPLAIN and OIDC-03 HTTP matrix re-validation

- `CLAIM_DB_WINDOW`: 2026-09-26 05:16:16 +07:00. Target: PostgreSQL `localhost:5433/du_orchestrator_test` and Redis `localhost:6380`. `RELEASE_DB_WINDOW`: 2026-09-26 05:17:24 +07:00 after both suites completed and cleanup finished.
- CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Environment: `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@localhost:5433/du_orchestrator_test`, `REDIS_URL=redis://localhost:6380`. No source edits, commit, or push.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 6 passed, 0 failed, 0 skipped (6 total). Cross-tenant, tenant-scoped, and backward plans passed no-Sort/index assertions; keyset walk covered 1,240 rows and insert-between-pages passed.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 12 passed, 0 failed, 0 skipped (12 total). D1-D4, M1-M6, and X1-X2 all passed, including tenant isolation, zero-side-effect denials, audit actor checks, CSRF, idempotency replay, and operation cancellation.
- Combined raw output: `coordination/reports/T-CODEX-TEST-20-live-reval.log`.

## T-CODEX-TEST-7 ??? Offline Worker-SDK artifact, multipart, session, and sweep suites

- Receipt time: 2026-09-26 01:39:02 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no live DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/worker-sdk test -- tests/artifact-multipart-rss.test.ts tests/artifact-multipart.test.ts tests/artifact-read-metadata.test.ts tests/artifact-stat.test.ts tests/artifact-streams.test.ts tests/artifact-sweep-guard.test.ts tests/connector-session.test.ts tests/fan-out.test.ts tests/network-boundaries.boundary.test.ts tests/source-acquisition.test.ts tests/temp-sweep.test.ts tests/worker.test.ts` ??? literal ExitCode: `0`; suites: 12 passed, 0 failed, 0 skipped; tests: 203 passed, 0 failed, 0 skipped (203 total). Raw output: `coordination/reports/T-CODEX-TEST-7-worker-sdk.log`.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-7-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-7-connector-typecheck.log`.
- The Worker-SDK suite included the 1 GiB RSS multipart measurement and completed green in 134.116 seconds. The pnpm wrapper emitted a `NativeCommandError` record while forwarding a Jest PASS line; the final Jest summary was green.

## T-CODEX-TEST-8 ??? Offline Observability and Egress SSRF boundary suites

- Receipt time: 2026-09-26 01:42:34 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no live DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/observability test -- tests/observability.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 22 passed, 0 failed, 0 skipped (22 total). Raw output: `coordination/reports/T-CODEX-TEST-8-observability.log`.
- Command: `pnpm --filter @du/egress test -- tests/egress-boundaries.boundary.test.ts tests/egress-ssrf-deny-matrix.boundary.test.ts tests/egress-ssrf-redirect-matrix.boundary.test.ts` ??? final literal ExitCode: `0`; suites: 3 passed, 0 failed, 0 skipped; tests: 34 passed, 0 failed, 0 skipped (34 total). Raw output: `coordination/reports/T-CODEX-TEST-8-egress.log`.
- Egress had one transient first attempt with `EADDRINUSE` on a loopback test port (2 failed, 32 passed); after the listener/port state was clear, the exact command was rerun and passed fully. The retained raw log is the successful rerun.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-8-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-8-connector-typecheck.log`.
- The pnpm wrapper emitted `NativeCommandError` records while forwarding Jest PASS lines; final retained Jest summaries were green.

## T-CODEX-TEST-9 ??? Offline Migration 008 revision binding and Vault reference contracts

- Receipt time: 2026-09-26 02:06:23 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no live DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/connector test -- tests/revision-binding.schema.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 9 passed, 0 failed, 0 skipped (9 total). Raw output: `coordination/reports/T-CODEX-TEST-9-connector-schema.log`.
- Command: `pnpm --filter @du/contracts test -- --runTestsByPath tests/vault-ref.test.ts` ??? literal ExitCode: `0`; suites: 1 passed, 0 failed, 0 skipped; tests: 59 passed, 0 failed, 0 skipped (59 total). Raw output: `coordination/reports/T-CODEX-TEST-9-contracts.log`.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-9-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-9-connector-typecheck.log`.
- The pnpm wrapper emitted `NativeCommandError` records while forwarding Jest PASS lines; final Jest summaries were green.

## T-CODEX-TEST-6 ??? Offline Document-Core lifecycle, reliability, and boundary suites

- Receipt time: 2026-09-26 01:31:40 +07:00. CWD: `D:\Git\dugate\du-rework`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Environment: offline local Jest/build/typecheck runs only; no PostgreSQL, Redis, or S3 connection and no live DB window claimed. No product source files were edited. No commit/push.
- Command: `pnpm --filter @du/document-core test -- tests/bounded-input.test.ts tests/barrier-cleanup-lifecycle.test.ts tests/child-lifecycle.test.ts tests/corpus-regression.test.ts tests/cross-service-boundary.test.ts tests/execution-pin.functional.test.ts tests/profile-binding-fixture.test.ts tests/r1-e-artifact-inputs.test.ts tests/r1-e-trusted-format-propagation.test.ts tests/suite-bootstrap-contract.test.ts tests/traceability.test.ts tests/worker.test.ts` ??? literal ExitCode: `0`; suites: 12 passed, 0 failed, 0 skipped; tests: 152 passed, 0 failed, 0 skipped (152 total). Raw output: `coordination/reports/T-CODEX-TEST-6-document-core.log`.
- Command: `pnpm --filter @du/contracts build` ??? literal ExitCode: `0`; build completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-6-contracts-build.log`.
- Command: `pnpm --filter @du/connector typecheck` ??? literal ExitCode: `0`; typecheck completed successfully (test counts: N/A). Raw output: `coordination/reports/T-CODEX-TEST-6-connector-typecheck.log`.

- The pnpm wrapper emitted a `NativeCommandError` record while forwarding a Jest PASS line; the final Jest summary was green.

## T-CODEX-TEST-35 -- LIVE keyset EXPLAIN, six 0017+0018 sort indexes (T180-A1 live proof)

- Receipt time: `2026-09-26T16:25:05.6702172+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. No product source edits, no commit, no push.
- Window 1: `CLAIM_DB_WINDOW` `2026-09-26T16:16:29.2055689+07:00` -> `RELEASE_DB_WINDOW` `2026-09-26T16:19:11.4119380+07:00`. PostgreSQL `127.0.0.1:5433/du_orchestrator_test`, Redis `127.0.0.1:6380`.
- `pnpm --filter @du/orchestrator run migrate:verify` attempt 1 -- literal Exit Code `1`: `DATABASE_URL` was missing from the shell env (`src/migrate-cli.ts:27` prints `DATABASE_URL is required`). Rerun inside the same window with `DATABASE_URL` set -- literal Exit Code `0`, log line `Schema verification passed. All migrations applied.` (marker `MIGRATE_VERIFY_EXITCODE=0`).
- Window 1 suite run -- literal Exit Code `1` (marker `LIVE_SUITE_EXITCODE=1`): all 13 live tests failed with `connect ETIMEDOUT 127.0.0.1:5433` in the `beforeAll` `migrate()`; Jest `Tests: 13 failed, 4 passed, 17 total`, `Time: 3.855 s`. `docker ps`: `du-rework-postgres` and `du-rework-redis` `Up 35 hours (healthy)`, no restart; TCP probes to both ports succeeded right after release. Recorded as a transient infra connect failure, NOT a plan verdict; window released before any retry.
- Window 2 retry: `CLAIM_DB_WINDOW_RETRY` approx `2026-09-26T16:20:15+07:00` (the intended claim-note line failed to write due to a PowerShell parser error; bounded by window 1 release `16:19:11.411` and retry release `16:20:53.614`; correction note is appended in the raw log) -> `RELEASE_DB_WINDOW_RETRY` `2026-09-26T16:20:53.6149245+07:00`.
- Window 2 suite run: `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts` with `DU_LIVE_INFRA=1`, `DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test`, `REDIS_URL=redis://127.0.0.1:6380` -- literal Exit Code `1` (marker `LIVE_SUITE_RETRY_EXITCODE=1`); Jest `Test Suites: 1 failed, 1 total`, `Tests: 3 failed, 14 passed, 17 total`, `Time: 4.473 s`.
- DEVIATION-1 suite-file drift: the packet described a 13-test suite; the on-disk file was edited by another lane at `2026-09-26T16:14:53+07:00` (552 lines, 26673 bytes), adding 4 offline synthetic decision-bar tests. Both window runs targeted this current on-disk version (13 live + 4 offline = 17).
- T180-A1 verdict evidence from window 2 (the packet goal):
  - PASS: `all six keyset indexes from 0017 and 0018 are present` -- 6/6 names returned by pg_indexes.
  - PASS created_at: cross-tenant and tenant-scoped forward plans are `Limit -> Index Scan using operations_created_id_idx` with NO `Sort` (Execution Time 0.121/0.240 ms); the backward hop SEEKED the boundary via `Index Cond: (ROW(created_at, id) > ...)` with a bounded 63-row quicksort (46kB), no Seq Scan; the created_at keyset walk covered the whole seeded population with no skips/repeats (tie group included).
  - PASS updated_at: cross-tenant and tenant-scoped forward plans are `Index Scan using operations_updated_id_idx` with NO `Sort`; backward hop `Index Cond: (ROW(updated_at, id) > ...)` with bounded sort; the updated_at walk covered every row with no skips/repeats; insert-between-pages assertions passed.
  - FAIL, and this is the verdict rather than noise: all three deadline_at plan tests -- for the route-shaped `COALESCE(deadline_at, sentinel)` ORDER BY the planner chose `Limit -> Sort (top-N heapsort) -> Seq Scan on operations`; neither `operations_tenant_deadline_id_idx` nor `operations_deadline_id_idx` appears in ANY deadline plan. This is exactly the documented 0019-branch condition in the suite header ("the planner ignored both deadline indexes entirely"). Applied migration 0018 was NOT edited (the applied-checksum silent-skip rule, delta 24); the decision to open a 0019 expression-index migration belongs to the coordinator/implementer lanes, not to this Tester window.
  - PASS: 4/4 offline synthetic deadline decision-bar tests (the bar itself is guarded against false greens).
- Window 3 (short claim, for the packet-mandated migration count): `CLAIM_DB_WINDOW3` `2026-09-26T16:23:04.2270094+07:00` -> `RELEASE_DB_WINDOW3` `2026-09-26T16:23:16.4247947+07:00`; `pnpm --filter @du/orchestrator run migrate:status` -- literal Exit Code `0` (marker `MIGRATE_STATUS_EXITCODE=0`); log line `Migrations: 18/18 applied`.
- DEVIATION-2 infra incident: a transient `connect ETIMEDOUT` on every pool connection around 16:19 while both containers stayed `Up 35 hours (healthy)`; TCP probes succeeded minutes later and the retry window connected normally. If it recurs, suspect Docker Desktop port-proxy contention under parallel fleet load before blaming product code.
- Honest status: live execution completed; created_at and updated_at index USE is live-VERIFIED on 4 of 6 indexes; USE of the 2 deadline indexes is live-FALSIFIED at 1,240-row scale (0019 branch evidence delivered); T180-A1 closure is NOT self-granted -- Reviewer/coordinator adjudicate.
- Raw output: `coordination/reports/T-CODEX-TEST-35-live-sort-explain.log` (589 lines at write time; contains both window runs, all markers, and the retry-claim correction note).
- ENCODING INCIDENT post-receipt: the blank-line fix attempted via PowerShell Get-Content and Set-Content with -Encoding UTF8 double-encoded tester.md because PS5.1 reads BOM-less UTF-8 as cp1252, and added a BOM. Repaired by reversing cp1252 back to UTF-8 byte-for-byte with zero U+FFFD content loss; repaired file SHA256 f295b7db05926847c23dbe16d8bda4dcdc63c59ebf4229d88b1bec7b8713f1b0 at 415416 bytes. Side effect kept after repair: line endings are now uniformly CRLF because the original file had mixed CRLF and bare LF on roughly 3121 lines and the rewrite lost which lines were LF. Receipt content itself is unchanged. Corrupted-state backup: D:\Git\dugate\.qwen\tmp\tester-corrupted.bak. Lesson for the fleet: never round-trip a shared non-ASCII file through PS5.1 Get-Content/Set-Content; use byte-level .NET IO instead.

## T-CODEX-TEST-36 -- Multi-suite offline regression sweep, Platform Sec 10/11 and Admin Sec 18/19

- Receipt time: `2026-09-26T17:23:17.9068456+07:00`. CWD: `D:\Git\dugate\du-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Mode: STRICT OFFLINE -- no DB window claimed, `DU_LIVE_INFRA` not defined in the shell env (raw log line `Environment variable DU_LIVE_INFRA   not defined` recorded as proof), no PostgreSQL/Redis/S3 contact. No product source edits, no commit, no push.
- Sweep timeline: SWEEP_START `17:18:45.758` (packet-literal block) -> SWEEP_END `17:19:19.291`; two rerun blocks appended; ALL_BLOCKS_END `17:22:38.420`. Marker labels: packet-literal `STEPn_EXITCODE`, reruns `RUN1_*` and `RUN3_*` (label gap is cosmetic; three consecutive full blocks are present in the log).
- Suite results -- each of the 5 suites green in 3/3 consecutive blocks, every per-run literal ExitCode `0`:
  - `tests/credential-legacy-transition-offline.test.ts` @du/orchestrator: 1 suite, 13 passed, 0 failed, 0 skipped; 3/3.
  - `tests/vault-bootstrap-offline.test.ts` @du/connector: 1 suite, 11 passed, 0 failed, 0 skipped; 3/3.
  - `tests/url-ingestion-consumer-offline.functional.test.ts` @du/orchestrator: 1 suite, 33 passed, 0 failed, 0 skipped; 3/3.
  - `tests/admin-operations-sort-http-offline.test.ts` @du/orchestrator: 1 suite, 32 passed, 0 failed, 0 skipped; 3/3.
  - `tests/admin-keyset-explain.test.ts` @du/orchestrator offline mode: 1 suite, 4 passed + 13 skipped (17 total), 0 failed; 3/3 -- exactly the packet expectation `4 synthetic pass, 13 skip`; the 13 skips are the live-gated half and are NOT claimed as pass.
  - Block aggregate: 5 suites, 93 passed, 13 skipped, 0 failed per block; across blocks 279 passed, 39 skipped, 0 failed. Skip is not counted as pass anywhere in this receipt.
- DEVIATION packet-step6a-false-green: `pnpm --filter @du/orchestrator typecheck` printed `None of the selected packages has a "typecheck" script` and STILL exited 0 -- a silent no-op, not a typecheck. The orchestrator package.json has no `typecheck` script; the semantic equivalent is `lint` = `tsc --noEmit -p tsconfig.json`. Equivalent run: `pnpm --filter @du/orchestrator run lint` -- literal ExitCode `0` in both rerun blocks (RUN1_L, RUN3_L). The packet STEP6A line must not be quoted as orchestrator typecheck evidence; recommend a `typecheck` alias or a corrected packet.
- Cross-package steps: `pnpm --filter @du/connector typecheck` ExitCode `0` 3/3; `pnpm --filter @du/contracts build` ExitCode `0` 3/3; orchestrator equivalent `lint` ExitCode `0` 2/2.
- Drift guard: SHA256 of all 5 suite files identical across HASHES_BEFORE / HASHES_AFTER / HASHES_FINAL in the raw log (43BF569A..., 12B69CC8..., B105D90B..., 4966467B..., F71032F6...). Two suites were edited shortly BEFORE the sweep by their owning lanes (url-ingestion 17:00:54, admin-operations-sort-http 17:04:57) -- consistent with Platform T180-D1/D2 and Admin Sec 19 deliveries; nothing moved during the sweep.
- Raw output: `coordination/reports/T-CODEX-TEST-36-offline-regression.log` (746 lines, 3 full blocks + hash guards + markers).
- Writing method: this receipt was appended byte-level via node as UTF-8 without BOM, per the T-CODEX-TEST-35 lesson; no PowerShell 5.1 Get-Content/Set-Content round-trip was used on tester.md.
- Honest status: 5/5 suites [VERIFIED offline] at the working-tree state checked; orchestrator typecheck [PASS via equivalent lint]; connector typecheck + contracts build [PASS]. No acceptance decisions made; the T-35 live deadline_at reds remain standing and untouched by this offline sweep.

## T-CODEX-TEST-37 -- Strict-offline x3 sweep of 7 suites (T-36 five + 2 submission suites, with hash guard)

- Receipt time: `2026-09-26T22:49:57+07:00`. CWD: `D:Gitdugatedu-rework`; HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Mode: STRICT OFFLINE -- no DB window claimed, `DU_LIVE_INFRA` not defined in the shell env (raw log line `Environment variable DU_LIVE_INFRA   not defined` recorded as proof), no PostgreSQL/Redis/S3 contact. No product source edits, no commit, no push.
- Prereq verified: `pnpm --filter @du/orchestrator typecheck` exists as `tsc --noEmit -p tsconfig.json` (packet STEP6A real, not a silent no-op); `pnpm --filter @du/connector typecheck` same; `pnpm --filter @du/contracts build` as `tsc -p tsconfig.json`.
- Sweep timeline: BLOCK 1 `2026-09-26T22:48:02+0700` -> `22:48:50+0700`; BLOCK 2 `22:48:50+0700` -> `22:49:22+0700`; BLOCK 3 `22:49:22+0700` -> `22:49:53+0700`; ALL_BLOCKS_END `22:49:57+0700`. Marker labels: `BLOCKn_*_EXITCODE` per suite/build.
- Suite results -- each of the 7 suites green in 3/3 consecutive blocks, every per-run literal ExitCode `0`:
  - `tests/credential-legacy-transition-offline.test.ts` @du/orchestrator: 1 suite, 13 passed, 0 failed, 0 skipped; 3/3.
  - `tests/vault-bootstrap-offline.test.ts` @du/connector: 1 suite, 11 passed, 0 failed, 0 skipped; 3/3.
  - `tests/url-ingestion-consumer-offline.functional.test.ts` @du/orchestrator: 1 suite, 33 passed, 0 failed, 0 skipped; 3/3.
  - `tests/admin-operations-sort-http-offline.test.ts` @du/orchestrator: 1 suite, 32 passed, 0 failed, 0 skipped; 3/3.
  - `tests/admin-keyset-explain.test.ts` @du/orchestrator offline half: 1 suite, 4 passed + 13 skipped (17 total), 0 failed; 3/3 -- exactly the packet expectation `4 synthetic pass, 13 skip`; the 13 skips are the live-gated half and are NOT counted as pass.
  - `tests/url-ingestion-backend-failclosed-offline.test.ts` @du/orchestrator (NEW since T-36): 1 suite, 4 passed, 0 failed, 0 skipped; 3/3 -- postgres+sourceUrl 422 fail-closed, unwired backend same, s3 202-path, inline unaffected.
  - `tests/url-ingestion-offline.functional.test.ts` @du/orchestrator (aligned suite): 1 suite, 3 passed, 0 failed, 0 skipped; 3/3.
  - Block aggregate: 7 suites, 100 passed, 13 skipped, 0 failed per block; across 3 blocks 300 passed, 39 skipped, 0 failed. Skip is not counted as pass anywhere in this receipt.
- Cross-package steps per block (all 3/3 ExitCode `0`):
  - `pnpm --filter @du/orchestrator typecheck` -- ExitCode `0` 3/3 (W-TYPECHECK-ALIAS-1 verified: `tsc --noEmit` runs, not a no-op).
  - `pnpm --filter @du/connector typecheck` -- ExitCode `0` 3/3.
  - `pnpm --filter @du/contracts build` -- ExitCode `0` 3/3.
- ExitCode matrix (all `0`): BLOCK1 10/10, BLOCK2 10/10, BLOCK3 10/10 -- 30/30 green. Per-suite marker literals present in raw log as `BLOCKn_CRED/VAULT/CONSUMER/SORT/KEYSET/FAILCLOSED/URLINGEST_EXITCODE=0` and `BLOCKn_ORCH/CONN_TYPECHECK/CONTRACTS_BUILD_EXITCODE=0`.
- Drift guard: SHA256 of all 7 suite files identical across HASHES_BEFORE / HASHES_AFTER / HASHES_FINAL in the raw log (43BF569A..., 12B69CC8..., B105D90B..., 4966467B..., F71032F6..., BFEE81C3..., D96967A4...). Nothing moved during the sweep. Full hashes in raw log header/footer.
- Deviations: none. No infra incident, no flake, no rerun outside the 3 counted blocks. Raw log carries no PG/Redis connection attempts. No product source edits.
- Raw output: `coordination/reports/T-CODEX-TEST-37-offline-regression.log` (877 lines, 3 full blocks + before/after/final hash guards + markers). UTF-8 without BOM.
- Writing method: raw log appended via bash tee; this receipt appended byte-level via node as UTF-8 without BOM (no PowerShell Get-Content/Set-Content round-trip).
- Honest status: 7/7 suites [VERIFIED offline] at the working-tree state checked; orchestrator typecheck + connector typecheck + contracts build [PASS] 3/3 each; T-35 live deadline_at reds remain standing and untouched by this offline sweep; no acceptance decisions made.

## T-CODEX-OFFLINE-INGEST-0019-2 -- independent W-INGEST-0019-2 receipt

- Receipt time: `2026-09-27T12:29:51+07:00`. Working tree: `7811298` (full HEAD `7811298844450f373687c478d08d1edfa53ae124`). This was a read-only verification run; no product source or migration was edited, and only this receipt was appended.
- Environment proof for the targeted Admin run: from `D:\Git\dugate\du-rework\services\orchestrator`, `DU_LIVE_INFRA_SET=False`, `DATABASE_URL_SET=False`, `REDIS_URL_SET=False`. The three Admin files explicitly describe recording/fake DB or loopback-only operation with no PG/Redis/S3/DB window.

### Commands and results

- CWD `D:\Git\dugate\du-rework`: `services/orchestrator/node_modules/.bin/tsc --noEmit -p services/orchestrator/tsconfig.json` -> **ExitCode 0**. This is the local equivalent of the requested `tsc --noEmit -p services/orchestrator/tsconfig.json`; the bare `tsc` command is not on this shell's PATH.
- CWD `D:\Git\dugate\du-rework\services\orchestrator`: `pnpm run test:unit -- admin-operations-sort-http-offline admin-operations-list-pagination operations-list-contract-conformance admin-keyset-explain` -> **ExitCode 1**; Jest **3 failed, 1 passed, 4 total suites** and **14 failed, 13 skipped, 130 passed, 157 total tests**.
- CWD `D:\Git\dugate\du-rework\services\orchestrator`: `pnpm run test:unit` -> **ExitCode 1**; Jest **4 failed, 1 skipped, 70 passed, 74 of 75 suites** and **15 failed, 28 skipped, 1,774 passed, 1,817 total tests**.
- CWD `D:\Git\dugate\du-rework\services\orchestrator`: `pnpm run test:unit -- connector-revision-http-offline.functional.test.ts` -> **ExitCode 1**; isolated Connector functional suite **1 failed, 7 passed, 8 total tests**.

### W-INGEST-0019-2 / ORDER BY verification

- `services/orchestrator/src/server.ts` currently maps `desc` to `0001-01-01T00:00:00.000Z` and `asc` to `9999-12-31T23:59:59.999Z` (the `OPERATIONS_LIST_NULL_SORT_BOUND_SQL` map), and `bindOperationsListSortKey` emits `COALESCE(${column}, '${sentinel}'::timestamptz)` inline. The sort builder has no `params.push`; `bindOperationsCursor` still pushes only `(cursor.createdAt, cursor.id)` and emits the timestamptz/uuid boundary placeholders; `listOperationsPage` reuses `sortKeySql` for both predicate and `ORDER BY`.
- Read-only expression comparison (CWD `D:\Git\dugate\du-rework`) -> **ExitCode 0**: migration 0019 contains each full expression exactly twice (tenant-leading and key-leading indexes), and both source sentinels match byte-for-byte. The four migration definitions are at lines 66???79: desc uses `'0001-01-01T00:00:00.000Z'::timestamptz`, asc uses `'9999-12-31T23:59:59.999Z'::timestamptz`; route-emitted SQL in the targeted harness shows the same inline literal form.

### Independent Delta 29 confirmation

The 14 targeted failures are deterministic Admin-lane fake-DB/harness incompatibilities with the new literal SQL, not a typecheck failure: `admin-operations-list-pagination.test.ts` has **5** `unrecognised ORDER BY key expression` failures; `admin-operations-sort-http-offline.test.ts` has **7** HTTP 500/fake-parser failures; `operations-list-contract-conformance.test.ts` has **2** assertions still expecting `COALESCE(deadline_at, $n::timestamptz)` and a bound sentinel; `admin-keyset-explain.test.ts` is **1 passed + 13 skipped** because its live half is gated. This independently reproduces the reported **Delta 29 = 14 Admin-lane fake-DB failures**; the source fix is emitting the required 0019 Const literal, while those harnesses still parse/assert the former Param shape. No live database, Redis, S3, or browser evidence is claimed.

### Independent Delta 31 confirmation

The full Orchestrator unit run's fifteenth failure is separate from the 14 Admin failures: `tests/connector-revision-http-offline.functional.test.ts`, VAULT-06, `restart/reconcile: stranded PENDING ...`, expects `stranded.revision` to equal `2` but receives `undefined` at line 343. Running that suite alone reproduces **1 failed / 7 passed / 8 total, ExitCode 1**; its fixture uses the real HTTP wire over an in-memory Connector repository and explicitly states zero DB/Redis. The test file is untracked in the current tree and does not exercise the `server.ts` ORDER BY path, confirming the requested **Delta 31 connector functional failure** is collateral/pre-existing to W-INGEST-0019-2 rather than caused by this packet.

- Honest status: **W-INGEST-0019-2 source/typecheck and 0019 expression alignment verified offline; Delta 29 (14 Admin harness failures) and Delta 31 (1 isolated Connector failure) remain red and are not fixed in this read-only lane.**

## T-CODEX-OFFLINE-ADMIN-0019-DELTA29 -- independent closure receipt

- Receipt time: `2026-09-27T15:07:50+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. This verification was read-only: no product source, migration, or test file was edited; only this receipt was appended.
- CWDs are stated exactly below. The targeted command was run with the offline Jest config; `admin-keyset-explain.test.ts` reports its 13 live-gated cases as skipped, not passed.

### Commands and results

- CWD `D:\Git\dugate\du-rework`: `services/orchestrator/node_modules/.bin/tsc --noEmit -p services/orchestrator/tsconfig.json` -> **ExitCode 0**.
- CWD `D:\Git\dugate\du-rework\services\orchestrator`: `pnpm run test:unit -- admin-operations-sort-http-offline admin-operations-list-pagination operations-list-contract-conformance admin-keyset-explain` -> **ExitCode 0**; **4 passed suites, 0 failed**, **144 passed, 13 skipped, 157 total tests**. All four targeted Admin suites pass; the only skips are the live half of `admin-keyset-explain.test.ts`.
- CWD `D:\Git\dugate\du-rework\services\orchestrator`: first `pnpm run test:unit` attempt -> **ExitCode 1**, with a transient unrelated loopback/timeout cluster (webhook boundary, Admin OIDC, and mock IdP) alongside Delta 31; this was not accepted as the aggregate result.
- CWD `D:\Git\dugate\du-rework\services\orchestrator`: immediate rerun `pnpm run test:unit` -> **ExitCode 1** with **1 failed, 1 skipped, 73 passed suites, 74 of 75 total** and **1 failed, 28 skipped, 1,788 passed, 1,817 total tests**. The sole failure is `connector-revision-http-offline.functional.test.ts` VAULT-06 `restart/reconcile: stranded PENDING ...`, expecting revision `2` but receiving `undefined` at line 343 (Delta 31); no Delta 29 test fails.

### Delta 29 and migration 0019 alignment

- A read-only PowerShell comparison from CWD `D:\Git\dugate\du-rework` -> **ExitCode 0**: migration 0019 contains the desc literal expression twice and asc literal expression twice; `server.ts` contains the matching desc/asc sentinel map entries; the sort builder contains no `params.push`; and the conformance test contains the matching inline literals and no bound-sentinel expectation.
- The migration expressions are the four definitions at `services/orchestrator/migrations/0019_operations_deadline_coalesce_index.sql:66-79`: `COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)` for desc and `COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz)` for asc, each in tenant-leading and cross-tenant indexes. The targeted fake DB harnesses now parse the same inline Const-literal SQL emitted by `server.ts`.
- **Delta 29 is eliminated offline: 14 prior Admin fake-DB/harness failures -> 0 failures.** The targeted suites are green at 4/4 suites and 144/144 executed tests; 13 live-gated skips remain explicitly unclaimed.

- Honest status: **W-ADMIN-0019-DELTA29 is independently verified and closed at offline test scope; the full suite still has only the isolated pre-existing Delta 31 Connector failure (73 passed suites), and no acceptance claim is made for live PostgreSQL planner evidence.**


## T190-A1 / Delta 21 ??? migration 0019 live EXPLAIN

- Receipt time: 2026-09-27 17:22 +07. Read-only verification; no migration, source, test, or contract files changed. The only repository write is this receipt.
- Database window probe: CLAIM_DB_WINDOW=2026-09-27T17:22:01+07:00 -> RELEASE_DB_WINDOW=2026-09-27T17:22:01+07:00. The initial guard stopped before tests/seeding because PostgreSQL reported its container-side server port 5432; no test or data writes occurred in that probe.
- Verified DB window: CLAIM_DB_WINDOW=2026-09-27T17:22:29+07:00 -> RELEASE_DB_WINDOW=2026-09-27T17:22:33+07:00. A session advisory lock was acquired and released (DB_WINDOW_ADVISORY_UNLOCK=true). Target confirmed as database du_orchestrator_test through host remote port 5433; PostgreSQL reports internal port 5432 due to port forwarding.
- Redis: 127.0.0.1:6380 PING returned PONG; REDIS_PING_EXITCODE=0.
- CWD: D:\Git\dugate\du-rework\services\orchestrator. Command: pnpm test -- tests/admin-keyset-explain.test.ts with DU_LIVE_INFRA=1, DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test, REDIS_URL=redis://127.0.0.1:6380. LIVE_SUITE_EXITCODE=1; Jest reported 1 failed suite, 3 failed tests, 14 passed tests (17 total). The three deadline tests selected migration 0019 expression indexes, but their current assertion still requires the old operations_(tenant_)?deadline_id_idx name; this is a stale assertion mismatch, not a Seq Scan or Sort result.
- The four migration 0019 indexes were present in pg_indexes: operations_tenant_deadline_coalesce_desc_id_idx, operations_deadline_coalesce_desc_id_idx, operations_tenant_deadline_coalesce_asc_id_idx, operations_deadline_coalesce_asc_id_idx.
- Multi-tenant seed: 20 tenants x 200 operations each (4,000 temporary rows), with alternating NULL/non-NULL deadlines. The seed and probes ran inside a transaction; rollback completed and post-cleanup counts were tenants=0, operations=0. ANALYZE ran after rollback to restore table statistics.
- Direct EXPLAIN verification: four of four plan assertions passed. Tenant-scoped DESC/ASC each chose the matching tenant-leading 0019 index; cross-tenant DESC/ASC each chose the matching key-leading 0019 index. Every plan used Index Scan with no Seq Scan and no Sort. EXPLAIN_VERIFICATION_EXITCODE=0.

EXPLAIN tenant DESC forward:
    Limit  (cost=0.28..132.90 rows=51 width=32) (actual time=0.025..0.042 rows=51 loops=1)
      Buffers: shared hit=7
      ->  Index Scan using operations_tenant_deadline_coalesce_desc_id_idx on operations  (cost=0.28..390.33 rows=150 width=32) (actual time=0.024..0.038 rows=51 loops=1)
            Index Cond: ((tenant_id = 'd0a92f15-06ce-4024-864d-03bce93738bc'::uuid) AND (ROW(COALESCE(deadline_at, '0001-01-01 00:00:00+00'::timestamp with time zone), id) < ROW('2026-06-01 00:01:40+00'::timestamp with time zone, '80000000-0000-4000-8000-000000000000'::uuid)))
            Buffers: shared hit=7
    Planning:
      Buffers: shared hit=137
    Planning Time: 0.625 ms
    Execution Time: 0.136 ms
    PLAN_ASSERTION tenant DESC forward: PASS; no_seq_scan=true; no_sort=true

EXPLAIN cross-tenant DESC forward:
    Limit  (cost=0.28..12.42 rows=51 width=32) (actual time=0.018..0.054 rows=51 loops=1)
      Buffers: shared hit=55
      ->  Index Scan using operations_deadline_coalesce_desc_id_idx on operations  (cost=0.28..717.43 rows=3012 width=32) (actual time=0.018..0.051 rows=51 loops=1)
            Index Cond: (ROW(COALESCE(deadline_at, '0001-01-01 00:00:00+00'::timestamp with time zone), id) < ROW('2026-06-01 00:01:40+00'::timestamp with time zone, '80000000-0000-4000-8000-000000000000'::uuid))
            Buffers: shared hit=55
    Planning Time: 0.078 ms
    Execution Time: 0.070 ms
    PLAN_ASSERTION cross-tenant DESC forward: PASS; no_seq_scan=true; no_sort=true

EXPLAIN tenant ASC forward:
    Limit  (cost=0.28..132.90 rows=51 width=32) (actual time=0.028..0.046 rows=51 loops=1)
      Buffers: shared hit=7
      ->  Index Scan using operations_tenant_deadline_coalesce_asc_id_idx on operations  (cost=0.28..390.33 rows=150 width=32) (actual time=0.028..0.043 rows=51 loops=1)
            Index Cond: ((tenant_id = 'd0a92f15-06ce-4024-864d-03bce93738bc'::uuid) AND (ROW(COALESCE(deadline_at, '9999-12-31 23:59:59.999+00'::timestamp with time zone), id) > ROW('2026-06-01 00:01:40+00'::timestamp with time zone, '80000000-0000-4000-8000-000000000000'::uuid)))
            Buffers: shared hit=7
    Planning:
      Buffers: shared hit=3
    Planning Time: 0.078 ms
    Execution Time: 0.060 ms
    PLAN_ASSERTION tenant ASC forward: PASS; no_seq_scan=true; no_sort=true

EXPLAIN cross-tenant ASC forward:
    Limit  (cost=0.28..12.39 rows=51 width=32) (actual time=0.014..0.046 rows=51 loops=1)
      Buffers: shared hit=58
      ->  Index Scan using operations_deadline_coalesce_asc_id_idx on operations  (cost=0.28..715.76 rows=3012 width=32) (actual time=0.014..0.042 rows=51 loops=1)
            Index Cond: (ROW(COALESCE(deadline_at, '9999-12-31 23:59:59.999+00'::timestamp with time zone), id) > ROW('2026-06-01 00:01:40+00'::timestamp with time zone, '80000000-0000-4000-8000-000000000000'::uuid))
            Buffers: shared hit=58
    Planning Time: 0.049 ms
    Execution Time: 0.058 ms
    PLAN_ASSERTION cross-tenant ASC forward: PASS; no_seq_scan=true; no_sort=true

- Honest result: migration 0019 index selection is live-verified for all four paths, including both tenant-leading indexes under the 20-tenant seed. The existing admin-keyset-explain suite remains red only because its deadline index-name assertion has not been updated to the 0019 names.

# T-CODEX-OFFLINE-VAULT-06-DELTA31

- Receipt time: `2026-09-27T18:30:45+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification only; no product source, migration, or test file was edited, and only this receipt was appended.

### Isolated VAULT-06 command

- CWD: `D:\Git\dugate\du-rework`
- Command: `pnpm --filter @du/orchestrator test tests/connector-revision-http-offline.functional.test.ts`
- ExitCode: **0**
- Jest counts: **1 passed suite, 8 passed tests, 0 failed, 0 skipped**. All eight VAULT-06 cases passed, including restart/reconcile of stranded PENDING.

### Full Orchestrator unit command

- CWD: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `pnpm run test:unit`
- ExitCode: **0**
- Jest summary: **1 skipped, 74 passed, 74 of 75 total suites**; **28 skipped, 1,789 passed, 1,817 total tests**. The single skipped suite is the explicitly live-gated `admin-keyset-explain.test.ts`; all 74 executed suites passed.

- Honest result: **Delta 31 / VAULT-06 is independently verified green at 8/8, and the full offline Orchestrator suite is green at 74/74 executed suites.** No live PostgreSQL/Redis acceptance claim is made by this receipt.

## ENC-02 ??? Vault Transit provider adapter

- Task: `APP-ENCRYPTION-2026-09-27.md` / ENC-02
- Working directory: `D:\Git\dugate\du-rework`
- Timestamp: 2026-09-27 21:29:00 +07:00 (Asia/Bangkok)
- Environment: Node v22.16.0, pnpm 10.18.3; unit suite used injected Fetch responses and did not contact Vault, PostgreSQL, Redis, or S3.
- Commit/build digest: N/A; shared working tree was already dirty and no commit/build artifact was created.

### Targeted unit test

- Command: `pnpm --filter @du/orchestrator test -- tests/vault-transit-provider.test.ts`
- Result: PASSED, 9 tests, ExitCode 0.
- Raw output:

```text
> @du/orchestrator@0.1.0 test D:\Git\dugate\du-rework\services\orchestrator
> jest --runInBand "tests/vault-transit-provider.test.ts"

PASS tests/vault-transit-provider.test.ts
  VaultTransitProvider
    ??? wraps a 256-bit DEK, pins its Transit version, and unwraps with the decrypt identity (13 ms)
    ??? uses latest version on wrap by default and reports the version encoded by Vault (3 ms)
    ??? rewraps using latest by default or a requested version without returning plaintext (3 ms)
    ??? rejects refs outside the allowlist and invalid DEK lengths before contacting Vault (1 ms)
    ??? rejects malformed or inconsistent wrapped metadata before contacting Vault (1 ms)
    ??? fails closed on Vault authorization denial, outage, and retired key versions (2 ms)
    ??? does not include Vault response bodies or tokens in errors (2 ms)
    ??? validates endpoint security and immutable allowlist configuration (17 ms)
    ??? requires separate machine identity suppliers for encrypt and decrypt (2 ms)

Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
Snapshots:   0 total
Time:        4.157 s
Ran all test suites matching /tests\\vault-transit-provider.test.ts/i.
```

### TypeScript check

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- Result: PASSED, ExitCode 0; no output.
- Raw output: empty stdout/stderr.

## T-CODEX-TEST-ADM-UX-01-SHELL

- Receipt time: `2026-09-27T21:41:44+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`.
- Scope: ADM-UX-01 shell renderer and focused renderer test. No database, Redis, or browser session was used.
- Environment: Windows PowerShell, Node `v22.16.0`, pnpm `10.18.3`.
- CWD: `D:\Git\dugate\du-rework`.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-shell-render.test.ts`
- Result: **PASS**, ExitCode `0`; 1 suite passed, 140 tests passed, 0 failed, 0 skipped. Raw-output excerpt (stored inline in this receipt):
  ```text
  PASS tests/admin-shell-render.test.ts (6.086 s)
  Test Suites: 1 passed, 1 total
  Tests:       140 passed, 140 total
  ```
- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- Result: **PASS**, ExitCode `0`; no diagnostics. Raw output: empty stdout/stderr, recorded by the successful command result.
- Verification boundary: renderer tests assert responsive CSS breakpoints, focus styles, named navigation/content landmarks, and the table region label. Browser measurements/screenshots at 1440x900, 390x844, 320 CSS px, and zoom levels were not run in this receipt.

# T-CODEX-OFFLINE-ENC02-ADMUX01-INDEPENDENT

- Receipt time: `2026-09-27T22:08:33+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent offline verification only; no product source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework` unless stated otherwise. The named tests use injected/in-memory fixtures and do not require Vault, PostgreSQL, Redis, S3, or a browser session.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

### ENC-02 ??? Vault Transit provider

- Command: `pnpm --filter @du/orchestrator test tests/vault-transit-provider.test.ts`
- ExitCode: **0**; **1 passed suite, 9 passed tests, 0 failed, 0 skipped**.

### ADM-UX-01 ??? Admin shell renderer

- Command: `pnpm --filter @du/orchestrator test tests/admin-shell-render.test.ts`
- ExitCode: **0**; **1 passed suite, 140 passed tests, 0 failed, 0 skipped**.

### Combined independent confirmation

- Command: `pnpm --filter @du/orchestrator test tests/vault-transit-provider.test.ts tests/admin-shell-render.test.ts`
- ExitCode: **0**; **2 passed suites, 149 passed tests, 0 failed, 0 skipped**.
- Honest result: **ENC-02 and ADM-UX-01 are independently verified green offline (149/149 targeted tests, with TypeScript no-emit passing).** Browser visual measurements and live Vault/database infrastructure remain outside this receipt's scope.

# T-CODEX-OFFLINE-CONTRACTS-ENCRYPTION

- Receipt time: `2026-09-27T22:41:14+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no product source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-02 encryption schema test

- Command: `pnpm --filter @du/contracts test tests/encryption.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 38 passed tests, 0 failed, 0 skipped**.

### Contracts build, full test, and lint

- Command: `pnpm --filter @du/contracts build` -> **ExitCode 0** (`tsc -p tsconfig.json`).
- Command: `pnpm --filter @du/contracts test` -> **ExitCode 0**; Jest **18 passed suites, 423 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/contracts lint` -> **ExitCode 0** (`tsc --noEmit -p tsconfig.json`).

- Honest result: **contracts encryption schemas and the complete contracts package are independently verified offline: 38/38 targeted encryption tests, 18/18 full-package suites, 423/423 full-package tests, build green, and lint green.** No live service or external Vault/DB evidence is claimed.

# T-CODEX-OFFLINE-ENC06-ADM05-INDEPENDENT

- Receipt time: `2026-09-27T22:44:07+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification; no product source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`. The suites use memory/in-process fixtures and offline render/catalog paths; no live database, Redis, Vault, S3, or browser session was used.

### ENC-06 - recipient key registry

- Command: `pnpm --filter @du/orchestrator test tests/recipient-key-registry.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 8 passed tests, 0 failed, 0 skipped**.

### ADM-UX-05 - operations cockpit and shell renderer

- Command: `pnpm --filter @du/orchestrator test tests/admin-operation-cockpit.test.ts tests/admin-shell-render.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 144 passed tests, 0 failed, 0 skipped**.

### TypeScript check

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ENC-06 and ADM-UX-05 are independently verified green offline: 3/3 targeted suites and 152/152 targeted tests passed, with TypeScript no-emit passing.** Live infrastructure and browser visual acceptance remain outside this receipt's scope.

# T-CODEX-OFFLINE-DELTA88-EXPLAIN

- Receipt time: `2026-09-27T22:47:20+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification; no product source, migration, or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### Admin keyset explain / Delta 88

- Command: `pnpm --filter @du/orchestrator test tests/admin-keyset-explain.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 5 passed tests, 13 skipped, 0 failed, 18 total**.
- Offline synthetic branch: **5/5 tests passed**. The 13 live PostgreSQL planner/seed checks were explicitly skipped because `DU_LIVE_INFRA` was not `1` (no database window).
- Delta 88 evidence: the synthetic 0019 COALESCE index name and clean COALESCE order-index scan were accepted; Seq Scan and a different key index were rejected; bounded sort over the deadline index was accepted while a population-sized sort was rejected.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **Delta 88 offline synthetic explain guard is verified green (5/5 executed tests), with all live planner/seed checks explicitly skipped; no live planner acceptance is claimed.**

# T-CODEX-OFFLINE-ENC03-ADM06-INDEPENDENT

- Receipt time: `2026-09-28T00:12:08+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-03 - AES-256-GCM chunked crypto storage facade

- Command: `pnpm --filter @du/orchestrator test -- tests/crypto-storage-facade.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 10 passed tests, 0 failed, 0 skipped**.

### ADM-UX-06 - Admin config cockpit and business/profile renderers

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-config-cockpit.test.ts tests/admin-shell-render.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 148 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ENC-03 and ADM-UX-06 are independently verified green offline: 3/3 targeted suites and 158/158 targeted tests passed, with TypeScript no-emit passing.** No live service or external infrastructure evidence is claimed.

# T-CODEX-OFFLINE-ENC07-INDEPENDENT

- Receipt time: `2026-09-28T00:20:29+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-07 - delivery encryption

- Command: `pnpm --filter @du/orchestrator test -- tests/delivery-encryption.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 22 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ENC-07 delivery encryption is independently verified green offline: 22/22 targeted tests passed and TypeScript no-emit passed.** No live service or external infrastructure evidence is claimed.

# T-CODEX-OFFLINE-ENC-META-01-INDEPENDENT

- Receipt time: `2026-09-28T00:44:43+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-META-01 - control-plane metadata encryption

- Command: `pnpm --filter @du/orchestrator test -- tests/runtime-encryption-metadata.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 23 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ENC-META-01 control-plane metadata encryption is independently verified green offline: 23/23 targeted tests passed and TypeScript no-emit passed.** No live service or external infrastructure evidence is claimed.

# T-CODEX-OFFLINE-ENC-08-INDEPENDENT

- Receipt time: `2026-09-28T02:54:04+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-08 - Admin UI and API crypto configuration

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-crypto-config.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 35 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ENC-08 Admin UI and API crypto configuration is independently verified green offline: 35/35 targeted tests passed and TypeScript no-emit passed.** No live service or external infrastructure evidence is claimed.

### Final revalidation after 320px cascade refinement

- Receipt time: `2026-09-27T21:44+07:00`; source/test state at HEAD `7811298844450f373687c478d08d1edfa53ae124` plus the uncommitted ADM-UX-01 edits.
- CWD: `D:\Git\dugate\du-rework`.
- `pnpm --filter @du/orchestrator test -- tests/admin-shell-render.test.ts` ??? **PASS**, ExitCode `0`; 1 suite and 140 tests passed, 0 failed, 0 skipped. Raw-output excerpt: `PASS tests/admin-shell-render.test.ts`; `Test Suites: 1 passed, 1 total`; `Tests: 140 passed, 140 total`.
- `pnpm --filter @du/orchestrator exec tsc --noEmit` ??? **PASS**, ExitCode `0`; no diagnostics.

# ADM-UX-04

- Receipt time: `2026-09-28` (Asia/Bangkok). CWD: `D:\Git\dugate\du-rework`.
- Implemented the triage-first Overview panel with failed, timed-out, active, queue-stall, and connector-health cards; exact operation totals come from the filtered operations list, queue state comes from the health `queueIntegrity` snapshot, and unknown/stale values remain distinct from zero. Added tenant input, Today/24h/7d UTC presets, clear filters, update timestamps, and filtered operation links.
- Targeted tests: `pnpm --filter @du/orchestrator test -- tests/admin-overview-triage.test.ts tests/admin-shell-render.test.ts` ??? **PASS**, ExitCode `0`; 2 suites / 142 tests passed.
- TypeScript: `pnpm --filter @du/orchestrator exec tsc --noEmit` ??? **FAIL**, ExitCode `1`; remaining diagnostic is `src/modules/public-api/upload-encryption-gateway.ts:758` (`ClaimedUpload.originalToken` missing), outside the authorized `src/app/admin/**` and `tests/**` scope. An in-scope missing `CryptoConfigState` type export was also corrected; no other diagnostics remain.
- Connector health is explicitly shown as unavailable because the platform currently exposes no aggregate connector-health endpoint; an empty audit page is not treated as a healthy zero.
- Result: ADM-UX-04 UI/tests are implemented and targeted tests pass; acceptance remains incomplete until the unrelated package typecheck error is resolved.

- Typecheck detail correction after final rerun: the current sole diagnostic is `src/modules/public-api/upload-encryption-gateway.ts(762,9)` TS2353 (`uploadToken` is not a property of `Pick<ClaimedUpload, "tenantId" | "artifactId" | "storageKey">`). This supersedes the earlier `originalToken` wording above; the failing module remains outside the authorized task scope.

### Final revalidation

- Receipt time: `2026-09-28` (Asia/Bangkok), after the prior typecheck notes.
- `pnpm --filter @du/orchestrator test -- tests/admin-overview-triage.test.ts tests/admin-shell-render.test.ts` ??? **PASS**, ExitCode `0`; 2 suites / 142 tests passed.
- `pnpm --filter @du/orchestrator exec tsc --noEmit` ??? **PASS**, ExitCode `0`; no diagnostics. This supersedes the earlier transient typecheck failure notes above; no changes were made to `src/modules/public-api/upload-encryption-gateway.ts`.
- Final result: the ADM-UX-04 targeted suite and package typecheck both pass. Connector health remains explicitly unavailable in the UI until a real aggregate source is exposed.

# T-CODEX-OFFLINE-ADM-UX-04-INDEPENDENT

- Receipt time: `2026-09-28T03:07:06+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ADM-UX-04 overview triage and shell renderer

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-overview-triage.test.ts tests/admin-shell-render.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 142 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit diagnostic

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **ADM-UX-04 is independently verified green offline: 142/142 targeted tests passed and TypeScript no-emit passed with no diagnostics.** No live service or external infrastructure evidence is claimed.

# T-CODEX-OFFLINE-ADM-UX-03-INDEPENDENT

- Receipt time: `2026-09-28T03:14:55+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ADM-UX-03 toolbar sort wiring and offline HTTP sort suites

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-operations-sort-wiring.test.ts tests/admin-operations-sort-http-offline.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 79 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ADM-UX-03 toolbar sort wiring and offline HTTP sort behavior are independently verified green: 79/79 targeted tests passed and TypeScript no-emit passed.** No live service or external infrastructure evidence is claimed.

# ENC-05

- Receipt time: `2026-09-28T03:23:33+07:00`. HEAD at verification start: `7811298844450f373687c478d08d1edfa53ae124` plus the current uncommitted ENC-05 changes.
- CWD: `D:\Git\dugate\du-rework`.

### Public app-encrypted upload gateway

- Command: `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts tests/multipart-routes-offline.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 41 passed tests, 0 failed, 0 skipped**.
- Coverage includes small and multipart session creation, ciphertext versus plaintext bytes/hashes, manifest persistence and verification, bounded streaming/backpressure with RSS sampling, size limits, source abort/retry, Vault wrap failure, staging-to-ready ordering, replay behavior, and blocked direct S3 part grants.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- Latest result: **ExitCode 1**. The package command reports TS2367 in the out-of-scope `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts:396`; direct `node .../typescript/bin/tsc --noEmit -p services/orchestrator/tsconfig.json` reproduces the same diagnostic.
- Diagnostic: comparison of `{ failed: ... }` with the string `'migrated'` has no overlapping types. The failing file is outside ENC-05's allowed paths and was not changed.

- Honest result: **41/41 targeted offline tests pass, but ENC-05's acceptance gate remains blocked by the unrelated package typecheck failure above.** Live Vault and S3 infrastructure behavior is not claimed.

# T-CODEX-OFFLINE-ENC-08-WIRING-INDEPENDENT

- Receipt time: `2026-09-28T03:24:24+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-08 wiring route and crypto configuration shell pane

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-crypto-config-wiring.test.ts tests/admin-crypto-config.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 56 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **ENC-08 wiring route and shell pane are independently verified green offline: 56/56 targeted tests passed and TypeScript no-emit passed.** No live service or external infrastructure evidence is claimed.

# T-CODEX-OFFLINE-ENC-05-INDEPENDENT

- Receipt time: `2026-09-28T03:35:02+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-05 upload encryption gateway

- Command: `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 8 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit diagnostic

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **1**.
- Diagnostic: `src/modules/encryption/legacy-payload-migration.ts(125,30): error TS7006: Parameter 'kind' implicitly has an 'any' type.` The pnpm wrapper additionally emitted `undefined` and `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsc" not found` after this diagnostic; no source file was changed.

- Honest result: **ENC-05 upload encryption gateway is independently verified at 8/8 targeted tests passed; the requested typecheck was recorded as failing on the unrelated out-of-scope TS7006 diagnostic above.** Live Vault and S3 infrastructure behavior is not claimed.

# ENC-05

- Receipt time: `2026-09-28T03:37:00+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`; verification includes current uncommitted ENC-05 changes and the coordinator-authorized minimal migration type fixes.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-05 streaming upload encryption gateway

- Command: `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts tests/multipart-routes-offline.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 41 passed tests, 0 failed, 0 skipped**.

### TypeScript no-emit

- Command: `node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p services/orchestrator/tsconfig.json`
- ExitCode: **0**; stdout/stderr empty.
- The migration result branch now narrows string outcomes before reading failure details; the runtime-validated `covers` callback parameter is explicitly `unknown`.

- Honest result: **ENC-05 targeted offline tests and orchestrator TypeScript no-emit both pass.** No live Vault or S3 infrastructure behavior is claimed.

# T-CODEX-OFFLINE-ENC-04-SEAM-INDEPENDENT

- Receipt time: `2026-09-28T03:38:51+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-04 worker-sdk crypto storage seam

- Requested command: `pnpm --filter @du/worker-sdk test -- tests/crypto-storage-seam.test.ts`
- ExitCode: **1**; Jest reported **No tests found** because the requested path does not exist in this worktree (`packages/worker-sdk/tests/crypto-storage-seam.test.ts`).
- Equivalent available suite: `pnpm --filter @du/worker-sdk test -- tests/crypto-seam.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 14 passed tests, 0 failed, 0 skipped**.

### Worker SDK TypeScript no-emit

- Command: `pnpm --filter @du/worker-sdk exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty.

- Honest result: **The available ENC-04 worker-sdk crypto seam is independently verified green offline: 14/14 tests passed and worker-sdk TypeScript no-emit passed.** The literal requested `crypto-storage-seam.test.ts` path is absent, so no pass claim is made for that nonexistent path.

# ENC-09

- Receipt time: 2026-09-28T03:43:04+07:00. CWD: `D:\Git\dugate\du-rework`.

### Plaintext inventory, backfill, rollback, and key rotation

- Added adapter-driven, metadata-only inventory for artifact/input/task/child/HITL/control/outbox/checkpoint payload families. Reports include explicit scope coverage and unresolved counts; payload bytes and ciphertext are never included in inventory output.
- Added lock-and-CAS backfill with source size/SHA-256 checks, tenant/payload/version-bound envelope checks, authenticated decrypt readback, retry verification, retained legacy data, and a rollback pointer operation that verifies both copies before restore.
- Added immutable dual-read windows capped at 14 days and a key rotation verifier that checks target key version, unchanged DEK, authenticated tenant/object version, payload size, and digest.
- Command: `pnpm --filter @du/orchestrator test -- tests/legacy-payload-migration.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 9 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; no diagnostics.
- Direct project check: `node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p services/orchestrator/tsconfig.json`
- ExitCode: **0**; no diagnostics.

- Honest result: **ENC-09 inventory/backfill/restore/dual-read/key-rotation primitives pass the targeted offline tests and Orchestrator typecheck.** The implementation exposes scanner/store/crypto adapters; no live S3, PostgreSQL, Redis, or Vault migration was run or claimed.

# T-CODEX-OFFLINE-ENC-05-REVAL

- Receipt time: `2026-09-28T03:43:36+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only revalidation; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-05 upload encryption gateway revalidation

- Command: `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts tests/multipart-routes-offline.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 41 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit revalidation

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **ENC-05 revalidation is independently green: 41/41 targeted upload/multipart tests passed and the Orchestrator package typecheck passed after the minimal legacy-payload-migration fixes.** No live Vault or S3 infrastructure evidence is claimed.

# ENC-08-PERSISTENCE

- Receipt time: `2026-09-28T03:48:08+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`; verification includes the current uncommitted persistence changes.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### Persistent store and migration

- Added `PostgresCryptoConfigStore` implementing the ENC-08 store port with tenant-keyed reads and conflict-safe upserts. It validates allowlisted Vault refs on save and reload, rejects invalid tenant/key-version values, and skips identical updates.
- Added `migrations/0020_admin_crypto_config.sql` with a tenant primary key, delivery toggle, nullable storage key ref, pinned version check, and timestamps.
- The server composition root remains on its in-memory store; wiring the new adapter into `server.ts` is outside this dispatch's file scope.

### Targeted tests and TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator test -- tests/crypto-config-store.test.ts tests/admin-crypto-config.test.ts tests/admin-crypto-config-wiring.test.ts tests/migrations-ledger-guard.test.ts`
- ExitCode: **0**; Jest **4 passed suites, 77 passed tests, 0 failed, 0 skipped**. Offline coverage includes save/reload, identical retry, tenant isolation, ref allowlist, and migration discovery/sequence validation.
- Command: `pnpm --filter @du/orchestrator typecheck`
- ExitCode: **0** (`tsc --noEmit -p tsconfig.json`).
- Honest result: **The persistent adapter, DDL, offline tests, and typecheck pass.** The migration was not applied to a live PostgreSQL database, and production server wiring remains a follow-up.

# T-CODEX-OFFLINE-ENC-09-INDEPENDENT

- Receipt time: `2026-09-28T03:54:27+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-09 plaintext inventory, idempotent backfill, and key rotation verification

- Command: `pnpm --filter @du/orchestrator test -- tests/legacy-payload-migration.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 9 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **ENC-09 plaintext inventory, idempotent backfill migration, bounded dual-read, and key rotation verification are independently green offline: 9/9 targeted tests passed and the Orchestrator package typecheck passed.** No live S3, PostgreSQL, Redis, or Vault migration was run or claimed.

# ENC-08-WIRE

- Receipt time: `2026-09-28T03:58:01+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`; verification includes the current uncommitted composition wiring.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### Composition wiring

- `createApp` passes its PostgreSQL `Db` into `buildCryptoConfigOptions`; configured applications now use `PostgresCryptoConfigStore` for Admin settings and the delivery policy source.
- `buildCryptoConfigOptions` retains its in-memory store when invoked without a database. Wiring tests exercise the Postgres selection and no-database fallback.

### Targeted tests and TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator test -- tests/crypto-config-store.test.ts tests/admin-crypto-config.test.ts tests/admin-crypto-config-wiring.test.ts tests/migrations-ledger-guard.test.ts`
- ExitCode: **0**; Jest **4 passed suites, 79 passed tests, 0 failed, 0 skipped** (77 existing cases plus two new store-selection cases).
- Command: `pnpm --filter @du/orchestrator typecheck`
- ExitCode: **0** (`tsc --noEmit -p tsconfig.json`).
- Honest result: **ENC-08 composition wiring and its offline fallback pass targeted tests and typecheck.** A live PostgreSQL restart/reload was not exercised.

# T-CODEX-OFFLINE-ENC-08-WIRE-INDEPENDENT

- Receipt time: `2026-09-28T04:06:14+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### ENC-08 composition wiring, fallback, and ENC-07 delivery wire hook

- Command: `pnpm --filter @du/orchestrator test -- tests/crypto-config-store.test.ts tests/admin-crypto-config.test.ts tests/admin-crypto-config-wiring.test.ts tests/enc08-wire-enc07.test.ts`
- ExitCode: **0**; Jest **4 passed suites, 71 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **ENC-08 composition/fallback and ENC-07 delivery wire hook are independently green offline: 71/71 targeted tests passed and the Orchestrator package typecheck passed.** No live PostgreSQL or external service evidence is claimed.

# RESULT-WIRE-01

- Receipt time: 2026-09-28T04:07:35+07:00. CWD: `D:\Git\dugate\du-rework`.

### Frozen success response contract

- `GET /api/v1/operations/{id}/result`: HTTP 200 JSON; plain mode is the strict version-1 `ResultEnvelope` (`schemaVersion`, `data`, `artifacts`, `usage`, `warnings`). Encrypted mode is a strict version-1 `{schemaVersion, encrypted: true, delivery}` wrapper; decrypting `delivery` yields that same `ResultEnvelope`.
- `GET /api/v1/artifacts/{id}/download`: HTTP 200 raw bytes with the artifact MIME in plain mode; encrypted mode is HTTP 200 JSON `{schemaVersion, encrypted: true, delivery, artifactId, mimeType}`. `RecipientDeliveryEnvelopeSchema` is shared and strict in both encrypted variants.
- Added schemas and contract tests for both modes. The orchestrator route fixture validates these schemas and follows the decrypted result's artifact reference through download, externally decrypting and byte-comparing the actual artifact payload.

### Verification

- `pnpm --filter @du/contracts build` — ExitCode **0**.
- `pnpm --filter @du/contracts test` — ExitCode **0**; **19 suites, 427 tests passed**.
- `pnpm --filter @du/orchestrator test -- tests/delivery-encryption.test.ts` — ExitCode **0**; **1 suite, 22 tests passed**.
- `pnpm --filter @du/contracts exec tsc --noEmit -p tsconfig.json` — ExitCode **0**.
- `pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json` — ExitCode **0**.

- Scope note: `docs/06-public-api.md` still documents a 302 download; this dispatch was limited to contracts and Orchestrator tests, so that documentation mismatch remains for the docs follow-up.
- Honest result: **The current 200/raw-or-JSON route behavior is now locked and verified offline, including decryption of actual referenced artifact bytes.** No live external consumer or infrastructure run is claimed.
# LOG-01

- Receipt time: 2026-09-28T04:23:14+07:00. CWD: D:\Git\dugate\du-rework.

### Shared JSON log schema and redaction

- @du/observability now emits one JSON record per log call with ISO timestamp, level, service, version, normalized environment, and correlation/task/operation/invocation IDs. IDs that are unavailable are explicit null; context IDs take precedence over caller-supplied fields.
- Redaction now covers provider and Vault tokens, passwords and DSNs, crypto/private/public key material, bearer/JWT values, signed URLs, payloads, sensitive filenames and paths, byte arrays, cyclic structures, and exception text. safeErrorForLog uses the ADM-BASE-03 fixed safe error shape.
- Orchestrator API/admin/migration log sites use the shared logger; shell-router.ts has a minimal value-import correction needed for the package type check. The updated offline boundary test asserts JSON schema, response/log correlation, and sentinel-free errors.

### Verification

- pnpm --filter @du/observability test -- observability.test.ts — ExitCode 0, 1 suite / 23 tests passed.
- pnpm --filter @du/observability lint — ExitCode 0 (tsc --noEmit).
- pnpm --filter @du/observability build — ExitCode 0.
- pnpm --filter @du/orchestrator test -- tests/admin-error-boundary-offline.test.ts — ExitCode 0, 1 suite / 21 tests passed.
- pnpm --filter @du/orchestrator typecheck — ExitCode 0 (tsc --noEmit -p tsconfig.json).
- rg -n 'console\.(log|warn|error|info|debug)' services/orchestrator/src packages/observability/src — no matches.

- Honest result: The targeted offline suites and both package type checks pass; shared schema/redaction and the orchestrator error boundary are verified. No live deployment or external infrastructure run is claimed.

# T-CODEX-OFFLINE-RESULT-WIRE-01-INDEPENDENT

- Receipt time: `2026-09-28T04:25:52+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only revalidation; no source or test file was changed, and only this receipt was appended.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### RESULT-WIRE-01 contracts and delivery encryption

- Command: `pnpm --filter @du/contracts test -- tests/result-wire.test.ts tests/encryption.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 42 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/orchestrator test -- tests/delivery-encryption.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 22 passed tests, 0 failed, 0 skipped**.

### Package TypeScript no-emit revalidation

- Command: `pnpm --filter @du/contracts exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.
- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **RESULT-WIRE-01 contract and delivery behavior are independently green offline: 64/64 targeted tests passed and both package typechecks passed.** No live external consumer or infrastructure evidence is claimed.

# DATA-01

- Receipt time: `2026-09-28T04:32:37+07:00`. CWD: `D:\Git\dugate\du-rework`.

### S3 artifact lifecycle and version pinning

- Added a private, versioned S3-compatible fixture for upload grants, object generations, HEAD/GET, and exact-version deletes. The storage-service regression runs the S3 facade against that fixture, checks that S3 uploads reject the PostgreSQL proxy path and do not write `artifact_blobs`, then injects a late same-key PUT between HEAD and pinned GET.
- The test verifies READY metadata pins the verified earlier generation, reads stay on that generation, a finalize response lost after commit replays the same READY result without re-verifying, changed hash metadata conflicts, and an actual byte-count mismatch leaves the artifact STAGING.
- Authorization regressions run with an S3-backed service and cover parent/child reads and foreign tenant denial. S3 finalize guard tests cover wrong producer, stale epoch, expired lease, and non-running task; facade coverage includes hash verification and exact-version delete.

### Verification

- `pnpm --filter @du/orchestrator test -- tests/s3-storage-facade.test.ts tests/artifact-storage-service.test.ts tests/artifact-read-authorization.test.ts` — ExitCode **0**; **3 suites, 35 tests passed**.
- `pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json` — ExitCode **0**; no diagnostics.

- Honest result: **DATA-01 S3 lifecycle and concurrency guarantees pass the targeted offline tests and Orchestrator typecheck.** No live S3-compatible service or PostgreSQL database was used.

# T-CODEX-OFFLINE-LOG-01-INDEPENDENT

- Receipt time: `2026-09-28T04:34:48+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### LOG-01 JSON schema, redaction, and error boundary

- Command: `pnpm --filter @du/observability test -- observability.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 23 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/orchestrator test -- tests/admin-error-boundary-offline.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 21 passed tests, 0 failed, 0 skipped**.

### Package typechecks

- Command: `pnpm --filter @du/observability lint`
- ExitCode: **0**; `tsc --noEmit -p tsconfig.json`, stdout/stderr empty.
- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

### Console leakage scan

- Command: `rg -n 'console\.(log|warn|error|info|debug)' services/orchestrator/src packages/observability/src`
- ExitCode: **1** with empty output, meaning **no matches** were found.

- Honest result: **LOG-01 is independently verified green offline: 44/44 targeted tests passed, both package typechecks passed, and the console leakage scan found no matches.** No live deployment or external infrastructure evidence is claimed.

# T-CODEX-OFFLINE-DATA-01-INDEPENDENT

- Receipt time: `2026-09-28T04:43:23+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### DATA-01 S3 storage adapter and metadata lifecycle

- Command: `pnpm --filter @du/orchestrator test -- tests/s3-storage-facade.test.ts tests/artifact-storage-service.test.ts tests/artifact-read-authorization.test.ts`
- ExitCode: **0**; Jest **3 passed suites, 35 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **DATA-01 S3 storage adapter and metadata lifecycle are independently green offline: 35/35 targeted tests passed and the Orchestrator package typecheck passed.** No live S3-compatible service or PostgreSQL database was used.

# DATA-02

- Receipt time: 2026-09-28T04:45:16+07:00. CWD: D:\Git\dugate\du-rework.

### Public upload lifecycle and submit guard

- Added a composed offline journey through the public router, encrypted upload gateway, S3 test double, and real submission service. A binary fixture with invalid UTF-8 bytes receives a tenant-scoped grant, uploads over the streaming PUT route, reaches READY after verified completion replay, and is accepted by submit with its artifact reference.
- The existing targeted suites cover rejection of STAGING, foreign, and expired artifacts; embedded base64 and numeric file bytes over the configured budget; large streamed uploads with backpressure/RSS bounds; and multipart abort, TTL sweep, and cleanup.
- No /api/v1/docs/* compatibility route is present in the Orchestrator router, so that conditional compatibility surface is not claimed.

### Verification

- pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts tests/artifact-submit-guards.test.ts tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts - ExitCode 0, 4 suites / 99 tests passed.
- pnpm --filter @du/orchestrator typecheck - ExitCode 0 (tsc --noEmit -p tsconfig.json).
- pnpm --filter @du/orchestrator test -- tests/ingress-bounded.test.ts - ExitCode 0; 1 suite and 8 tests skipped because the suite requires DU_LIVE_INFRA=1 and an open DB window.

- Honest result: DATA-02 upload, completion, submit guards, streaming, and cleanup are covered by targeted offline verification, including the composed binary upload journey. The ingress live suite was gated and no live PostgreSQL, S3, Redis, or Vault infrastructure was exercised.

# T-CODEX-OFFLINE-DATA-02-INDEPENDENT

- Receipt time: `2026-09-28T04:54:34+07:00`. HEAD: `7811298844450f373687c478d08d1edfa53ae124`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.
- CWD for all commands: `D:\Git\dugate\du-rework`.

### DATA-02 public multipart/direct upload and submit guard

- Command: `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts tests/artifact-submit-guards.test.ts tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts`
- ExitCode: **0**; Jest **4 passed suites, 99 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr empty; no diagnostics reported.

- Honest result: **DATA-02 public multipart/direct upload, completion, submit guards, streaming, and cleanup are independently green offline: 99/99 targeted tests passed and the Orchestrator package typecheck passed.** No live PostgreSQL, S3, Redis, or Vault infrastructure was exercised.

# DATA-05

- Receipt time: `2026-09-28T05:00:23+07:00`. CWD: `D:\Git\dugate\du-rework`.

### PostgreSQL blob migration and rollback window

- Kept the legacy blob inventory keyed by both storage reference and tenant, and migration completion remains blocked by unresolved PostgreSQL references, orphan rows, unpinned S3 READY rows, or any failed integrity check. Backfill verifies source size/SHA-256, passes artifact/tenant/reference to S3 import, verifies the returned S3 size/SHA-256/version, pins only after validation, retains PostgreSQL bytea backups, and remains idempotent on retry.
- PostgreSQL fallback now requires `migrationWindow: true`; an unset or closed window is S3-only for reads while new artifact grants remain S3-backed. Added regressions for tenant mismatch, remote size/hash drift, inventory reconciliation, retry behavior, and fail-closed fallback.

### Verification

- `pnpm --filter @du/orchestrator test -- tests/storage-migration.test.ts` — ExitCode **0**; **1 suite, 7 tests passed**.
- `pnpm --filter @du/orchestrator test -- tests/artifact-storage-service.test.ts` — ExitCode **0**; **1 suite, 13 tests passed**.
- `pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json` — ExitCode **0**; no diagnostics.

- Honest result: **DATA-05 migration and rollback-window checks pass their targeted offline tests and the Orchestrator typecheck.** No live PostgreSQL or S3 migration, backup verification, or restore rehearsal was run.

# DATA-04

- Receipt time: `2026-09-28T05:02:17+07:00`. CWD: `D:\Git\dugate\du-rework`.

### Worker artifact streaming and output/checkpoint

- Worker SDK artifact transfers use bounded streams with size and SHA-256 validation, request-wide timeout/abort propagation, and task/lease-epoch-bound finalize calls. The document-core business facade routes reads, writes, and checkpoint outputs through these SDK paths; checkpoint artifacts remain `intermediate` and are not exposed as public results.
- Completion accepts only typed committed output references, verifies output role and integrity metadata against successful finalization, and rejects missing, STAGING, foreign, and intermediate references. Added a regression proving an intermediate reference cannot qualify as a committed output, with size/hash mismatch coverage.

### Verification

- `pnpm --filter @du/worker-sdk test` — ExitCode **0**; **18 suites, 311 tests passed**.
- `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test` — ExitCode **0**; **46 suites, 542 tests passed**. `REDIS_SMOKE=0` keeps this run offline; no live BullMQ/Redis services were verified.
- `pnpm --filter @du/worker-sdk lint` — ExitCode **0** (`tsc --noEmit -p tsconfig.json`).
- `pnpm --filter @du/document-core lint` — ExitCode **0**.
- `pnpm --filter @du/document-core test:typecheck` — ExitCode **0** (`tsc --noEmit -p tsconfig.test.json`).

- Honest result: **worker-sdk and document-core offline suites and TypeScript checks are green.** Live object storage, Redis, and distributed finalize races were not exercised against external infrastructure.

# T-CODEX-OFFLINE-DATA-04-INDEPENDENT

- Receipt time: `2026-09-28T05:09:55+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### Worker SDK artifact streaming and output/checkpoint

- Command: `pnpm --filter @du/worker-sdk test`
- ExitCode: **0**; Jest **18 passed suites, 311 passed tests, 0 failed, 0 skipped**.

- Command: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test`
- ExitCode: **0**; Jest **46 passed suites, 542 passed tests, 0 failed, 0 skipped**. `REDIS_SMOKE=0` kept the Redis smoke test offline.

### Package lint and test typecheck

- Command: `pnpm --filter @du/worker-sdk lint`
- ExitCode: **0**; package TypeScript no-emit check completed without diagnostics.
- Command: `pnpm --filter @du/document-core lint`
- ExitCode: **0**; package TypeScript no-emit check completed without diagnostics.
- Command: `pnpm --filter @du/document-core test:typecheck`
- ExitCode: **0**; test TypeScript no-emit check completed without diagnostics.

- Honest result: **DATA-04 worker artifact streaming and output/checkpoint verification is independently green offline: 18/18 worker-sdk suites (311/311 tests), 46/46 document-core suites (542/542 tests), both package lint checks, and document-core test typecheck passed.** No live object storage, Redis, or distributed finalize infrastructure was exercised.

# T-CODEX-OFFLINE-DATA-05-INDEPENDENT

- Receipt time: `2026-09-28T05:04:12+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### DATA-05 PostgreSQL blob migration and rollback window

- Command: `pnpm --filter @du/orchestrator test -- tests/storage-migration.test.ts tests/artifact-storage-service.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 20 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr contained no TypeScript diagnostics.

- Honest result: **DATA-05 PostgreSQL blob migration and rollback-window verification is independently green offline: 20/20 targeted tests passed and the Orchestrator package typecheck passed.** No live PostgreSQL or S3 migration, backup verification, or restore rehearsal was exercised.

# T-CODEX-OFFLINE-ENC-08-CSRF-INDEPENDENT

- Receipt time: `2026-09-28T05:14:01+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification of ENC-08 Admin CSRF form rendering and validation (Delta 112); this worker changed no source or test file and appended only this receipt.

### ENC-08 Admin CSRF form rendering, validation, and ENC-07 wire hook

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-crypto-config-shell.test.ts tests/admin-crypto-config.test.ts tests/admin-crypto-config-wiring.test.ts tests/enc08-wire-enc07.test.ts`
- ExitCode: **0**; Jest **4 passed suites, 79 passed tests, 0 failed, 0 skipped**.

### Orchestrator TypeScript no-emit

- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr contained no TypeScript diagnostics.

- Honest result: **ENC-08 Admin CSRF form rendering and validation, composition wiring, and ENC-07 delivery hook are independently green offline: 79/79 targeted tests passed and the Orchestrator package typecheck passed, closing Delta 112.** No live PostgreSQL, S3, Redis, or Vault infrastructure was exercised.

# COST-01

- Receipt time: `2026-09-28T05:15:59+07:00`. CWD: `D:\Git\dugate\du-rework`.

### Usage attribution event contract

- Extended the exported ledger event schema with required `idempotencyKey` and `unitType` fields alongside tenant/API-key, operation/task/invocation/attempt, business/action/version, profile/connector revisions, provider/model, and occurred/received timestamps. The unit type is constrained to `tokens`, `pages`, or `mixed` and must agree with reported quantities; event IDs remain stable dedup identities.
- Preserved immutable correction/refund semantics: initial events cannot have a parent, correction/refund events must link `correctsEventId`, and self-links are rejected. Added contract tests for required attribution dimensions, idempotency key shape, unit matching, and correction/refund links; updated reconciliation/budget fixtures for the expanded contract.

### Verification

- `pnpm --filter @du/contracts test` — ExitCode **0**; **19 suites, 428 tests passed**.
- `pnpm --filter @du/contracts exec tsc --noEmit` — ExitCode **0**; no diagnostics.

- Honest result: **COST-01 enriched contracts and package tests/typecheck pass offline.** No consumer service migration or end-to-end event ingestion was exercised.

# COST-02

- Receipt time: `2026-09-28T05:35:38+07:00`. CWD: `D:\Git\dugate\du-rework`.

### Versioned pricing rates and resolution

- Added a strict per-unit rate contract keyed by provider, model, and billing unit (`input_tokens_per_million`, `output_tokens_per_million`, `cached_input_tokens_per_million`, `page`, or `image`), with integer micro-USD, USD currency, effective window, positive price version, and lifecycle status (`draft`, `review`, `published`, `retired`). Added an exact-decimal USD authoring adapter that converts to micro-USD.
- Added version and active-window overlap validation to the per-unit pricing table and overlap rejection to the existing model tier table. `resolveRate()` selects only published rates with matching provider/model/unit and applies `[effectiveFrom, effectiveTo)` instant semantics; draft/review/retired rows are not billable candidates.
- Tests cover rate validation, USD conversion, duplicate/overlapping windows, boundary resolution, status filtering, and public package exports.

### Verification

- `pnpm --filter @du/contracts test` — ExitCode **0**; **19 suites, 432 tests passed**.
- `pnpm --filter @du/contracts exec tsc --noEmit` — ExitCode **0**; no diagnostics.

- Honest result: **COST-02 schema and rate resolution contracts pass the contracts package suite and typecheck offline.** No pricing service persistence, publish workflow, or consumer integration was exercised.

# T-CODEX-OFFLINE-COST-01-INDEPENDENT

- Receipt time: `2026-09-28T05:25:03+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### COST-01 usage attribution contract

- Command: `pnpm --filter @du/contracts test`
- ExitCode: **0**; Jest **19 passed suites, 428 passed tests, 0 failed, 0 skipped**.
- Focused contract assertions passed for required idempotency and attribution/event identity dimensions; unit-family matching for `tokens`, `pages`, and `mixed`; provider/model and business/profile/connector attribution; and correction/refund linkage rules. The tests enforce event-id dedup identity, opaque retry idempotency keys, no parent on initial events, required `correctsEventId` on corrections/refunds, and rejection of self-links, preserving immutable original rows.

### Contracts TypeScript no-emit

- Command: `pnpm --filter @du/contracts exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr contained no TypeScript diagnostics.

- Honest result: **COST-01 usage attribution contracts are independently green offline: 19/19 suites (428/428 tests) passed and the contracts package typecheck was clean.** No consumer service migration or end-to-end event ingestion was exercised.

# LOG-02

- Receipt time: `2026-09-28T05:31:34+07:00`. CWD: `D:\Git\dugate\du-rework`.

### Container/host log collector to Elasticsearch

- Added `@du/observability` JSONL collector and an Orchestrator `logs:collect` stdin runner. The collector redacts and validates LOG-01 records, writes fsynced spool segments with private permissions, bounds disk bytes, segment count, record size, in-flight writes, response size, and configured working set, then sends bulk events to the environment-specific `du-logs-{environment}` data stream over verified HTTPS using an API key. The runner emits safe retry, drop, buffer, and ingest-lag status records to stderr.
- Elasticsearch requests run in the separate collector process, with timeouts and exponential retries; stream reads pause while local spool writes apply backpressure. On recovery/restart, persisted segments replay at least once, and spool exhaustion drops new records with visible counters/alerts instead of growing memory or disk without bound.
- Added an operations note for a write-only Elasticsearch API key, external data-stream/ILM provisioning, quota-controlled private spool storage, and alerting; retention policy and a live Elasticsearch deployment remain operator-owned.

### Verification

- `pnpm --filter @du/observability test` — ExitCode **0**; **2 suites, 36 tests passed**.
- `pnpm --filter @du/observability lint` — ExitCode **0**; TypeScript no-emit clean.
- `pnpm --filter @du/observability build` — ExitCode **0**.
- `pnpm --filter @du/orchestrator test -- tests/log-collector.test.ts` — ExitCode **0**; **1 suite, 3 tests passed**.
- `pnpm --filter @du/orchestrator typecheck` — ExitCode **0**; TypeScript no-emit clean.

- Honest result: **LOG-02 collector buffering, backpressure, drop accounting, retry, and restart replay pass offline unit verification and both package typechecks/build.** No live Elasticsearch connection, TLS certificate handshake, data-stream provisioning, or ILM policy was exercised.

# T-CODEX-OFFLINE-LOG-02-INDEPENDENT

- Receipt time: `2026-09-28T05:36:26+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### LOG-02 container/host log collector to Elasticsearch

- Command: `pnpm --filter @du/observability test`
- ExitCode: **0**; Jest **2 passed suites, 36 passed tests, 0 failed, 0 skipped**.
- Collector assertions passed for bounded disk quota, segment count, record size, memory working-set validation, and drop counters; stream parsing/local writes apply backpressure; stalled Elasticsearch requests leave ingestion responsive; outage delivery is retained; retries/backoff drain after recovery; restart replays an unsealed segment; transient item errors retry while permanent mapping rejection drops are counted.

- Command: `pnpm --filter @du/observability lint`
- ExitCode: **0**; TypeScript no-emit completed without diagnostics.
- Command: `pnpm --filter @du/observability build`
- ExitCode: **0**; TypeScript build completed without diagnostics.
- Command: `pnpm --filter @du/orchestrator test -- tests/log-collector.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 3 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/orchestrator typecheck`
- ExitCode: **0**; TypeScript no-emit completed without diagnostics.

- Honest result: **LOG-02 collector buffering, backpressure, Elasticsearch-outage non-blocking behavior, retry/replay recovery, and bounded resource controls are independently green offline: 36/36 observability tests, 3/3 Orchestrator tests, observability lint/build, and Orchestrator typecheck all passed.** No live Elasticsearch connection, TLS handshake, data-stream provisioning, or ILM policy was exercised.

# T-CODEX-OFFLINE-COST-02-INDEPENDENT

- Receipt time: `2026-09-28T05:48:44+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source file and appended only this receipt.

### COST-02 versioned pricing and rate resolution contract

- Command: `pnpm --filter @du/contracts test`
- ExitCode: **0**; Jest **19 passed suites, 435 passed tests, 0 failed, 0 skipped**.
- Focused pricing assertions passed for integer micro-USD rate models and required status; the source enum exposes `draft`, `review`, `published`, and `retired`, while resolution bills only `published` rows and retired rows remain historical/non-candidate. Tests reject draft billing, enforce immutable positive `priceVersion`, match provider/model/unit, and reject duplicate or overlapping same-key windows while accepting adjacent half-open windows.
- `[effectiveFrom,effectiveTo)` instant matching passed at inclusive `from` and exclusive `to` boundaries, including timezone-equivalent instants; out-of-window and unpriced lookups return no rate. Exact USD authoring conversion passed (`2.50` -> `2,500,000` micro-USD), with precision, exponent, negative, and safe-integer overflow inputs rejected.

### Contracts TypeScript no-emit

- Command: `pnpm --filter @du/contracts exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr contained no TypeScript diagnostics.

- Honest result: **COST-02 versioned pricing, lifecycle filtering, half-open instant resolution, duplicate/overlap rejection, and exact USD-to-micro-USD conversion are independently green offline: 19/19 suites (435/435 tests) passed and the contracts package typecheck was clean.** No pricing persistence, publish workflow, or consumer service integration was exercised.

# COST-03

- Receipt time: `2026-09-28T05:50:51+07:00`. Task: `task_e9023f5a23bf`. CWD: `D:\Git\dugate\du-rework`.

### Grouped usage aggregation and reconciliation

- Added strict aggregation schemas and a deterministic contract engine in `packages/contracts/src/usage-reconciliation.ts`. The allowlisted hierarchy supports tenant, API key, business/action, profile revision, and provider/model groups; each result includes distinct operation, invocation, and attempt counts, event counts, input/output/total tokens, and integer micro-USD costs.
- Each group and overall total carries measured, estimated, pending, and unpriced breakdowns. Event IDs are deduplicated before filtering; divergent duplicate payloads fail closed. Additive event/token/cost totals are reconciled across groups, and arithmetic uses `BigInt` with safe-integer overflow rejection.
- Extended Orchestrator `getReconciliationSummary` with optional `groupBy`; the database read remains tenant-scoped. The time rule is explicit: `occurredAt` by default or selectable `receivedAt`, compared as instants over `[from,to)` and reported in UTC. Profile grouping reflects the ledger's available `profileRevision` attribution.

### Verification

- `pnpm --filter @du/contracts test` — ExitCode **0**; **19 suites / 435 tests passed**.
- `pnpm --filter @du/contracts lint` — ExitCode **0**; TypeScript no-emit clean.
- `pnpm --filter @du/contracts build` — ExitCode **0**.
- `pnpm --filter @du/orchestrator test -- tests/usage-contracts-integration-offline.test.ts` — ExitCode **0**; **1 suite / 20 tests passed**.
- `pnpm --filter @du/orchestrator typecheck` — ExitCode **0**; TypeScript no-emit clean.
- Raw output: `coordination/reports/tester-output/W-COST-03-AGGREGATION-2026-09-28.log`.

- Honest result: **COST-03 grouped schemas, aggregation engine, and tenant-scoped service wiring pass offline verification.** No live database was used; trend buckets, paginated drill-down/export, and the Usage & Cost UI are not included in this slice, and COST-03/G-ADMIN-OPS are not marked accepted.

### Latest verification correction (2026-09-28T05:58:42+07:00)

This later run supersedes the package-wide and Orchestrator integration results above for the current shared tree. The focused COST-03 gates pass: `pnpm --filter @du/contracts test -- tests/usage-reconciliation.test.ts` passed **29/29**; `pnpm --filter @du/orchestrator test -- tests/usage-aggregation.test.ts` passed **2/2**; contracts lint/build and Orchestrator typecheck all exited 0.

The current full contracts run exits 1 because `usage-budget.test.ts` has COST-04 TypeScript fixture errors (`owner`, and missing `status`/`alertThresholdPercent`). The existing `usage-contracts-integration-offline.test.ts` likewise fails compilation in its COST-04 budget assertions (`tokenLimit` and `BLOCK_NEW_INVOCATIONS`); no tests from that suite execute. These are outside this COST-03 implementation. Raw rerun output is in `coordination/reports/tester-output/W-COST-03-AGGREGATION-2026-09-28.log`; no live database was used, and this is not an acceptance/release verdict.

# T-CODEX-OFFLINE-COST-03-INDEPENDENT

- Receipt time: `2026-09-28T05:54:32+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### Contracts aggregation/reconciliation package checks

- Command: `pnpm --filter @du/contracts test`
- ExitCode: **0**; Jest **19 passed suites, 435 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/contracts lint`
- ExitCode: **0**; TypeScript no-emit completed without diagnostics.
- Command: `pnpm --filter @du/contracts build`
- ExitCode: **0**; TypeScript build completed without diagnostics.

### Orchestrator usage-contract integration and typecheck

- Command: `pnpm --filter @du/orchestrator test -- tests/usage-contracts-integration-offline.test.ts`
- ExitCode: **1**; Jest **1 failed suite, 0 tests executed** because ts-jest reported TS2353 at line 226 (`tokenLimit` is not in the current budget type) and TS2820 at lines 236 and 241 (`BLOCK_NEW_INVOCATIONS` is not the current kebab-case policy literal).
- Command: `pnpm --filter @du/orchestrator typecheck`
- ExitCode: **1** at the pnpm wrapper (underlying `tsc` reported Exit status **2**); diagnostics are `services/orchestrator/src/modules/webhooks/webhooks.ts:441` unresolved `signature`, `:442` unresolved `timestamp`, and `:445` missing shorthand `body`.

- Honest result: **COST-03 contracts aggregation/reconciliation package checks pass offline, but the requested Orchestrator integration suite and typecheck are not green in this checkout due pre-existing/staged source-test drift; no source or test file was modified by this worker.** The integration suite did not execute any tests, and no live database was used.
- Honest result: **COST-02 schema and rate resolution contracts pass the contracts package suite and typecheck offline.** No pricing service persistence, publish workflow, or consumer integration was exercised.

# COST-04

- Receipt time: `2026-09-28T06:04:37+07:00`. CWD: `D:\Git\dugate\du-rework`.

### Budget configuration and evaluation validation

- Updated the exported `BudgetConfigSchema` to COST-04 fields: tenant with optional API key/profile/business scopes, lowercase daily/monthly period, positive token and micro-USD thresholds, alert percent, opaque notification channel IDs, lowercase policy, and active/suspended status. Suspended budgets preserve measured threshold flags while returning `ALLOW`.
- Added the Orchestrator `validateBudgetEvaluation()` boundary and wired it into the usage summary path. It validates config, usage and reservation schemas, requires the config tenant to match the requested tenant, and returns a validated evaluation. Because the current summary query is tenant-wide, API-key/profile/business-scoped configs fail closed with `BUDGET_SCOPE_UNSUPPORTED` rather than being evaluated against broader totals.
- Expanded contract tests for field shapes, optional scopes, identifier/channel safety, thresholds, policy/status behavior, and evaluation limits; added Orchestrator validator and usage-summary integration tests.

### Verification

- `pnpm --filter @du/contracts test` — ExitCode **0**; **19 suites, 435 tests passed**.
- `pnpm --filter @du/orchestrator test -- tests/budget-evaluation-validator.test.ts tests/usage-contracts-integration-offline.test.ts` — ExitCode **0**; **2 suites, 23 tests passed**.
- `pnpm --filter @du/contracts exec tsc --noEmit` — ExitCode **0**; no diagnostics.
- `pnpm --filter @du/orchestrator exec tsc --noEmit` — ExitCode **0**; no diagnostics.

- Honest result: **COST-04 contracts and tenant-wide evaluation validation pass offline tests and both package typechecks.** Scoped usage aggregation, persistence, alert delivery, and reservation lifecycle are not implemented or claimed here.

# ADM-UX-02-SORT

- Receipt time: `2026-09-28T06:35:16+07:00`. Task: `task_1301d86da5ec`; dispatch context: `ctx_7546627ac088`. CWD: `D:\Git\dugate\du-rework`.
- Added the closed `createdAt:asc|desc` / `updatedAt:asc|desc` sort contract for business, business-version, and API-key list routes. All three routes now use bounded, bidirectional keyset pages with a five-field envelope, stable secondary ordering, exact-microsecond sort-bound cursors, and filtered totals; API-key page and count queries remain SQL tenant-scoped.
- Added migration `services/orchestrator/migrations/0021_admin_list_sort_timestamps.sql` to backfill `updated_at`, add sort indexes, and provide update timestamps for business version status/activation changes. New business/version payloads preserve `rows` compatibility while publishing `items` and page metadata.

### Focused verification

- `pnpm --filter @du/orchestrator test -- tests/admin-sort-allowlist.test.ts tests/admin-list-contract-conformance.test.ts` — ExitCode **0**; **2 suites / 30 tests passed**.
- `pnpm --filter @du/contracts test -- tests/admin-resource-list-contract.test.ts` — ExitCode **0**; **1 suite / 3 tests passed**.
- `pnpm --filter @du/orchestrator typecheck` (`tsc --noEmit -p tsconfig.json`) — ExitCode **0**.
- `pnpm --filter @du/contracts build` and `pnpm --filter @du/contracts lint` — ExitCode **0**.
- Raw focused output: `coordination/reports/tester-output/W-ADM-UX-02-SORT-2026-09-28.log`.

### Requested broad test run

- `pnpm test` — ExitCode **1**. Recursive execution stopped in `packages/egress`: **2 suites failed, 1 passed; 2 tests failed, 32 passed**. Failures were a local socket `ETIMEDOUT 127.0.0.1:58721` and a redirect test receiving generic `Error` instead of `DestinationDeniedError`; this run did not reach Orchestrator.
- Separate `pnpm --filter @du/orchestrator test` — ExitCode **1**; **92 suites passed, 3 failed, 16 skipped; 2,015 tests passed, 3 failed, 216 skipped**. The three failures were shell-session security-log capture, an operations table aria-label expectation, and a safe-error log-capture expectation; the new sort suite passed.
- Offline only. Migration 0021 was not applied against a live PostgreSQL instance, and no live query plan, browser sorting control, independent review, or acceptance gate is claimed. ADM-UX-02 and `G-ADMIN-OPS` remain open.

# T-CODEX-OFFLINE-COST-04-INDEPENDENT

- Receipt time: `2026-09-28T08:17:23+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### Budget configuration contract and evaluation validation

- Command: `pnpm --filter @du/contracts test`
- ExitCode: **0**; Jest **20 passed suites, 438 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/contracts exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr contained no TypeScript diagnostics.
- Command: `pnpm --filter @du/orchestrator test -- tests/budget-evaluation-validator.test.ts tests/usage-contracts-integration-offline.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 23 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/orchestrator exec tsc --noEmit`
- ExitCode: **0**; stdout/stderr contained no TypeScript diagnostics.

- Honest result: **COST-04 budget configuration and tenant-wide evaluation validation are independently green offline: contracts 20/20 suites (438/438 tests), Orchestrator 2/2 suites (23/23 tests), and both package typechecks passed.** No live database, scoped aggregation, persistence, alert delivery, or reservation lifecycle was exercised.

# T-CODEX-OFFLINE-ADM-UX-02-SORT-INDEPENDENT

- Receipt time: `2026-09-28T08:24:08+07:00`. CWD for all commands: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source, migration, or test file and appended only this receipt.

### ADM-UX-02 sort allowlist and migration 0021

- Command: `pnpm --filter @du/orchestrator test -- tests/admin-sort-allowlist.test.ts tests/admin-list-contract-conformance.test.ts`
- ExitCode: **0**; Jest **2 passed suites, 30 passed tests, 0 failed, 0 skipped**.
- Command: `pnpm --filter @du/contracts test -- tests/admin-resource-list-contract.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 3 passed tests, 0 failed, 0 skipped**. Assertions cover the closed sort allowlist on all three list shapes, rejection of alternate fields/spellings, and exact-microsecond cursor sort binding.
- Read-only migration inspection: `services/orchestrator/migrations/0021_admin_list_sort_timestamps.sql` adds/backfills `updated_at` on `business_versions` and `api_keys`, enforces defaults/non-null, and defines created/updated keyset indexes with the expected tenant/business/version/id tie-breakers. No live migration was applied.

### TypeScript/build checks

- Command: `pnpm --filter @du/orchestrator typecheck`
- ExitCode: **1** at the pnpm wrapper (underlying `tsc` reported Exit status **2**); `services/orchestrator/src/modules/usage/usage.ts` reports five missing `@du/contracts` exports: `UsageEventDrilldownCursorSchema`, `UsageEventDrilldownQuerySchema`, `UsageEventExportPageSchema`, `UsageEventDrilldownQueryInput`, and `UsageEventExportPage`.
- Command: `pnpm --filter @du/contracts build`
- ExitCode: **1** at the pnpm wrapper (underlying `tsc` reported Exit status **2**); `packages/contracts/src/usage-reconciliation.ts` reports missing `NonNegativeIntSchema` at line 121 and two `{}`/`null` to `string` argument errors at line 133.
- Command: `pnpm --filter @du/contracts lint`
- ExitCode: **1** at the pnpm wrapper (underlying `tsc` reported Exit status **2**); it reproduces the same three `usage-reconciliation.ts` diagnostics as build.

- Additional requested command: `pnpm --filter @du/orchestrator typecheck` was run as above; no source/test/migration fixes were attempted. The contracts package `pnpm --filter @du/contracts build`/`lint` failures leave the overall independent verification not green in this checkout.
- Honest result: **ADM-UX-02 targeted sort suites pass (33/33 tests) and migration 0021 content matches the intended keyset timestamp/index shape, but Orchestrator typecheck and contracts build/lint are blocked by existing source/export diagnostics; no live database migration or query plan was exercised.**

# T-CODEX-OFFLINE-ENC-08-WEBHOOK-INDEPENDENT

- Receipt time: `2026-09-28T08:29:13+07:00`. CWD: `D:\Git\dugate\du-rework`. Independent read-only verification; this worker changed no source or test file and appended only this receipt.

### ENC-08 webhook delivery encryption

- Command: `pnpm --filter @du/orchestrator test -- tests/webhook-delivery-encryption.test.ts`
- ExitCode: **0**; Jest **1 passed suite, 5 passed tests, 0 failed, 0 skipped**.
- Focused assertions passed for tenant policy ON producing a decryptable ENC-08 envelope, HMAC signing the encrypted body (not plaintext), policy OFF preserving the pre-ENC-07 payload, unreadable policy failing closed with no POST, and independent per-tenant decisions during one dispatch sweep.

- Honest result: **ENC-08 webhook delivery encryption and tenant fail-closed policy are independently green offline: 5/5 tests passed.** No live webhook recipient, key registry, database, or external delivery endpoint was exercised.

# COST-03-DRILLDOWN

- Receipt time: `2026-09-28T08:48:45+07:00`. Task: `task_24cca6ec64e6`; dispatch context: `ctx_380da801808a`. CWD: `D:\Git\dugate\du-rework`; Node `v22.16.0`; pnpm `10.18.3`.
- Added strict contracts for bounded usage-event drill-down queries, tenant/filter-bound keyset cursors, allowlisted export records, and paged export responses. Added `GET /api/v1/usage/events`, which chooses tenant scope from the admin/API-key principal, validates dimension filters, audits each successful export page, and calls a SQL keyset query that fetches at most `limit + 1` rows; ordering is `(occurredAt|receivedAt, event_id)` and tenant predicates are present in SQL. Invalid/non-ledger payloads are counted and skipped without returning raw payload content.

### Focused verification

- `pnpm --filter @du/contracts build` — ExitCode **0**.
- `pnpm --filter @du/contracts test -- tests/usage-event-export.test.ts tests/grant-encryption-envelope.test.ts` — ExitCode **0**; **2 suites / 18 tests passed**.
- `pnpm --filter @du/orchestrator test -- tests/usage-drilldown.test.ts tests/usage-aggregation.test.ts` — ExitCode **0**; **2 suites / 12 tests passed**.
- `pnpm --filter @du/contracts lint` (`tsc --noEmit -p tsconfig.json`) — ExitCode **0**.
- `pnpm --filter @du/orchestrator typecheck` (`tsc --noEmit -p tsconfig.json`) — ExitCode **0**.
- Focused raw output: `coordination/reports/tester-output/W-COST-03-DRILLDOWN-focused-final-2026-09-28.log`.

### Requested broad test runs

- Root `pnpm test` — ExitCode **1**. Contracts completed **21 suites / 443 tests passed**; recursive execution stopped in `packages/egress` with **2 failures / 32 passes** because redirect-boundary tests received generic `Error` rather than `DestinationDeniedError`. Raw output: `coordination/reports/tester-output/W-COST-03-DRILLDOWN-2026-09-28.log`.
- `pnpm --filter @du/orchestrator test` — ExitCode **1**; **93 suites passed, 3 failed, 16 skipped; 2,023 tests passed, 3 failed, 216 skipped**. Failures were pre-existing Admin shell security-log capture, operations-table reflow markup, and safe-error log capture expectations; full output: `coordination/reports/tester-output/W-COST-03-DRILLDOWN-orchestrator-full-2026-09-28.log`.

- Honest result: **the drill-down/export contract, route, and service are implemented and focused tests plus both package typechecks pass offline.** Root-wide and full Orchestrator test commands are not green for the unrelated failures above; no live PostgreSQL, browser export flow, independent review, or acceptance gate is claimed, and COST-03 / `G-ADMIN-OPS` remain open.

# T-CODEX-OFFLINE-INGEST-WIRE-01-INDEPENDENT

- Receipt time: `2026-09-28T08:37:35+07:00`. Task: `task_f9f87a483280`; dispatch context: `ctx_16dc7dd0041e`. CWD for all commands: `D:\Git\dugate\du-rework`. Read-only verification; this worker changed no product source, migration, or test file and appended only this receipt.

### Document-core test and typecheck

- Command: `pnpm --filter @du/document-core test`
- ExitCode: **1**. Jest reported **37 failed suites, 9 passed suites, 46 total; 133 passed tests, 0 failed tests reported** (many failed suites did not execute their tests). All observed suite failures shared the same parse error from the existing dependency build artifact `packages/contracts/dist/encryption.js:258`: `SyntaxError: Unexpected token ';'` while importing contracts encryption through document-core. The requested full package suite is therefore not green in this checkout, and no runtime INGEST-WIRE-01 suite result is claimed from this blocked run.

- Command: `pnpm --filter @du/document-core exec tsc --noEmit`
- ExitCode: **0**; no TypeScript diagnostics were emitted.

### INGEST-WIRE-01 artifact-reference inspection

- Static inspection of `businesses/document-core/src/actions/ingest/index.ts` confirms `prepareSources` reads each requested artifact through `ParserBudgetHelper.readArtifact`, retains only the artifact IDs actually read, and uses the first read ID for both provider branches. The OCR branch invokes slot `ocr` with `artifacts: [{ artifactId: sourceArtifactId }]`; the digitize branch invokes slot `vision` with `task: 'digitize_handwriting'` plus the same artifact-reference shape. Both branches fail with `INGESTION_SOURCE_UNRESOLVED` before connector invocation when no read artifact exists.
- `businesses/document-core/src/pipelines/parser-budget.ts` confirms the artifact acquisition path uses authorized descriptors/stream options and rechecks size and digest (including `expectedSha256`/`expectedSizeBytes` and `ARTIFACT_INTEGRITY_MISMATCH` on mismatch) before returning source bytes. This is the authorization boundary feeding the provider reference.
- `businesses/document-core/tests/ingest-wire.test.ts` contains six focused assertions: OCR sends the exact artifact ID and `expect(payload.hasBuffer).toBeUndefined()`, the ID resolves to the expected PNG bytes/digest, missing OCR input fails without a connector call, digitize sends `task: 'digitize_handwriting'` plus the artifact ID, missing digitize input fails closed, and foreign artifact IDs are not transmitted. These assertions could not execute during the requested full run because of the contracts `dist/encryption.js` parse blocker.

- Honest result: **No source/test changes were made.** Typecheck is independently green (ExitCode 0), and static wiring confirms authorized artifact references reach OCR and digitize without `hasBuffer`; however, the required full test command is blocked (ExitCode 1) by the pre-existing contracts distribution parse artifact, so runtime acceptance remains unresolved until that artifact is repaired/rebuilt.
