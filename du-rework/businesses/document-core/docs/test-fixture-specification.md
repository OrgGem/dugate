# Document Core: Test Fixture Specification (P0-05)

## 1. Executive Summary & Objectives

The Document Understanding Gateway (`DUGate`) processes a diverse spectrum of unstructured enterprise documents across six canonical operation families (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`).

This specification formalizes:
1. **Zero-PII & Non-Sensitive Synthetic Fixture Policy**: Rules governing test data generation to ensure zero customer secrets or sensitive personal identifiable information (PII) enter source control or test runs.
2. **Native Parser Expectations vs. LLM Provider Expectations**: Structural, behavioral, latency, and token consumption boundaries distinguishing local CPU-bound parsers (`@du/document-kit`) from upstream AI reasoning models (`@du/connector`).
3. **Original 28-Variant Fixture Dictionary**: Historical P0-05 synthetic inputs (`DOC-01-01` through `DOC-06-03`); the executable business matrix now declares 31 variants.
4. **Machine-Derived Expected Result Corpus**: Explicit mapping to `tests/fixtures/expected-result-corpus.ts`, where 100% of expected output envelopes were derived by executing the real handlers rather than theoretical inference.

---

## 2. Zero-PII & Synthetic Fixture Policy

Automated test execution across CI/CD, local developer sandboxes, and isolated container runs strictly complies with the following invariants:

| Policy Invariant | Enforcement Mechanism | Failure Mode |
|---|---|---|
| **Zero Customer Documents** | All test documents are procedurally constructed in-memory or built using deterministic synthetic generators (`tests/helpers/synthetic-fixtures.ts`). No real scanned PDFs, tax forms, or vendor contracts. | Test suite quarantine; pipeline block. |
| **Zero Live Secrets / API Keys** | All provider credentials, connector URLs, and authorization headers utilize mock tokens (`mock-api-key-xyz`, `[REDACTED]`). | SAST credential scanner rejects commit. |
| **Pure Offline Reproducibility** | Unit and variant matrix suites (`tests/all-variants-e2e.test.ts`) require zero network egress, zero running databases, and zero external Redis instances. | Network sandboxing; fast failure if socket connect attempted. |
| **Deterministic Data Layout** | Fixed seeds, standardized company names (`Acme Corp`, `Globex Industries`), predictable dates (`2026-03-31`), and fixed financial figures (`$4,200.00`). | Byte-exact diff and schema regression testing. |

---

## 3. Native Parser Expectations vs. LLM Provider Expectations

The platform strictly partitions processing responsibility between local native parsing engines and external LLM provider capabilities. Test fixtures must validate the distinct invariants of each tier:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Document Core Dispatcher                         │
└───────────────────┬─────────────────────────────────┬───────────────────┘
                    │                                 │
         Native Parse / Transform         LLM Extract / Analyze / Gen / Comp
                    ▼                                 ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────┐
│     @du/document-kit (Native Engine)  │ │   @du/connector (AI Gateway)  │
├───────────────────────────────────────┤ ├───────────────────────────────┤
│ • Execution: In-process / CPU-bound   │ │ • Execution: HTTP RPC / Egress│
│ • Determinism: 100% byte-deterministic│ │ • Determinism: Seeded LLM /   │
│ • Token Usage: Exactly 0 tokens ($0)  │ │   schema-constrained JSON     │
│ • Latency: < 50ms per page            │ │ • Token Usage: Metered usage  │
│ • Errors: UNSUPPORTED_FORMAT,         │ │ • Latency: 500ms - 15,000ms   │
│   PARSE_ERROR                         │ │ • Errors: PROVIDER_TIMEOUT,   │
│ • Provenance: native_parse            │ │   SCHEMA_VIOLATION            │
│ • Memory Bounds: Streaming / bounded  │ │ • Provenance: llm_extraction, │
│   buffers (< 32MB default limit)      │ │   llm_reasoning               │
└───────────────────────────────────────┘ └───────────────────────────────┘
```

### 3.1. Native Engine Expectations (`document-kit`)
- **Ingest (`DOC-01-01`)**: Direct string passthrough or binary parsing of UTF-8 text, OpenXML DOCX, and XLSX. Produces normalized markdown structure without calling any external network service.
- **Ingest Split (`DOC-01-04`)**: Page-level slicing returning page ranges or artifact pointers.
- **Transform Convert (`DOC-04-01`)**: Local markup transcoders (Markdown to HTML/CSV). Output is deterministic string conversion with `tokens: 0`.
- **Compare Diff (`DOC-06-01`)**: Local Myers diff algorithm returning line-level additions, deletions, and unchanged chunks. Zero LLM cost.

### 3.2. Provider Reasoning Expectations (`connector`)
- **Structured Extraction (`DOC-02-01..05`)**: Enforces JSON Schema validation. Upstream responses that do not match expected schemas or omit mandatory fields (such as `merchantName` in receipts) fail validation with `SCHEMA_VIOLATION`.
- **Token Accounting**: Every provider-backed variant emits token usage (`inputTokens`, `outputTokens`, `costMicrousd`) reported via the usage ledger.
- **Graceful Error Taxonomy**: Handlers map HTTP 429 to `RATE_LIMIT_EXCEEDED`, 503 to `PROVIDER_UNAVAILABLE`, and invalid payloads to `PROVIDER_INVALID_RESPONSE`.

---

## 4. Original 28-Variant Fixture Dictionary (historical baseline)

The fixture examples below record the original 28-case P0-05 baseline. The executable matrix now has 31 entries, including `id-card`, `fact-check` and `summarize-eval`; use [variant-matrix.md](variant-matrix.md) and `tests/all-variants-e2e.test.ts` for the current inventory.

### Action 1: Ingest (`DOC-01`)
- **`DOC-01-01` (parse)**:
  - *Input*: `{ mode: 'parse', text: 'Sample document text for ingestion' }`
  - *Engine*: Native.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { text: '...', markdown: '...', metadata: { detectedFormat: 'txt', parser: 'inline-text', provenance: 'native_parse' } } }`
- **`DOC-01-02` (ocr)**:
  - *Input*: `{ mode: 'ocr', imageBase64: 'synthetic-base64-image' }`
  - *Engine*: Provider (vision/OCR).
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { text: 'Synthetic OCR extracted text', confidence: 0.95, boundingBoxes: [...] } }`
- **`DOC-01-03` (digitize)**:
  - *Input*: `{ mode: 'digitize', formImageBase64: 'synthetic-form-bytes' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { fields: { formId: 'FORM-SYNTH-01', applicantName: 'Jane Doe', submissionDate: '2026-03-31' } } }`
