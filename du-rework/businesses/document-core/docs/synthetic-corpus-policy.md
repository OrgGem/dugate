# Synthetic Corpus Policy & Test Fixture Specifications (P0-05)

## 1. Zero-PII Synthetic Corpus Policy

All automated test suites across `@du/document-core`, `@du/document-kit`, and `@du/example-review` operate under a strict **Zero-PII / Synthetic-Only Corpus Policy**:

1. **Zero Real Customer Data**: No actual production invoices, contracts, IDs, financial statements, or customer records may ever be stored in git or used in test fixtures.
2. **Zero Production Secrets**: No live API keys, provider credentials, tokens, or encryption keys are committed to repository fixtures. All tests use generated test secrets or mock authorization headers.
3. **Procedural Synthetic Generation**: Test documents (PDF, DOCX, XLSX, CSV, TXT, JSON) are generated procedurally in memory via test helpers (`TestFixtures`) or synthetic OpenXML byte builders.
4. **Deterministic Reproducibility**: Given the same seed or fixture generator, test inputs produce byte-identical and schema-identical outputs across test runs.

---

## 2. Native Parser vs. LLM Provider Expectations

The architecture strictly distinguishes the role of **local native parsers** from **upstream LLM reasoning models**:

| Dimension | Native Parser (`document-kit`) | LLM Reasoning Connector (`connector`) |
|---|---|---|
| **Execution Environment** | Local worker process (CPU-bound, zero network egress) | Out-of-process via Connector gateway (HTTP, network egress) |
| **Primary Actions** | `ingest/parse`, `ingest/split`, `transform/convert` | `extract/*`, `analyze/*`, `generate/*`, `compare/*`, `transform/translate`, `transform/rewrite` |
| **Output Type** | Exact literal text, markdown tables, page/sheet structure | Structured JSON matching schema, synthesized narratives, sentiment/classification tags |
| **Provenance Metadata** | `provenance: 'native_parse'` | `provenance: { method: 'llm_extraction', modelSlot: 'reasoning' }` |
| **Error Handling** | Throws `UNSUPPORTED_FORMAT` or `PARSE_ERROR` on corrupt binary; never silent fallback | Throws `PROVIDER_INVALID_RESPONSE` or `SCHEMA_VIOLATION` on malformed JSON; controlled retry |
| **Token Usage** | Exactly 0 tokens, 0 cost microusd | Measured input/output tokens, reported via usage outbox |

---

## 3. Test Fixture Specifications Across the 28 Variants

### Action 1: Ingest (4 Variants — DOC-01)
- **DOC-01-v1 (`parse`)**:
  - *Input Fixture*: Synthetic OpenXML DOCX (`createSyntheticDocx`), XLSX (`createSyntheticXlsx`), or PDF stream (`createSamplePdf`).
  - *Expected Result*: `DocumentContent` with exact text, markdown tables (`| col1 | col2 |`), page/sheet counts. `provenance: 'native_parse'`.
- **DOC-01-v2 (`ocr`)**:
  - *Input Fixture*: Synthetic image buffer or scanned PDF bytes.
  - *Expected Result*: OCR text blocks with bounding boxes and confidence score $\ge 0.85$.
- **DOC-01-v3 (`digitize`)**:
  - *Input Fixture*: Synthetic scanned form image.
  - *Expected Result*: Key-value pairs extracted from form fields with normalization.
- **DOC-01-v4 (`split`)**:
  - *Input Fixture*: Multi-page synthetic PDF with page range specification `"1-2,4"`.
  - *Expected Result*: Split PDF artifacts written to storage; artifact refs returned in array.

### Action 2: Extract (5 Variants — DOC-02)
- **DOC-02-v1 (`invoice`)**:
  - *Input Fixture*: Unstructured invoice text: `"Invoice INV-2026-X01 from Acme Global Corp Total $4200 for Cloud Infrastructure Gateway Service"`.
  - *Expected Result*: `InvoiceData` with `invoiceNumber: 'INV-2026-X01'`, `total: 4200`, `currency: 'USD'`, `supplier: { name: 'Acme Global Corp' }`.
- **DOC-02-v2 (`contract`)**:
  - *Input Fixture*: Unstructured contract text with clauses, parties, effective date.
  - *Expected Result*: `ContractData` with `parties: { partyA: 'Company A', partyB: 'Company B' }`, `effectiveDate`, `governingLaw`.
- **DOC-02-v3 (`receipt`)**:
  - *Input Fixture*: Point-of-sale receipt text with merchant, timestamp, line items.
  - *Expected Result*: `ReceiptData` with `merchantName`, `totalAmount`, `paymentMethod`.
- **DOC-02-v4 (`table`)**:
  - *Input Fixture*: Financial report text containing tabular data.
  - *Expected Result*: `TableData` with `headers: ['Q1', 'Q2', 'Q3']`, `rows: [['100', '200', '300']]`.
- **DOC-02-v5 (`custom`)**:
  - *Input Fixture*: Arbitrary document text + client-supplied JSON Schema.
  - *Expected Result*: JSON object strictly conforming to client schema; rejected if schema contains network `$ref` or depth $> 5$.

### Action 3: Analyze (5 Variants — DOC-03)
- **DOC-03-v1 (`classify`)**:
  - *Input Fixture*: Text document + target `categories: ['legal', 'financial', 'technical']`.
  - *Expected Result*: `ClassificationResult` with assigned `category`, `confidence: 0.95`, `reasoning`.
