# Business Requirements Document (BRD) — Action: Ingest

- **Action Name**: `ingest`
- **Business**: `document-core`
- **Specification Version**: 1.0.0
- **Test Catalog Suite**: `DOC-01`
- **Subcases / Variants**: 4 (`parse`, `ocr`, `digitize`, `split`)

---

## 1. Overview & Business Intent
The `ingest` action is the entry gate for physical and digital files into the AI document processing ecosystem. It accepts documents (PDF, DOCX, XLSX, images, text) and either parses layout/text natively via local utilities, invokes optical character recognition (OCR) / vision models for scanned documents, or splits composite PDF files into discrete targeted page ranges.

---

## 2. Actors & Triggers
- **API Client**: Sends an ingestion request to `/api/v1/docs/ingest` with an uploaded artifact reference or file payload and mode discriminator.
- **Upstream Workflow**: Invokes ingestion as step 1 in a multi-stage document processing pipeline.

---

## 3. Preconditions & Input Constraints
1. **Artifact Staging**: The target file must be uploaded and verified in artifact storage, returning a valid `artifactId`, or provided as an inline text payload where applicable.
2. **Supported File Formats**:
   - `parse`: PDF, DOCX, XLSX, CSV, TXT, MD.
   - `ocr`: PNG, JPG, JPEG, TIFF, WEBP, PDF (scan).
   - `digitize`: PNG, JPG, JPEG, TIFF, PDF (scan with handwritten forms).
   - `split`: PDF only.
3. **Discriminator**: The `mode` parameter is mandatory and must be one of `['parse', 'ocr', 'digitize', 'split']`.

---

## 4. Variant Inventory (4 Variants)

### 4.1. `mode: parse` (Native Parsing)
- **Execution**: Pure local execution via `document-kit`. Zero external provider calls.
- **Function**: Extracts structured text, markdown representation, page counts, sheet names (for spreadsheets), and table layouts.
- **Output**: `DocumentContent` with text, markdown, and metadata.

### 4.2. `mode: ocr` (Optical Character Recognition)
- **Execution**: Dispatches to Connector slot `ocr` (e.g., Google Document AI, Azure OCR, or Tesseract/PaddleOCR adapter).
- **Function**: Performs optical character recognition on scanned images/PDFs with optional language hints.
- **Output**: `DocumentContent` with extracted text, normalized markdown, confidence scores, and page blocks.

### 4.3. `mode: digitize` (Handwriting & Form Digitization)
- **Execution**: Dispatches to Connector slot `vision` (or advanced OCR model).
- **Function**: Specializes in skewed forms, handwritten notations, checkbox marks, and table boundary normalization.
- **Output**: Form field key-value pairs, checkbox states, and normalized markdown.

### 4.4. `mode: split` (PDF Page Splitting)
- **Execution**: Pure local execution via `document-kit` PDF manipulation tools.
- **Function**: Extracts specified page subsets (e.g. `"1-3,5"`) and outputs new discrete PDF artifacts.
- **Output**: Split artifact references and page manifest.

---

## 5. Execution Flows

### 5.1. Happy Path Flow
1. **Validation**: Worker receives task payload, normalizes fields (mapping legacy `output_format` to `outputFormat`), and validates against `inputSchema`.
2. **Recipe Selection**: Selects recipe based on `mode`:
   - `ingest:parse` -> `[validate -> local-parse -> normalize -> store]`
   - `ingest:ocr` -> `[validate -> prepare-image -> connector-ocr -> normalize -> store]`
   - `ingest:digitize` -> `[validate -> prepare-image -> connector-vision -> normalize -> store]`
   - `ingest:split` -> `[validate -> local-split -> register-artifacts -> store]`
3. **Source Preparation**: Retrieves authorized file stream for `artifactId` via `ctx.artifacts.read()`.
4. **Execution**:
   - For `parse` and `split`: Executes local pure function via `document-kit`. Checkpoints intermediate and final results without LLM usage.
   - For `ocr` and `digitize`: Obtains stable invocation ID from `ctx.connector`, dispatches to `ocr`/`vision` slot, and validates response schema.
5. **Result Validation & Formatting**: Validates output against `outputSchema` and writes final output artifact via `ctx.artifacts.write()`. Checkpoint records full output without truncation.

### 5.2. Error & Alternative Flows
- **E01 (Missing Mode)**: Request rejected with `VALIDATION_ERROR` (code: `MISSING_DISCRIMINATOR`).
- **E02 (Unsupported Format)**: Submitting an image file to `parse` mode returns `UNSUPPORTED_FORMAT` with recommendation to use `ocr`.
- **E03 (Invalid Page Range in Split)**: Submitting `"pages": "10-20"` for a 5-page document returns `INVALID_PAGE_RANGE`.
- **E04 (Provider Failure in OCR)**: Connector returns 5xx/timeout -> runtime retries with exponential backoff within retry budget. If exhausted, task marked `FAILED`.

