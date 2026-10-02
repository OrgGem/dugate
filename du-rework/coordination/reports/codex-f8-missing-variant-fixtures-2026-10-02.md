# F8 — Missing document-core variant fixtures

Date: 2026-10-02

## Added fixture cases

Added test-only fixture and expected corpus entries for the three existing traceability/recipe variants; the traceability matrix and its 31 entries were not edited.

| Case | Input shape | Mock provider output |
|---|---|---|
| `DOC-02-06` — `extract:id-card` | `{ type: 'id-card', text: 'Vietnamese identity card for Nguyen Minh Anh, document ID VN-2048-0007.' }` | `identityNumber`, `fullName`, `dateOfBirth`, and `nationality`; satisfies the id-card identifier/name output contract. |
| `DOC-03-06` — `analyze:fact-check` | `{ task: 'fact-check', text: 'The report states that Northwind revenue grew by 12% in 2025.', referenceData: { source: 'Annual report', revenueGrowth2025: '12%' } }` | `{ verdict: 'PASS', summary, checks: [{ claim, status: 'PASS', reference }] }`; deterministic reasoning mock is used for both fact-check connector steps. |
| `DOC-03-07` — `analyze:summarize-eval` | `{ task: 'summarize-eval', text: 'The proposal prioritizes accessible transit, phased investment, and measurable service targets.' }` | `{ summary, evaluation: { overallAssessment, authorPerspective } }`. |

The corpus entries contain the matching synthetic inputs and expected `COMPLETED` envelopes, including provider provenance and empty warnings. `setupFixtureMocks` adds the reasoning responses required by the corpus regression consumer.

## Verification

Targeted suites, run from `businesses/document-core`:

```text
npx jest --runInBand --runTestsByPath tests/all-variants-e2e.test.ts tests/corpus-regression.test.ts
Test Suites: 2 passed, 2 total
Tests:       64 passed, 64 total
Exit code: 0
```

Full suite, run from `businesses/document-core`:

```text
npx jest --runInBand
Test Suites: 1 failed, 55 passed, 56 total
Tests:       1 failed, 905 passed, 906 total
Exit code: 1
```

The only remaining failure is the pre-existing Redis smoke test at `tests/bullmq-smoke.test.ts:298` (`recorded.claims.some((c) => c.taskId === taskId)` expected `true`, received `false`). The three F8 fixture/corpus failures are gone.

Typecheck, run from `businesses/document-core`:

```text
npx tsc --noEmit
Exit code: 0
```

No database, Redis, S3, or provider service was used by the fixture tests. No source files, traceability entries, variant counts, or release gates were changed.

## Files changed

- `businesses/document-core/tests/all-variants-e2e.test.ts`
- `businesses/document-core/tests/fixtures/expected-result-corpus.ts`
- `businesses/document-core/tests/corpus-regression.test.ts`