- **DOC-03-v2 (`sentiment`)**:
  - *Input Fixture*: Customer feedback text.
  - *Expected Result*: `SentimentResult` with `sentiment: 'positive' | 'negative' | 'neutral'`, `score: -1.0 .. 1.0`.
- **DOC-03-v3 (`compliance`)**:
  - *Input Fixture*: Policy document + compliance rule set.
  - *Expected Result*: `ComplianceResult` with `status: 'PASS' | 'FAIL'`, `violations: []`.
- **DOC-03-v4 (`quality`)**:
  - *Input Fixture*: Technical documentation text.
  - *Expected Result*: `QualityResult` with grammar, clarity, logic scores (0–100).
- **DOC-03-v5 (`risk`)**:
  - *Input Fixture*: Commercial agreement text.
  - *Expected Result*: `RiskResult` with `riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'`, identified risk clauses.

### Action 4: Transform (5 Variants — DOC-04)
- **DOC-04-v1 (`convert`)**:
  - *Input Fixture*: Markdown or plain text document.
  - *Expected Result*: Converted output format (e.g. HTML or CSV) executed locally by `document-kit`.
- **DOC-04-v2 (`translate`)**:
  - *Input Fixture*: Source text + `targetLanguage: 'vi'`.
  - *Expected Result*: Translated text preserved under markdown layout.
- **DOC-04-v3 (`rewrite`)**:
  - *Input Fixture*: Casual text + `style: 'executive'`.
  - *Expected Result*: Paraphrased text matching requested formal style.
- **DOC-04-v4 (`redact`)**:
  - *Input Fixture*: Text containing email, phone, SSN patterns.
  - *Expected Result*: Masked text with `[REDACTED:EMAIL]`, `[REDACTED:PHONE]`, `[REDACTED:CREDIT_CARD]` tokens.
- **DOC-04-v5 (`template`)**:
  - *Input Fixture*: Mustache-style template + variable dictionary.
  - *Expected Result*: Interpolated document text.

### Action 5: Generate (6 Variants — DOC-05)
- **DOC-05-v1 (`summary`)**: Concise executive summary with key takeaways.
- **DOC-05-v2 (`outline`)**: Hierarchical markdown outline with sections and subsections.
- **DOC-05-v3 (`report`)**: Comprehensive multi-section analysis report.
- **DOC-05-v4 (`email`)**: Professional email draft summarizing document findings.
- **DOC-05-v5 (`minutes`)**: Meeting minutes format with attendees, decisions, action items.
- **DOC-05-v6 (`qa`)**: Question-answer pairs extracted from source document.

### Action 6: Compare (3 Variants — DOC-06)
- **DOC-06-v1 (`diff`)**: Line-by-line and character-level unified diff between source and target documents.
- **DOC-06-v2 (`semantic`)**: Semantic equivalence analysis identifying substantive clause changes versus stylistic edits.
- **DOC-06-v3 (`version`)**: Version changelog categorization (added, modified, removed clauses) between v1 and v2 contract documents.

---

## 4. Test Execution & Per-Variant Coverage Levels

Coverage is structured into three distinct, non-overlapping verification layers:

1. **Unit & Boundary Tests**:
   - Verifies input validation, schema coercion, normalizers, failure taxonomy, and step checkpointing.
   - Files: `tests/bounded-input.test.ts`, `tests/output-validation.test.ts`, `tests/checkpoint.test.ts`, `packages/document-kit/tests/limits-boundary.test.ts`, etc.
   - Corpus: Procedural fixtures with edge values (zero bytes, multi-byte UTF-8 diacritics, malformed payloads).

2. **Deterministic Matrix Test (All 28 Canonical Variants)**:
   - File: `businesses/document-core/tests/all-variants-e2e.test.ts`
   - Scope: Executes all 28 canonical variants (`DOC-01-v1..v4`, `DOC-02-v1..v5`, `DOC-03-v1..v5`, `DOC-04-v1..v5`, `DOC-05-v1..v6`, `DOC-06-v1..v3`) sequentially in-process.
   - Execution: Fully offline with local mock provider responses; zero network or external database dependencies.

3. **Cross-Service Process Integration Test (6 Canonical Representative Actions Only)**:
   - File: `businesses/document-core/tests/multi-container-e2e.integration.test.ts`
   - Scope: Exactly **6 canonical representative actions** (one per action family), NOT all 28 variants:
     - `DOC-01-v1` (`ingest/parse`): Native parsing, artifact creation, 0 provider usage.
     - `DOC-02-v1` (`extract/invoice`): Provider-backed extraction, structured JSON output, usage recording.
     - `DOC-03-v1` (`analyze/classify`): Provider-backed classification, category output, usage recording.
     - `DOC-04-v1` (`transform/convert`): Native markdown conversion, 0 provider usage.
     - `DOC-05-v1` (`generate/summary`): Provider-backed executive summary synthesis, usage recording.
     - `DOC-06-v1` (`compare/diff`): Native unified diff comparison, 0 provider usage.
   - Execution: Live multi-service test with real PostgreSQL, Redis, Orchestrator runtime HTTP API, and real Connector HTTP gateway.
   - Note on Current State: Grant verification in Connector currently uses the temporary `pendingHashes` shim pending Claude's canonical hash implementation (W10-C1). All 28 variants are NOT tested in live cross-service E2E.
