# Document-core missing variants (COMP-04b)

Date: 2026-10-01

## Implemented

- Added `extract:id-card` to the extract discriminator, recipe registry, and 31-entry traceability matrix. The action prompts for canonical identity-document fields and validates that provider output includes an identity number or a full name.
- Added `analyze:fact-check` to the analyze discriminator, recipe registry, and traceability matrix. Input validation requires non-empty `referenceData`; execution makes two checkpointed reasoning calls, first to extract document claims and then to compare those claims only against the supplied reference data. The output validator checks the verdict, summary, and per-check statuses.
- Added `analyze:summarize-eval` to the analyze discriminator, recipe registry, and traceability matrix. Execution requests both a concise summary and an author-perspective evaluation; validation requires both parts.
- The original 28 traceability entries and recipes were retained. The manifest still declares the same six action objects; the two existing action schemas were extended with the new discriminator values and the optional `extractFields` input.
- No public route or route mapping was added; COMP-00 remains a prerequisite for that work.

## Verification

- `npx jest --runInBand --runTestsByPath tests/missing-variants.test.ts` — exit 0; **Tests: 4 passed, 4 total**.
- `npx tsc --noEmit` from `du-rework/businesses/document-core` — exit 0.
- The focused tests assert 31 recipes and traceability entries, action counts `ingest: 4, extract: 6, analyze: 7, transform: 5, generate: 6, compare: 3`, and exercise all three new validation/execution paths offline.

## Not run

- Full document-core Jest suite was not run. Existing manifest and traceability tests still contain 28-variant count assertions and were left untouched because this packet permits only new test files; their full-suite status is therefore unverified.
- COMP-04 golden/business compatibility tests and provider-backed tests were not run; they are separate verification work.
- Route integration and public request mapping were not run or implemented, per the COMP-00 boundary.

## Follow-up: count assertions

Date: 2026-10-01

### Existing test files edited (count-only)

- `tests/manifest.test.ts`: total recipes `28 -> 31`; extract `5 -> 6`; analyze `5 -> 7`.
- `tests/traceability.test.ts`: total variants and unique case IDs `28 -> 31`; extract `5 -> 6`; analyze `5 -> 7`.
- `tests/all-variants-e2e.test.ts`: matrix count `28 -> 31`.
- `tests/corpus-regression.test.ts`: corpus count `28 -> 31`.
- `tests/extract.test.ts`: describe count `5 -> 6`.
- `tests/analyze.test.ts`: describe count `5 -> 7`.
- `tests/six-action-fail-closed-matrix.functional.test.ts`: extract label `5 -> 6`; analyze label `5 -> 7`.

No assertions were removed or weakened, and no fixtures or production code were changed for this follow-up.

### Verification

- `npx jest --runInBand` from `du-rework/businesses/document-core` — exit 1; `Test Suites: 3 failed, 49 passed, 52 total`; `Tests: 4 failed, 810 passed, 814 total`.
- `npx tsc --noEmit` from `du-rework/businesses/document-core` — exit 0.
- The count assertions in the manifest and traceability suites passed. The full suite remains red on the non-count failures below.

### Remaining failures (Jest output verbatim)

```text
FAIL tests/bullmq-smoke.test.ts (15.555 s)
  ● Document Core — BullMQ & Redis Smoke Suite › proves queue consumption, claim, step execution, completion and drain against Redis 6380

    expect(received).toBe(expected) // Object.is equality

    Expected: true
    Received: false

      296 |       // Assertions proving the complete lifecycle:
      297 |       // 1. Queue consumption led to claim
    > 298 |       expect(recorded.claims.some((c) => c.taskId === taskId)).toBe(true);
          |                                                                ^
      299 |
      300 |       // 2. Step checkpoints saved to runtime
      301 |       expect(recorded.savedSteps.length).toBeGreaterThanOrEqual(2);

      at Object.<anonymous> (tests/bullmq-smoke.test.ts:298:64)

FAIL tests/corpus-regression.test.ts
  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'action')

      246 |     const corpusEntry = getCorpusEntry(caseId)!;
      247 |
    > 248 |     test(`${caseId} (${corpusEntry.action}/${corpusEntry.variant}): matches expected corpus envelope and respects execution mode`, async () => {
          |                                    ^
      249 |       expect(corpusEntry).toBeDefined();
      250 |
      251 |       const ctx = new MockTaskContext();

      at tests/corpus-regression.test.ts:248:36
      at Object.<anonymous> (tests/corpus-regression.test.ts:34:1)

FAIL tests/all-variants-e2e.test.ts
  ● Deterministic 31-Variant Full-Business Local E2E Matrix (WORKLOAD-REBALANCE-04, P5-06) › DOC-02-06 (extract/id-card): executes E2E and validates output artifact

    Unhandled variant case in test fixture: DOC-02-06

      375 |
      376 |       default:
    > 377 |         throw new Error(`Unhandled variant case in test fixture: ${entry.brdCaseId}`);
          |               ^
      378 |     }
      379 |   }
      380 |

      at getVariantFixture (tests/all-variants-e2e.test.ts:377:15)
      at Object.<anonymous> (tests/all-variants-e2e.test.ts:385:23)

  ● Deterministic 31-Variant Full-Business Local E2E Matrix (WORKLOAD-REBALANCE-04, P5-06) › DOC-03-06 (analyze/fact-check): executes E2E and validates output artifact

    Unhandled variant case in test fixture: DOC-03-06

      375 |
      376 |       default:
    > 377 |         throw new Error(`Unhandled variant case in test fixture: ${entry.brdCaseId}`);
          |               ^
      378 |     }
      379 |   }
      380 |

      at getVariantFixture (tests/all-variants-e2e.test.ts:377:15)
      at Object.<anonymous> (tests/all-variants-e2e.test.ts:385:23)

  ● Deterministic 31-Variant Full-Business Local E2E Matrix (WORKLOAD-REBALANCE-04, P5-06) › DOC-03-07 (analyze/summarize-eval): executes E2E and validates output artifact

    Unhandled variant case in test fixture: DOC-03-07

      375 |
      376 |       default:
    > 377 |         throw new Error(`Unhandled variant case in test fixture: ${entry.brdCaseId}`);
          |               ^
      378 |     }
      379 |   }
      380 |

      at getVariantFixture (tests/all-variants-e2e.test.ts:377:15)
      at Object.<anonymous> (tests/all-variants-e2e.test.ts:385:23)

Test Suites: 3 failed, 49 passed, 52 total
Tests:       4 failed, 810 passed, 814 total
Snapshots:   0 total
```

The remaining failures are not count mismatches: the E2E test has no fixtures for the new traceability IDs, the corpus test has no corresponding corpus entries, and the BullMQ smoke test did not observe a queue claim. I stopped without addressing these because this packet permits count-only edits and explicitly requires stopping on failures unrelated to counts.
