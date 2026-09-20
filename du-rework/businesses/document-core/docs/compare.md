# Business Requirements Document (BRD) — Action: Compare

- **Action Name**: `compare`
- **Business**: `document-core`
- **Specification Version**: 1.0.0
- **Test Catalog Suite**: `DOC-06`
- **Subcases / Variants**: 3 (`diff`, `semantic`, `version`)

---

## 1. Overview & Business Intent
The `compare` action analyzes differences between two distinct document versions (`source` and `target`). It operates across three analytical tiers: lexical character/line-level comparison (`diff`), legal/contextual semantic variance analysis (`semantic`), and executive changelog synthesis (`version`).

---

## 2. Actors & Triggers
- **API Client**: POST to `/api/v1/docs/compare` with dual-sided inputs (`source` and `target`) and `mode` discriminator.
- **Contract & Regulatory Reviewers**: Identifying hidden clause changes between contract drafts or policy versions.

---

## 3. Preconditions & Input Constraints
1. **Dual-Sided Source/Target Structure**:
   - Both `source` and `target` scopes are mandatory.
   - Each scope must specify either an `artifactId` or raw `text`.
   - Ambiguous or single-sided requests are rejected immediately.
2. **Discriminator**: `mode` parameter is mandatory and must be one of `['diff', 'semantic', 'version']`.
3. **Focus Filter**: Optional `focus` parameter allows targeted comparison of specific clauses (e.g. `"indemnification"`, `"pricing"`).
4. **No Assumption of Equivalence**: Outputs with identical semantic meaning are not assumed to be byte-equal.

---

## 4. Variant Inventory (3 Variants)

### 4.1. `mode: diff` (Exact Lexical & Textual Diff)
- **Connector Slot**: None (Pure local execution via `document-kit`).
- **Function**: Performs Myers/patience diff calculation across lines or words between source and target text.
- **Output**: `DiffResult`: additionsCount, deletionsCount, unmodifiedCount, hunks array (type: `ADD`, `DELETE`, `EQUAL`, content, line numbers).

### 4.2. `mode: semantic` (Semantic & Meaning Variance Analysis)
- **Connector Slot**: `reasoning`
- **Function**: Compares meaning, legal implications, and obligations between source and target, ignoring inconsequential whitespace, font, or rephrasing differences. Focuses on substantive changes.
- **Output**: `SemanticComparisonResult`: semanticChanges array (clauseTitle, sourceExcerpt, targetExcerpt, changeType: `ADDED`/`MODIFIED`/`DELETED`, legalSignificance: `NEGLIGIBLE`/`MODERATE`/`HIGH`, commentary), overallSummary.

### 4.3. `mode: version` (Version Changelog Synthesis)
- **Connector Slot**: `reasoning`
- **Function**: Synthesizes human-readable release notes or legal revision summary detailing what was added, modified, or repealed between two policy or document versions.
- **Output**: `VersionChangelogResult`: versionTitle, summaryOfChanges, additions[], modifications[], deletions[].

---

## 5. Execution Flows

### 5.1. Happy Path Flow
1. **Validate Input**: Validates presence of `mode`, validates that both `source` and `target` objects are present and contain valid references or text.
2. **Select Recipe**:
   - `diff`: Selects pure local diff calculation recipe from `document-kit`.
   - `semantic` / `version`: Selects LLM reasoning recipe with side-by-side prompt template.
3. **Prepare Sources**: Loads and normalizes text for both `source` and `target` using `document-kit` parsers.
4. **Execute Recipe**:
   - For `diff`: Calculates deterministic diff locally, produces line hunks, checkpoints full result.
   - For `semantic` / `version`: Constructs dual-context prompt, invokes Connector slot `reasoning`, validates result schema.
5. **Format Result**: Builds `ComparisonEnvelope`, records durable checkpoint (>500 chars), and registers output artifact.

