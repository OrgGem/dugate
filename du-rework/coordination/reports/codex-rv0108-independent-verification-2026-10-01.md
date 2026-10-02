# RV01-08 Independent Verification Receipt — 2026-10-01

## Goal 1 — metadata adapter and cancellation propagation

### A. Targeted test

- Command: `npx jest tests/r1-e-sdk-metadata-adapter.test.ts --runInBand`
- CWD: `D:\Git\dugate\du-rework\businesses\document-core`
- Exit code: **0**
- Result: **1 suite passed; 1 test passed; 0 failed; 0 skipped.**
- Raw output:

  > PASS tests/r1-e-sdk-metadata-adapter.test.ts
  >   document-core SDK artifact metadata adapter
  >     √ converts read-grant metadata to byte-derived canonical identity before parsing (700 ms)
  >
  > Test Suites: 1 passed, 1 total
  > Tests:       1 passed, 1 total
  > Snapshots:   0 total
  > Time:        3.292 s
  > Ran all test suites matching /tests\\r1-e-sdk-metadata-adapter.test.ts/i.

### B. Test diff

- Command: `git diff -- du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts`
- CWD: `D:\Git\dugate`
- Exit code: **0**
- The diff is assertion-only: it changes the expectation from `readWithMetadata(artifactId)` to requiring an options object whose signal is an `AbortSignal`; no setup, implementation, or other assertion changed.
- Raw diff output (excluding Git’s line-ending advisory):

  > diff --git a/du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts b/du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts
  > index 2c20778..7401ca5 100644
  > --- a/du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts
  > +++ b/du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts
  > @@ -68,7 +68,10 @@ describe('document-core SDK artifact metadata adapter', () => {
  >     const result = await documentCoreHandlers.ingest!(sdkContext);
  >
  >     expect(result.kind).toBe('completed');
  > -    expect(readWithMetadata).toHaveBeenCalledWith(artifactId);
  > +    expect(readWithMetadata).toHaveBeenCalledWith(
  > +      artifactId,
  > +      expect.objectContaining({ signal: expect.any(AbortSignal) }),
  > +    );
  >     expect(parserSpy).toHaveBeenCalledWith(bytes, filename, metadata.mimeType, expect.objectContaining({
  >       timeoutMs: expect.any(Number),
  >     }));

### C. Production status

- Command: `git status --porcelain -- du-rework/businesses/document-core/src/worker.ts`
- CWD: `D:\Git\dugate`
- Exit code: **0**
- Raw output: **empty** (production file is untouched).

### D. AbortSignal forwarding verdict

**PASS — cancellation propagation is intact.** In `businesses/document-core/src/worker.ts:176-180`, the adapter accepts `options`, calls `assertActive(ctx)`, and invokes `artifactFacade.readWithMetadata(id, options)` without dropping or reconstructing the options. The test fixture supplies `signal: new AbortController().signal` (`tests/r1-e-sdk-metadata-adapter.test.ts:48-54`) and the passing assertion requires that signal to arrive as an `AbortSignal` (`tests/r1-e-sdk-metadata-adapter.test.ts:68-74`).

## Goal 2 — document-core whole-suite count

- Requested command: `pnpm --filter @du/document-core test`
- Intended CWD: `D:\Git\dugate\du-rework`
- Execution: **NOT RUN**; exit code **N/A**; passed/failed/skipped counts **N/A**. The previously recorded 790 passed / 1 failed / 791 total remains historical and was not independently revalidated here.
- Blocker: the package test script invokes Jest in-band (`businesses/document-core/package.json:13`), and the default Jest config matches `**/*.test.ts` while excluding only `.integration.test.ts` (`businesses/document-core/jest.config.cjs:6-11`). Therefore the default suite includes `tests/p8-03-provider-convergence.test.ts`; its “live usage_events projection query” test constructs `PgSqlClient` using `DATABASE_URL` or the localhost:5433 default, then performs SQL inserts and a query (`businesses/document-core/tests/p8-03-provider-convergence.test.ts:328-373`). Running the package suite would contact the shared PostgreSQL instance, which this task forbids. I stopped without running it or touching PostgreSQL. Setting `REDIS_SMOKE=0` would suppress the separate Redis smoke test, but would not exclude this PostgreSQL test.

## Scope confirmation

Only this receipt was written. No source/test files, gates, or commits were changed; no shared PostgreSQL or Redis instance was contacted.