- **`DOC-01-04` (split)**:
  - *Input*: `{ mode: 'split', pageCount: 10, splitRanges: ['1-5', '6-10'] }`
  - *Engine*: Native.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { parts: [{ range: '1-5', pageCount: 5 }, { range: '6-10', pageCount: 5 }] } }`

### Action 2: Extract (`DOC-02`)
- **`DOC-02-01` (invoice)**:
  - *Input*: `{ type: 'invoice', text: 'Invoice INV-2026-001 from Acme Corp for $4200.00 due on 2026-04-15' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { invoiceNumber: 'INV-2026-001', totalAmount: 4200, currency: 'USD', vendorName: 'Acme Corp', dueDate: '2026-04-15' } }`
- **`DOC-02-02` (contract)**:
  - *Input*: `{ type: 'contract', text: 'Master Services Agreement between Alpha LLC and Beta Inc effective 2026-01-01' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { parties: ['Alpha LLC', 'Beta Inc'], effectiveDate: '2026-01-01', agreementType: 'Master Services Agreement' } }`
- **`DOC-02-03` (receipt)**:
  - *Input*: `{ type: 'receipt', text: 'Store #42 - Coffee Shop, Total $8.50, Date 2026-03-20' }`
  - *Engine*: Provider (requires validated `merchantName`, `totalAmount`, `items`).
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { merchantName: 'Store #42 - Coffee Shop', totalAmount: 8.5, items: [{ name: 'Espresso', price: 4.25, quantity: 2 }], date: '2026-03-20' } }`
- **`DOC-02-04` (table)**:
  - *Input*: `{ type: 'table', text: '| Product | Qty | Price |\n| Widget A | 10 | $5.00 |' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { tables: [{ headers: ['Product', 'Qty', 'Price'], rows: [['Widget A', '10', '$5.00']] }] } }`
