# Business Requirements Document (BRD) — Action: Extract

- **Action Name**: `extract`
- **Business**: `document-core`
- **Specification Version**: 1.0.0
- **Test Catalog Suite**: `DOC-02`
- **Subcases / Variants**: 5 (`invoice`, `contract`, `receipt`, `table`, `custom`)

---

## 1. Overview & Business Intent
The `extract` action parses unstructured or semi-structured documents and applies artificial intelligence models to extract rigorously structured domain objects. It guarantees output conformity to strict schemas (financial VAT invoices, legal contracts, commercial receipts, tabular grids, or user-supplied custom JSON schemas) and provides field-level provenance and warning diagnostics.

---

## 2. Actors & Triggers
- **API Client**: POST to `/api/v1/docs/extract` with document reference or raw text, and `type` discriminator.
- **Enterprise Integrations**: ERP, CRM, and Accounting ingestion pipelines automatically submitting scanned documents.

---

## 3. Preconditions & Input Constraints
1. **Document Payload**: Either `artifactIds` (pointing to staged document) or direct inline `text` must be provided.
2. **Discriminator**: The `type` parameter is mandatory and must be one of `['invoice', 'contract', 'receipt', 'table', 'custom']`.
3. **Custom Extraction Constraints**: If `type === 'custom'`, either `fields` (string array) or `schema` (valid JSON Schema object) must be supplied. Network `$ref` references are strictly disallowed, and max object depth is limited to 5.
4. **No Native Bypass**: Even if a document can be parsed natively to text (e.g. DOCX/PDF), the extraction pipeline **must** proceed through inference and schema validation; native parse alone is never returned as extraction result.

---

## 4. Variant Inventory (5 Variants)

### 4.1. `type: invoice` (VAT & Commercial Invoice)
- **Connector Slot**: `reasoning`
- **Domain Fields**: Supplier name, supplier tax ID, buyer name, buyer tax ID, invoice number, invoice date, line items array (description, quantity, unit price, amount), subtotal, VAT rate, VAT amount, total amount, currency.
- **Output**: Typed `InvoiceExtractionResult`.

### 4.2. `type: contract` (Legal & Commercial Contract)
- **Connector Slot**: `reasoning`
- **Domain Fields**: Contract title, contracting parties (Party A, Party B), effective date, expiration date, total contract value, payment terms, termination clauses, penalty clauses, dispute jurisdiction.
- **Output**: Typed `ContractExtractionResult`.

### 4.3. `type: receipt` (POS & Retail Receipt)
- **Connector Slot**: `reasoning`
- **Domain Fields**: Merchant name, store address, receipt number, transaction timestamp, purchased items array, payment method (cash, card, e-wallet), tax amount, grand total.
- **Output**: Typed `ReceiptExtractionResult`.

### 4.4. `type: table` (Tabular Data Extraction)
- **Connector Slot**: `reasoning`
- **Domain Fields**: List of extracted tables, each containing header row array, 2D array of row cells, optional table title/caption, and row/column count.
- **Output**: Typed `TableExtractionResult`.

### 4.5. `type: custom` (Dynamic Schema Extraction)
- **Connector Slot**: `reasoning`
- **Domain Fields**: Dynamically defined by user's `schema` or `fields`.
- **Validation**: Schema is checked for safety (no remote `$ref`, max depth <= 5, max properties <= 50) before dispatch. Upstream provider output is strictly validated against this schema using JSON Schema validator.

---

## 5. Execution Flows

### 5.1. Happy Path Flow
1. **Validate Input**: Validates presence of `type`, verifies input document or text, validates custom schema if supplied.
2. **Select Recipe**: Loads variant-specific prompt template from business recipes, parameterized with system guardrails.
3. **Prepare Sources**: If `artifactIds` provided, extracts text content using `document-kit` native parser or OCR if image.
4. **Execute Recipe**:
   - Step `prepare-source`: Normalizes text and bounds chunk size.
   - Step `build-prompt`: Injects document text and target JSON schema into prompt template.
   - Step `connector-inference`: Invokes Connector slot `reasoning` with stable invocation ID.
   - Step `validate-schema`: Validates raw LLM response against target JSON schema. If minor syntax error (e.g. Markdown code block wrapping), automatically cleanses before validation.
5. **Format Result**: Generates `ExtractionEnvelope`, checkpoints durable output, and stores result artifact.

### 5.2. Error & Alternative Flows
- **E01 (Missing Discriminator)**: `type` missing -> 422 `MISSING_DISCRIMINATOR`.
- **E02 (Invalid Custom Schema)**: Malformed JSON Schema or network `$ref` -> 422 `INVALID_CUSTOM_SCHEMA`.
- **E03 (Provider Invalid Output)**: Provider returns unparseable JSON or violates schema -> Step fails with `PROVIDER_INVALID_RESPONSE`. If configured, executes repair prompt up to 1 retry.
- **E04 (Missing Document)**: Neither `artifactIds` nor `text` provided -> 422 `MISSING_DOCUMENT_SOURCE`.

