# Business Requirements Document (BRD) — Action: Analyze

- **Action Name**: `analyze`
- **Business**: `document-core`
- **Specification Version**: 1.0.0
- **Test Catalog Suite**: `DOC-03`
- **Subcases / Variants**: 5 (`classify`, `sentiment`, `compliance`, `quality`, `risk`)

---

## 1. Overview & Business Intent
The `analyze` action evaluates documents against analytical frameworks, legal rules, sentiment scales, taxonomy classification, and operational risk metrics. It transforms unstructured text into quantified evaluations, structured findings, rule compliance scores, and actionable feedback.

---

## 2. Actors & Triggers
- **API Client**: POST to `/api/v1/docs/analyze` with document content and `task` discriminator.
- **Workflow Orchestration**: Pre-sorting documents for automated triage, legal compliance screening, or customer feedback analysis.

---

## 3. Preconditions & Input Constraints
1. **Document Payload**: Either `artifactIds` or direct inline `text` must be supplied.
2. **Discriminator**: `task` parameter is mandatory and must be one of `['classify', 'sentiment', 'compliance', 'quality', 'risk']`.
3. **Task-Specific Mandatory Inputs**:
   - `classify`: Requires `categories` (non-empty array or comma-separated string).
   - `compliance`: Requires `criteria` (non-empty string or array of rule descriptions).
4. **Separation of Assessment and Decision**: The analysis result distinguishes model assessment (findings, scores, confidence) from final enterprise disposition.

---

## 4. Variant Inventory (5 Variants)

### 4.1. `task: classify` (Document Taxonomy Classification)
- **Connector Slot**: `reasoning`
- **Function**: Assigns the document to one or more predefined taxonomy buckets provided in `categories`.
- **Output**: `ClassificationResult`: primary category, confidence score (0.0 to 1.0), reasoning statement, and ranked secondary matches.

### 4.2. `task: sentiment` (Sentiment & Tone Analysis)
- **Connector Slot**: `reasoning`
- **Function**: Determines overall emotional tone and sentiment polarity (positive, negative, neutral, mixed), quantified on a normalized scale (-1.0 to +1.0) with explanatory rationale.
- **Output**: `SentimentResult`: sentiment label, polarity score, explanation, key influencing passages.

### 4.3. `task: compliance` (Regulatory & Contractual Compliance Check)
- **Connector Slot**: `reasoning`
- **Function**: Scans document against explicit criteria or guidelines (e.g., "Must have two signatures", "Interest rate must not exceed 20%").
- **Output**: `ComplianceResult`: overall status (`PASS` / `FAIL`), score, violations list (rule violated, excerpt quote, severity, remediation recommendation).

### 4.4. `task: quality` (Writing Quality & Logic Evaluation)
- **Connector Slot**: `reasoning`
- **Function**: Evaluates linguistic clarity, grammatical integrity, structural coherence, and argument logic.
- **Output**: `QualityResult`: overallScore (0-100), sub-scores (grammar, clarity, structure, conciseness), identified issues, and suggested revisions.

### 4.5. `task: risk` (Contractual & Operational Risk Assessment)
- **Connector Slot**: `reasoning`
- **Function**: Scrutinizes legal agreements and business proposals for high-liability exposure, uncapped indemnity, ambiguous timelines, or unfavorable termination rights.
- **Output**: `RiskResult`: overallRiskLevel (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), riskScore (0-100), identifiedRisks array (clause reference, quote, risk category, impact, recommendation).

---

## 5. Execution Flows

### 5.1. Happy Path Flow
1. **Validate Input**: Validates presence of `task` discriminator, validates existence of mandatory variant parameters (`categories` for `classify`, `criteria` for `compliance`).
2. **Select Recipe**: Selects variant recipe matching the analytical task and loads associated structured prompt template.
3. **Prepare Sources**: Extracts document text via `document-kit` parser or retrieves cached text representation.
4. **Execute Recipe**:
   - `prepare-source`: Cleanses and chunks text if necessary.
   - `build-prompt`: Injects target criteria, categories, or risk taxonomy into system prompt.
   - `connector-inference`: Dispatches inference request to `reasoning` slot with stable invocation ID.
   - `validate-findings`: Validates that the provider output conforms strictly to the variant's JSON schema (e.g. valid scores, recognized enum values).
5. **Format Result**: Generates `AnalysisEnvelope`, checkpoints durable state, and registers result artifact.

### 5.2. Error & Alternative Flows
- **E01 (Missing Categories in Classify)**: `classify` invoked without `categories` -> 422 `MISSING_REQUIRED_PARAMETER`.
- **E02 (Missing Criteria in Compliance)**: `compliance` invoked without `criteria` -> 422 `MISSING_REQUIRED_PARAMETER`.
- **E03 (Invalid Provider Response)**: Provider returns unstructured text instead of structured findings -> 502 `PROVIDER_INVALID_RESPONSE`.