### 5.2. Error & Alternative Flows
- **E01 (Missing Source or Target)**: Either `source` or `target` omitted -> 422 `MISSING_COMPARISON_SIDE`.
- **E02 (Empty Source or Target)**: One side has zero length or missing text -> 422 `EMPTY_DOCUMENT_SIDE`.
- **E03 (Missing Discriminator)**: `mode` omitted -> 422 `MISSING_DISCRIMINATOR`.

---

## 6. Field Dictionary

| Parameter | Type | Required? | Allowed Values / Format | Description |
|---|---|---|---|---|
| `mode` | string | Yes | `'diff'`, `'semantic'`, `'version'` | Comparison variant discriminator. |
| `source` | object | Yes | `{ artifactId?: string, text?: string }` | Source (baseline) document side. |
| `target` | object | Yes | `{ artifactId?: string, text?: string }` | Target (revised) document side. |
| `focus` | string | No | String (e.g. `"payment terms"`) | Clause or topic focus area. |
| `outputFormat` | string | No | `'json'`, `'md'`, `'text'` | Target output format. Default `'json'`. |

---

## 7. Sample Payloads & Expected Results

### 7.1. Sample Input (`mode: semantic`)
```json
{
  "mode": "semantic",
  "source": {
    "text": "The Supplier shall deliver goods within 30 days of receiving the purchase order."
  },
  "target": {
    "text": "The Supplier shall deliver goods within 45 business days of receiving the purchase order, subject to material availability."
  },
  "focus": "delivery timelines"
}
```

### 7.2. Expected Result (`mode: semantic`)
```json
{
  "status": "COMPLETED",
  "data": {
    "overallSummary": "Delivery timeline significantly lengthened and conditioned on supply chain availability.",
    "semanticChanges": [
      {
        "clauseTitle": "Delivery Schedule",
        "sourceExcerpt": "within 30 days of receiving the purchase order",
        "targetExcerpt": "within 45 business days of receiving the purchase order, subject to material availability",
        "changeType": "MODIFIED",
        "legalSignificance": "HIGH",
        "commentary": "Extended delivery from 30 calendar days to 45 business days (approx. 63 calendar days), and introduced a conditional escape clause ('subject to material availability')."
      }
    ]
  },
  "provenance": {
    "method": "semantic_comparison",
    "modelSlot": "reasoning"
  },
  "warnings": []
}
```

---

## 8. Profile Settings & Connector Slots
- **Connector Slot**: `reasoning` (required for `semantic` and `version`).
- **Local Diff**: `diff` executes locally with zero LLM consumption.

---

## 9. Standard Function Signatures
```ts
export function validateInput(raw: unknown): Result<CompareInput, ValidationError>;
export function selectRecipe(input: CompareInput, profile: ProfileSnapshot): RecipeDefinition;
export function prepareSources(ctx: TaskContext, input: CompareInput): Promise<NormalizedComparisonSources>;
export function executeRecipe(ctx: TaskContext, recipe: RecipeDefinition, sources: NormalizedComparisonSources): Promise<CompareResult>;
export function validateResult(output: unknown, outputSchema: object): Result<CompareResult, SchemaError>;
export function formatResult(ctx: TaskContext, result: CompareResult, format: string): Promise<ResultEnvelope>;
```

---

## 10. Acceptance Tests Traceability

| Case ID | Scenario | Input | Expected Output |
|---|---|---|---|
| `DOC-06-v1` | Lexical line diff | Two text versions with 1 modified line | Hunks array with `DELETE` and `ADD` tokens, 0 LLM calls |
| `DOC-06-v2` | Semantic comparison | Contract draft vs final version | Structured semantic changes and legal significance rating |
| `DOC-06-v3` | Version changelog | Policy v1 vs v2 | Human-readable changelog of added/modified/removed policies |
| `DOC-06-ERR1` | Missing target side | `{ "mode": "diff", "source": { "text": "foo" } }` | 422 `MISSING_COMPARISON_SIDE` |
| `DOC-06-ERR2` | Missing mode | `{ "source": { "text": "a" }, "target": { "text": "b" } }` | 422 `MISSING_DISCRIMINATOR` |
