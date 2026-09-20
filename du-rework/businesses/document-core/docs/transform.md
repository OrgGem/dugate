# Business Requirements Document (BRD) — Action: Transform

- **Action Name**: `transform`
- **Business**: `document-core`
- **Specification Version**: 1.0.0
- **Test Catalog Suite**: `DOC-04`
- **Subcases / Variants**: 5 (`convert`, `translate`, `rewrite`, `redact`, `template`)

---

## 1. Overview & Business Intent
The `transform` action modifies documents into alternative formats, languages, styles, sanitized privacy-compliant representations, or template-driven structured forms. It spans both pure deterministic local operations (`convert`, local `redact`, `template`) and generative AI operations (`translate`, `rewrite`).

---

## 2. Actors & Triggers
- **API Client**: POST to `/api/v1/docs/transform` with payload containing document and discriminator. Note: the external form field `action` is normalized internally to `variant` to avoid shadowing the root endpoint name.
- **Data Protection Gateway**: Privacy pipelines redacting Personally Identifiable Information (PII) before external distribution.

---

## 3. Preconditions & Input Constraints
1. **Document Payload**: `artifactIds` or raw inline `text` must be supplied.
2. **Discriminator**: Mandatory `variant` (or incoming legacy field `action`), which must be one of `['convert', 'translate', 'rewrite', 'redact', 'template']`.
3. **Variant-Specific Requirements**:
   - `translate`: Requires `targetLanguage` (e.g. `'vi'`, `'en'`).
   - `rewrite`: Optional `style` (e.g. `'academic'`, `'executive'`) and `tone`.
   - `template`: Requires `template` (template string or artifact ID).
4. **Format Support Matrix**: `outputFormat` must be compatible with the target variant (e.g. `convert` requires valid target format such as `md`, `html`, `csv`, `json`).

---

## 4. Variant Inventory (5 Variants)

### 4.1. `variant: convert` (Format Conversion)
- **Connector Slot**: None (Pure local execution via `document-kit`).
- **Function**: Converts file between representations (e.g. DOCX -> Markdown, XLSX -> CSV/Markdown, HTML -> Markdown).
- **Output**: Transformed document artifact reference and direct content text.

### 4.2. `variant: translate` (Linguistic Translation)
- **Connector Slot**: `reasoning`
- **Function**: Translates document text into the requested `targetLanguage` while preserving Markdown formatting, lists, tables, and optional tone requirements.
- **Output**: Translated document content with target language metadata.

### 4.3. `variant: rewrite` (Content Paraphrasing & Style Adaptation)
- **Connector Slot**: `reasoning`
- **Function**: Rewrites content according to specified style (`academic`, `executive`, `simplified`, `bullet_points`) and tone (`formal`, `casual`, `business`), enhancing clarity while preserving core facts.
- **Output**: Rewritten document content with style metadata.

### 4.4. `variant: redact` (PII Masking & Privacy Sanitization)
- **Connector Slot**: `reasoning` / Local Pattern Matcher.
- **Function**: Detects sensitive PII elements (credit cards, national IDs, email addresses, phone numbers) and replaces them with `[REDACTED:<TYPE>]` tokens.
- **Output**: Redacted text and count summary of redacted occurrences.

### 4.5. `variant: template` (Template Merging & Mail-Merge)
- **Connector Slot**: None (Pure local execution via template engine).
- **Function**: Populates template placeholders (e.g. `{{name}}`, `{{amount}}`) with extracted or supplied key-value parameters.
- **Output**: Populated document text or rendered artifact.

---

## 5. Execution Flows

### 5.1. Happy Path Flow
1. **Validate Input**: Validates presence of `variant` (mapping legacy `action` -> `variant`), verifies source text or artifact, checks variant-specific parameters (`targetLanguage` for `translate`, `template` for `template`).
2. **Select Recipe**:
   - `convert`: Selects local parser/converter recipe from `document-kit`.
   - `translate` / `rewrite`: Selects LLM reasoning recipe with target language or style parameters.
   - `redact`: Selects regex/PII engine or hybrid LLM redaction recipe.
   - `template`: Selects local interpolation recipe.
3. **Prepare Sources**: Loads source document stream or inline text.
4. **Execute Recipe**:
   - For local recipes (`convert`, `template`): Executes synchronously within step, checkpoints full result.
   - For inference recipes (`translate`, `rewrite`): Dispatches to Connector slot `reasoning` with stable invocation ID.
5. **Format Result**: Builds `TransformEnvelope`, checkpoints full output, and persists output artifact if requested.