---

## 6. Field Dictionary

| Parameter | Type | Required? | Allowed Values / Format | Description |
|---|---|---|---|---|
| `mode` | string | Yes | `'parse'`, `'ocr'`, `'digitize'`, `'split'` | Ingestion variant discriminator. |
| `artifactIds` | string[] | Yes | Array of UUID strings | Input document artifact references. |
| `pages` | string | Conditional | e.g. `"1"`, `"1-5"`, `"1,3,5"` | Required if `mode === 'split'`. Optional page filter for `parse` and `ocr`. |
| `language` | string | No | e.g. `'vie'`, `'eng'`, `'vi+en'` | Language hint for OCR / parsing accuracy. |
| `outputFormat` | string | No | `'json'`, `'md'`, `'text'` | Desired serialization format. Default `'json'`. |

---

## 7. Sample Payloads & Expected Results

### 7.1. Sample Input (`mode: parse`)
```json
{
  "mode": "parse",
  "artifactIds": ["art-uuid-101"],
  "outputFormat": "md"
}
```

### 7.2. Expected Result (`mode: parse`)
```json
{
  "status": "COMPLETED",
  "data": {
    "text": "QUARTERLY FINANCIAL REPORT\nQ3 2026...",
    "markdown": "# QUARTERLY FINANCIAL REPORT\n\n## Q3 2026...",
    "metadata": {
      "pageCount": 12,
      "detectedFormat": "application/pdf",
      "parser": "document-kit:pdf-native",
      "provenance": "native_parse"
    }
  },
  "warnings": []
}
```

### 7.3. Sample Input (`mode: split`)
```json
{
  "mode": "split",
  "artifactIds": ["art-uuid-101"],
  "pages": "1-3,5"
}
```

### 7.4. Expected Result (`mode: split`)
```json
{
  "status": "COMPLETED",
  "data": {
    "splitArtifacts": [
      {
        "artifactId": "art-uuid-split-1",
        "fileName": "split_pages_1-3_5.pdf",
        "pageCount": 4,
        "pageRange": "1-3,5"
      }
    ]
  },
  "warnings": []
}
```

---

## 8. Profile Settings & Connector Slots
- **Connector Slots**:
  - `ocr`: Required only for `mode: ocr`. Defaults to configured OCR adapter.
  - `vision`: Required only for `mode: digitize`.
  - Pure local modes (`parse`, `split`) require NO connector slots.
- **Profile Overrides**: Profile can pin default OCR model, target OCR language, and max allowed pages per split job.

---

## 9. Standard Function Signatures
```ts
export function validateInput(raw: unknown): Result<IngestInput, ValidationError>;
export function selectRecipe(input: IngestInput, profile: ProfileSnapshot): RecipeDefinition;
export function prepareSources(ctx: TaskContext, input: IngestInput): Promise<NormalizedSources>;
export function executeRecipe(ctx: TaskContext, recipe: RecipeDefinition, sources: NormalizedSources): Promise<IngestResult>;
export function validateResult(output: unknown, outputSchema: object): Result<IngestResult, SchemaError>;
export function formatResult(ctx: TaskContext, result: IngestResult, format: string): Promise<ResultEnvelope>;
```

---

## 10. Acceptance Tests Traceability

| Case ID | Scenario | Input | Expected Output |
|---|---|---|---|
| `DOC-01-v1` | Native DOCX/PDF parse | Valid DOCX artifact | Markdown text, wordCount metadata, 0 LLM provider calls |
| `DOC-01-v2` | Scanned image OCR | PNG scanned receipt | Extracted text blocks, confidence score > 0.8 |
| `DOC-01-v3` | Handwritten form digitize | Skewed PDF form | Normalized key-values, checkbox states |
| `DOC-01-v4` | PDF page split | 10-page PDF, `pages="1-3,5"` | 1 artifact containing exactly 4 pages |
| `DOC-01-ERR1` | Missing discriminator | `{ "artifactIds": ["art-1"] }` | 422 `MISSING_DISCRIMINATOR` |
| `DOC-01-ERR2` | Split non-PDF file | XLSX file, `pages="1-2"` | 422 `UNSUPPORTED_FORMAT` |
| `DOC-01-ERR3` | Split out-of-range page | 5-page PDF, `pages="10-12"` | 422 `INVALID_PAGE_RANGE` |