---

## 6. Field Dictionary

| Parameter | Type | Required? | Allowed Values / Format | Description |
|---|---|---|---|---|
| `task` | string | Yes | `'classify'`, `'sentiment'`, `'compliance'`, `'quality'`, `'risk'` | Analytical subcase discriminator. |
| `artifactIds` | string[] | No | UUID array | Reference to document artifacts. |
| `text` | string | No | String | Raw text to analyze. |
| `categories` | string[] \| string | Conditional | Array of category slugs or names | Required for `task === 'classify'`. |
| `criteria` | string \| string[] | Conditional | Rule definitions or compliance checklist | Required for `task === 'compliance'`. |
| `referenceData` | object \| string | No | JSON object or string | Ground truth data for fact-checking/audit. |

---

## 7. Sample Payloads & Expected Results

### 7.1. Sample Input (`task: compliance`)
```json
{
  "task": "compliance",
  "text": "Hop dong hop tac kinh doanh giua Cong ty A va Cong ty B. Dieu 5: Lai suat phat cham thanh toan la 25%/nam. Hop dong chi co chu ky cua Ben A, chua co chu ky Ben B.",
  "criteria": "1. Lai suat phat khong duoc vuot qua 20%/nam theo quy dinh phap luat.\n2. Hop dong phai co day du chu ky cua ca hai ben A va B."
}
```

### 7.2. Expected Result (`task: compliance`)
```json
{
  "status": "COMPLETED",
  "data": {
    "status": "FAIL",
    "score": 50,
    "evaluatedCriteriaCount": 2,
    "violations": [
      {
        "ruleId": "RULE-01",
        "rule": "Lai suat phat khong duoc vuot qua 20%/nam",
        "excerpt": "Dieu 5: Lai suat phat cham thanh toan la 25%/nam",
        "severity": "HIGH",
        "recommendation": "Giam lai suat phat ve toi da 20%/nam de dam bao tinh hop phap."
      },
      {
        "ruleId": "RULE-02",
        "rule": "Hop dong phai co day du chu ky cua ca hai ben",
        "excerpt": "Hop dong chi co chu ky cua Ben A, chua co chu ky Ben B",
        "severity": "CRITICAL",
        "recommendation": "Yeu cau dai dien co tham quyen cua Ben B ky va dong dau."
      }
    ]
  },
  "provenance": {
    "method": "llm_evaluation",
    "modelSlot": "reasoning"
  },
  "warnings": []
}
```

---

## 8. Profile Settings & Connector Slots
- **Connector Slot**: `reasoning` (required for all 5 variants).
- **Profile Overrides**:
  - Pinned compliance rule books and standard taxonomy trees.
  - Risk threshold levels (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).

---

## 9. Standard Function Signatures
```ts
export function validateInput(raw: unknown): Result<AnalyzeInput, ValidationError>;
export function selectRecipe(input: AnalyzeInput, profile: ProfileSnapshot): RecipeDefinition;
export function prepareSources(ctx: TaskContext, input: AnalyzeInput): Promise<NormalizedSources>;
export function executeRecipe(ctx: TaskContext, recipe: RecipeDefinition, sources: NormalizedSources): Promise<AnalyzeResult>;
export function validateResult(output: unknown, outputSchema: object): Result<AnalyzeResult, SchemaError>;
export function formatResult(ctx: TaskContext, result: AnalyzeResult, format: string): Promise<ResultEnvelope>;
```

---

## 10. Acceptance Tests Traceability

| Case ID | Scenario | Input | Expected Output |
|---|---|---|---|
| `DOC-03-v1` | Document classification | Text + categories `['invoice', 'contract', 'report']` | Category `'contract'` with confidence >= 0.85 |
| `DOC-03-v2` | Customer review sentiment | Negative review text | Sentiment `'negative'`, score < -0.5 |
| `DOC-03-v3` | Compliance audit violation | Contract text with 25% penalty | Status `'FAIL'`, 2 violations with quotes |
| `DOC-03-v4` | Document quality check | Poorly drafted text | Clarity score < 70, grammar suggestions |
| `DOC-03-v5` | Risk assessment | Liability clause with unlimited damages | Risk level `'CRITICAL'`, uncapped liability risk |
| `DOC-03-ERR1` | Missing categories in classify | `{ "task": "classify", "text": "foo" }` | 422 `MISSING_REQUIRED_PARAMETER` |
| `DOC-03-ERR2` | Missing criteria in compliance | `{ "task": "compliance", "text": "foo" }` | 422 `MISSING_REQUIRED_PARAMETER` |