### 5.2. Error & Alternative Flows
- **E01 (Missing Target Language in Translate)**: `translate` without `targetLanguage` -> 422 `MISSING_REQUIRED_PARAMETER`.
- **E02 (Unsupported Format Conversion)**: Requesting conversion from image binary directly to CSV in `convert` mode -> 422 `UNSUPPORTED_FORMAT`.
- **E03 (Missing Template Parameter)**: `template` without template definition -> 422 `MISSING_REQUIRED_PARAMETER`.

---

## 6. Field Dictionary

| Parameter | Type | Required? | Allowed Values / Format | Description |
|---|---|---|---|---|
| `variant` / `action` | string | Yes | `'convert'`, `'translate'`, `'rewrite'`, `'redact'`, `'template'` | Transformation variant discriminator. |
| `artifactIds` | string[] | No | UUID array | Input document artifact references. |
| `text` | string | No | String | Raw text to transform. |
| `targetLanguage` | string | Conditional | e.g. `'vi'`, `'en'`, `'ja'`, `'fr'` | Required for `translate`. |
| `style` | string | No | `'academic'`, `'executive'`, `'simplified'`, `'bullet_points'` | Style option for `rewrite`. |
| `tone` | string | No | `'formal'`, `'casual'`, `'business'`, `'academic'` | Tone option for `translate` and `rewrite`. |
| `redactPatterns` | string[] | No | e.g. `['PHONE', 'EMAIL', 'CREDIT_CARD']` | PII patterns to redact. |
| `template` | string | Conditional | Template string or artifact reference | Required for `template`. |
| `outputFormat` | string | No | `'md'`, `'html'`, `'csv'`, `'json'`, `'text'` | Target format. |

---

## 7. Sample Payloads & Expected Results

### 7.1. Sample Input (`variant: translate`)
```json
{
  "variant": "translate",
  "text": "The quarterly earnings exceeded all analyst expectations, showing a 15% year-over-year revenue increase.",
  "targetLanguage": "vi",
  "tone": "formal"
}
```

### 7.2. Expected Result (`variant: translate`)
```json
{
  "status": "COMPLETED",
  "data": {
    "transformedText": "Doanh thu quy da vuot qua moi ky vong cua gioi phan tich, ghi nhan muc tang truong 15% so voi cung ky nam truoc.",
    "targetLanguage": "vi",
    "tone": "formal",
    "detectedSourceLanguage": "en"
  },
  "provenance": {
    "method": "llm_translation",
    "modelSlot": "reasoning"
  },
  "warnings": []
}
```

---

## 8. Profile Settings & Connector Slots
- **Connector Slot**: `reasoning` (required for `translate` and `rewrite`; optional for advanced `redact`).
- **Local Utilities**: `convert`, `redact` (standard regex), and `template` incur zero LLM cost and run strictly through `document-kit`.

---

## 9. Standard Function Signatures
```ts
export function validateInput(raw: unknown): Result<TransformInput, ValidationError>;
export function selectRecipe(input: TransformInput, profile: ProfileSnapshot): RecipeDefinition;
export function prepareSources(ctx: TaskContext, input: TransformInput): Promise<NormalizedSources>;
export function executeRecipe(ctx: TaskContext, recipe: RecipeDefinition, sources: NormalizedSources): Promise<TransformResult>;
export function validateResult(output: unknown, outputSchema: object): Result<TransformResult, SchemaError>;
export function formatResult(ctx: TaskContext, result: TransformResult, format: string): Promise<ResultEnvelope>;
```

---

## 10. Acceptance Tests Traceability

| Case ID | Scenario | Input | Expected Output |
|---|---|---|---|
| `DOC-04-v1` | Format convert DOCX to Markdown | Valid DOCX file | Clean Markdown representation, 0 LLM calls |
| `DOC-04-v2` | Translation English to Vietnamese | English financial text, `targetLanguage="vi"` | Vietnamese translated text |
| `DOC-04-v3` | Content rewrite executive style | Raw draft text, `style="executive"` | Polished executive summary |
| `DOC-04-v4` | PII redaction | Text with phone numbers and email addresses | Text with `[REDACTED:PHONE]` and `[REDACTED:EMAIL]` |
| `DOC-04-v5` | Template merge | Template with `{{name}}` and data | Interpolated final text |
| `DOC-04-ERR1` | Missing targetLanguage in translate | `{ "variant": "translate", "text": "Hello" }` | 422 `MISSING_REQUIRED_PARAMETER` |
| `DOC-04-ERR2` | Unsupported conversion format | Image binary with `outputFormat="csv"` | 422 `UNSUPPORTED_FORMAT` |