---

## 6. Field Dictionary

| Parameter | Type | Required? | Allowed Values / Format | Description |
|---|---|---|---|---|
| `type` | string | Yes | `'invoice'`, `'contract'`, `'receipt'`, `'table'`, `'custom'` | Extraction subcase discriminator. |
| `artifactIds` | string[] | No | UUID array | Document artifact references. |
| `text` | string | No | String | Direct document text payload. |
| `fields` | string[] \| string | No | Comma-delimited or string[] | Field list for custom extraction. |
| `schema` | object | No | Valid JSON Schema (draft 2020-12) | Dynamic schema for `type: custom`. |
| `outputFormat` | string | No | `'json'` | Default and canonical format for extraction. |

---

## 7. Sample Payloads & Expected Results

### 7.1. Sample Input (`type: invoice`)
```json
{
  "type": "invoice",
  "text": "HOA DON GIA TRI GIA TANG\nSo: 0012489\nNgay: 15/08/2026\nDon vi ban: Cong ty TNHH Cong Nghe ABC\nMST: 0102345678\nDon vi mua: Tap doan XYZ\nMST: 0309876543\n1. Dich vu Cloud Hosting: 10,000,000 VND\nThue GTGT (10%): 1,000,000 VND\nTong cong thanh toan: 11,000,000 VND"
}
```

### 7.2. Expected Result (`type: invoice`)
```json
{
  "status": "COMPLETED",
  "data": {
    "supplier": {
      "name": "Cong ty TNHH Cong Nghe ABC",
      "taxId": "0102345678"
    },
    "buyer": {
      "name": "Tap doan XYZ",
      "taxId": "0309876543"
    },
    "invoiceNumber": "0012489",
    "invoiceDate": "2026-08-15",
    "lineItems": [
      {
        "description": "Dich vu Cloud Hosting",
        "quantity": 1,
        "unitPrice": 10000000,
        "amount": 10000000
      }
    ],
    "subtotal": 10000000,
    "vatRate": 0.10,
    "vatAmount": 1000000,
    "total": 11000000,
    "currency": "VND"
  },
  "provenance": {
    "method": "llm_extraction",
    "modelSlot": "reasoning"
  },
  "warnings": []
}
```

---

## 8. Profile Settings & Connector Slots
- **Connector Slot**: `reasoning` (required for all 5 variants).
- **Profile Overrides**:
  - `temperature`: Clamped low (0.0 - 0.2) to minimize hallucinations.
  - `model`: Model override allowed only via profile revision.
  - Custom prompt prefixes pinned in profile.

---

## 9. Standard Function Signatures
```ts
export function validateInput(raw: unknown): Result<ExtractInput, ValidationError>;
export function selectRecipe(input: ExtractInput, profile: ProfileSnapshot): RecipeDefinition;
export function prepareSources(ctx: TaskContext, input: ExtractInput): Promise<NormalizedSources>;
export function executeRecipe(ctx: TaskContext, recipe: RecipeDefinition, sources: NormalizedSources): Promise<ExtractResult>;
export function validateResult(output: unknown, outputSchema: object): Result<ExtractResult, SchemaError>;
export function formatResult(ctx: TaskContext, result: ExtractResult, format: string): Promise<ResultEnvelope>;
```

---

## 10. Acceptance Tests Traceability

| Case ID | Scenario | Input | Expected Output |
|---|---|---|---|
| `DOC-02-v1` | Invoice extraction | Scanned/text VAT invoice | Typed `InvoiceData` with taxId and line items |
| `DOC-02-v2` | Contract extraction | Economic contract text | Typed `ContractData` with parties and effective dates |
| `DOC-02-v3` | Receipt extraction | POS receipt text | Typed `ReceiptData` with total amount |
| `DOC-02-v4` | Table extraction | Document containing ASCII/markdown table | 2D array of rows and headers |
| `DOC-02-v5` | Custom extraction with schema | Dynamic schema with `{ customerName, phone }` | Validated JSON strictly adhering to schema |
| `DOC-02-ERR1` | Custom schema with network `$ref` | `{ "$ref": "http://evil.com/schema.json" }` | 422 `INVALID_CUSTOM_SCHEMA` rejected before inference |
| `DOC-02-ERR2` | Provider returns broken JSON | Malformed JSON string from mock provider | 502 `PROVIDER_INVALID_RESPONSE`, step fails |