- **`DOC-02-05` (custom)**:
  - *Input*: `{ type: 'custom', text: 'User ID: usr_123, Role: Administrator', schema: { type: 'object', properties: { userId: { type: 'string' }, role: { type: 'string' } }, required: ['userId', 'role'] } }`
  - *Engine*: Provider (strict schema conformance).
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { userId: 'usr_123', role: 'Administrator' } }`

### Action 3: Analyze (`DOC-03`)
- **`DOC-03-01` (classify)**:
  - *Input*: `{ task: 'classify', categories: ['invoice', 'contract', 'report'], text: 'This Agreement is entered into by and between...' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { category: 'contract', confidence: 0.98, reasoning: 'Contains agreement preamble clauses' } }`
- **`DOC-03-02` (sentiment)**:
  - *Input*: `{ task: 'sentiment', text: 'The new gateway architecture has drastically simplified our pipeline reliability!' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { sentiment: 'positive', score: 0.92, summary: 'Highly favorable assessment of system reliability' } }`
- **`DOC-03-03` (compliance)**:
  - *Input*: `{ task: 'compliance', criteria: ['gdpr_retention', 'pci_masking'], text: 'Personal records are stored indefinitely with raw credit card numbers.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { compliant: false, violations: ['gdpr_retention: indefinite retention prohibited', 'pci_masking: unmasked PAN detected'] } }`
- **`DOC-03-04` (quality)**:
  - *Input*: `{ task: 'quality', text: 'Draft specification with missing acronym definitions and broken cross-references.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { qualityScore: 68, readabilityGrade: 'B', issues: ['Missing acronym definitions', 'Broken cross-references'] } }`
- **`DOC-03-05` (risk)**:
  - *Input*: `{ task: 'risk', text: 'Limitation of liability is uncapped for indirect and consequential damages.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { riskLevel: 'HIGH', identifiedRisks: ['Uncapped consequential damages liability'] } }`

### Action 4: Transform (`DOC-04`)
- **`DOC-04-01` (convert)**:
  - *Input*: `{ variant: 'convert', text: '# Executive Summary\n\nAll systems operational.', outputFormat: 'html' }`
  - *Engine*: Native.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { converted: '<h1>Executive Summary</h1>\n<p>All systems operational.</p>', format: 'html' } }`
- **`DOC-04-02` (translate)**:
  - *Input*: `{ variant: 'translate', targetLanguage: 'vi', text: 'The Document Understanding Gateway operates reliably under high concurrency.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { translatedText: 'Cổng Gateway Thấu hiểu Tài liệu hoạt động đáng tin cậy dưới mức đồng thời cao.', targetLanguage: 'vi' } }`
- **`DOC-04-03` (rewrite)**:
  - *Input*: `{ variant: 'rewrite', style: 'executive', text: 'We gotta fix the broken servers fast before things go down hard.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { rewrittenText: 'Immediate remediation of server infrastructure is required to prevent service disruption.', style: 'executive' } }`
- **`DOC-04-04` (redact)**:
  - *Input*: `{ variant: 'redact', text: 'Contact admin at support@example.com or call 555-0199 for help.', redactPatterns: ['email', 'phone'] }`
  - *Engine*: Native regex masking.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { redactedText: 'Contact admin at [REDACTED:EMAIL] or call [REDACTED:PHONE] for help.', redactCount: 2 } }`
- **`DOC-04-05` (template)**:
  - *Input*: `{ variant: 'template', text: 'Hello {{name}}, your balance of {{balance}} is due on {{date}}.', template: 'mustache', variables: { name: 'Alice', balance: '$250', date: '2026-04-01' } }`
  - *Engine*: Native template interpolation.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { renderedText: 'Hello Alice, your balance of $250 is due on 2026-04-01.' } }`

### Action 5: Generate (`DOC-05`)
- **`DOC-05-01` (summary)**:
  - *Input*: `{ task: 'summary', text: 'Comprehensive 50-page document discussing distributed systems, eventual consistency, and Paxos consensus.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { summary: 'Analysis of consensus protocols and fault-tolerant distributed system architectures.', keyPoints: ['Eventual consistency trade-offs', 'Paxos leader election mechanics'] } }`
- **`DOC-05-02` (outline)**:
  - *Input*: `{ task: 'outline', text: 'Raw engineering documentation on database migration strategies.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { outline: ['1. Overview', '2. Pre-migration Zero-Downtime Replication', '3. Cutover Sequence', '4. Fallback Runbook'] } }`
- **`DOC-05-03` (report)**:
  - *Input*: `{ task: 'report', text: 'Telemetry logs indicating 99.99% uptime, 42ms p99 latency, and zero data loss over 30 days.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { title: 'Service Health Monthly Assessment', sections: [{ heading: 'Key Metrics', content: '99.99% uptime observed across all regions.' }] } }`
- **`DOC-05-04` (email)**:
  - *Input*: `{ task: 'email', text: 'Release v1.2.0 is successfully deployed with zero regression and passing G0 gate.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { subject: 'Release Notification: v1.2.0 Deployment Successful', body: 'Team, v1.2.0 has been deployed with all gates verified.' } }`
- **`DOC-05-05` (minutes)**:
  - *Input*: `{ task: 'minutes', text: 'Architecture sync attended by Alice, Bob, and Carol on 2026-03-23. Decisions: adopt isolation harness.' }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { attendees: ['Alice', 'Bob', 'Carol'], decisions: ['Adopt isolation harness for all worker suites'], actionItems: [{ owner: 'Bob', task: 'Migrate runtime test suite' }] } }`
- **`DOC-05-06` (qa)**:
  - *Input*: `{ task: 'qa', text: 'The gateway listens on port 3000 and uses Redis for task queues.', questions: ['What port does the gateway use?', 'What queue backend is used?'] }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { answers: [{ question: 'What port does the gateway use?', answer: 'Port 3000' }, { question: 'What queue backend is used?', answer: 'Redis' }] } }`

### Action 6: Compare (`DOC-06`)
- **`DOC-06-01` (diff)**:
  - *Input*: `{ mode: 'diff', source: { text: 'Alpha Bravo Charlie' }, target: { text: 'Alpha Charlie Delta' } }`
  - *Engine*: Native.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { diff: [{ type: 'equal', value: 'Alpha ' }, { type: 'delete', value: 'Bravo ' }, { type: 'equal', value: 'Charlie' }, { type: 'insert', value: ' Delta' }], changeCount: 2 } }`
- **`DOC-06-02` (semantic)**:
  - *Input*: `{ mode: 'semantic', source: { text: 'Payment is due within thirty days.' }, target: { text: 'Invoices must be settled no later than 30 calendar days from receipt.' } }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { semanticMatch: true, similarityScore: 0.96, explanation: 'Both clauses prescribe identical 30-day payment windows with minor wording variation.' } }`
- **`DOC-06-03` (version)**:
  - *Input*: `{ mode: 'version', source: { text: 'Clause 1: Scope\nClause 2: Compensation' }, target: { text: 'Clause 1: Scope\nClause 2: Compensation\nClause 3: Indemnification' } }`
  - *Engine*: Provider.
  - *Expected Envelope*: `{ status: 'COMPLETED', data: { changes: [{ clause: 'Clause 3: Indemnification', changeType: 'ADDED', impact: 'Substantive' }] } }`

---

## 5. Machine Derivation Methodology

A foundational requirement of deliverable **P0-05** is the prohibition against hypothetical, fabricated, or guessed expected outputs.

### Derivation Execution Chain
1. **Runner (original P0-05 baseline)**: The original 28 test cases were fed through `documentCoreHandlers` instantiated with standard dependencies (`StubConnectorGateway`, `TestFixtures`). Current source declares 31 cases; this historical derivation note is not a current test receipt.
2. **Offline Mock Boundary**: The provider boundary returned deterministic mock envelopes strictly conforming to the action schemas.
3. **Envelope Capture**: Real execution output envelopes—including exact structure, metadata, provenance objects, and warnings arrays—were captured directly into `tests/fixtures/expected-result-corpus.ts`.
4. **Zero Hand Approximations**: Every field, nested object, and status attribute in `EXPECTED_RESULT_CORPUS` reflects the actual output produced by the codebase under test.

---

## 6. Verification Commands & Acceptance Gate

To verify the test fixture specification and expected result corpus:

```bash
# 1. Type-check test fixtures and corpus
pnpm --filter @du/document-core run test:typecheck

# 2. Verify synthetic fixtures standalone
npx jest tests/helpers/synthetic-fixtures.test.ts

# 3. Verify the current 31-variant matrix against the mock boundary
npx jest tests/all-variants-e2e.test.ts
```

The earlier P0-05 evidence covered 28 variants. The current `all-variants-e2e.test.ts` source enumerates 31; run the command above and record its result before claiming current-build 31/31 verification. The offline suite does not use a real database or Redis.
