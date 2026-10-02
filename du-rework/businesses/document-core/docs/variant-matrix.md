# 31-Variant Case Matrix — document-core

This matrix defines the complete inventory of 31 functional variants supported by the `document-core` business image, specifying the discriminator, required inputs, connector slot dependencies, output structures, and corresponding test catalog IDs.

Total Variants: **31**
- **Ingest**: 4 variants (`parse`, `ocr`, `digitize`, `split`)
- **Extract**: 6 variants (`invoice`, `contract`, `id-card`, `receipt`, `table`, `custom`)
- **Analyze**: 7 variants (`classify`, `sentiment`, `compliance`, `fact-check`, `quality`, `risk`, `summarize-eval`)
- **Transform**: 5 variants (`convert`, `translate`, `rewrite`, `redact`, `template`)
- **Generate**: 6 variants (`summary`, `outline`, `report`, `email`, `minutes`, `qa`)
- **Compare**: 3 variants (`diff`, `semantic`, `version`)

---

## 1. Action: Ingest (4 Variants) — Test Catalog DOC-01

| Test ID | Variant (`mode`) | Primary Inputs | Connector Slot | Processing Type | Expected Output Structure | Failure Cases |
|---|---|---|---|---|---|---|
| `DOC-01-v1` | `parse` | `artifactIds` (PDF/DOCX/XLSX), `language?`, `outputFormat?` | None (pure local) | Local native parser via `document-kit` | `DocumentContent` with text, markdown, page/sheet metadata | Invalid file format, corrupted PDF/DOCX, encrypted document |
| `DOC-01-v2` | `ocr` | `artifactIds` (Image/PDF Scan), `language?` | `ocr` | Upstream OCR connector adapter | `DocumentContent` with text, markdown, page blocks, confidence | Unreadable scan, empty image, provider timeout |
| `DOC-01-v3` | `digitize` | `artifactIds` (Handwritten form, skewed scan) | `vision` / `ocr` | Vision reader model | Structured form key-values, checkbox states, normalized text | Blurry image, unsupported form layout, provider error |
| `DOC-01-v4` | `split` | `artifactIds` (PDF), `pages` (e.g. `"1-3,5"`) | None (pure local) | Local PDF split via `document-kit` | Array of newly generated `ArtifactRef` for split parts | Out-of-bounds page range, non-PDF file, negative page |

---

## 2. Action: Extract (6 Variants) — Test Catalog DOC-02

| Test ID | Variant (`type`) | Primary Inputs | Connector Slot | Processing Type | Expected Output Structure | Failure Cases |
|---|---|---|---|---|---|---|
| `DOC-02-v1` | `invoice` | `artifactIds` or `text` | `reasoning` | LLM Extraction | `InvoiceData`: supplier, taxId, buyer, invoiceNumber, lineItems[], subtotal, vat, total | Missing required fields, unreadable amounts, malformed JSON |
| `DOC-02-v2` | `contract` | `artifactIds` or `text` | `reasoning` | LLM Extraction | `ContractData`: parties (partyA, partyB), effectiveDate, expiryDate, value, penaltyClauses[], governingLaw | Unstructured text, missing parties, invalid JSON |
| `DOC-02-v2a` | `id-card` | `artifactIds` or `text` (CCCD/hộ chiếu scan) | `reasoning` (thường kèm `ocr`) | LLM Extraction trên tài liệu định danh | `IdCardData`: documentType (cccd/passport), fullName, dateOfBirth, sex, placeOfBirth, nationality, idNumber, expiryDate?, address? | Chất lượng scan thấp, trường bị che, không đọc được số định danh, định dạng không hợp lệ |
| `DOC-02-v2b` | `receipt` | `artifactIds` or `text` | `reasoning` | LLM Extraction | `ReceiptData`: merchantName, date, items[], paymentMethod, totalAmount | Blurry receipt text, invalid date format, missing total |
| `DOC-02-v2c` | `table` | `artifactIds` or `text` | `reasoning` | LLM Extraction | `TableData`: tables[] (headers[], rows[][], caption?) | No tables found, inconsistent column counts |
| `DOC-02-v2d` | `custom` | `artifactIds` or `text`, `fields?`, `schema?` | `reasoning` | Dynamic Schema Extraction | Custom JSON object validated against provided `schema` or `fields` | Invalid JSON Schema, schema depth > 5, network `$ref`, schema mismatch |

---

## 3. Action: Analyze (7 Variants) — Test Catalog DOC-03

| Test ID | Variant (`task`) | Primary Inputs | Connector Slot | Processing Type | Expected Output Structure | Failure Cases |
|---|---|---|---|---|---|---|
| `DOC-03-v1` | `classify` | `artifactIds` or `text`, `categories` | `reasoning` | Classification LLM | `ClassificationResult`: category, confidence, reasoning, secondaryCategories[] | Empty categories array, document matches none with low confidence |
| `DOC-03-v2` | `sentiment` | `artifactIds` or `text` | `reasoning` | Sentiment LLM | `SentimentResult`: sentiment (`positive`/`negative`/`neutral`/`mixed`), score (-1 to 1), explanation | Empty document text, ambiguous content |
| `DOC-03-v3` | `compliance` | `artifactIds` or `text`, `criteria`, `referenceData?` | `reasoning` | Compliance Audit LLM | `ComplianceResult`: status (`PASS`/`FAIL`), score, violations[] (rule, quote, severity) | Missing criteria parameter, malformed reference JSON |
| `DOC-03-v3a` | `fact-check` | `artifactIds` or `text`, `criteria`, `referenceData` | `reasoning` | Đối chiếu khẳng định trong tài liệu với dữ liệu tham chiếu | `FactCheckResult`: claims[] (claim, verdict `SUPPORTED`/`CONTRADICTED`/`UNVERIFIED`, evidence[], quote, referenceSpan?) | Thiếu `referenceData`, reference không parse được, claim không tìm thấy trong tài liệu |
| `DOC-03-v3b` | `summarize-eval` | `artifactIds` or `text`, `criteria?` | `reasoning` | Tóm tắt và chấm điểm bản tóm tắt theo tiêu chí | `SummaryEvalResult`: summary, evaluation (scores by criterion, verdict), sourceCoverage | Văn bản quá ngắn không tóm tắt được, tiêu chí đánh giá rỗng |
| `DOC-03-v4` | `quality` | `artifactIds` or `text`, `criteria?` | `reasoning` | Quality Evaluation LLM | `QualityResult`: overallScore, grammarScore, clarityScore, logicScore, suggestions[] | Empty document, provider evaluation timeout |
| `DOC-03-v5` | `risk` | `artifactIds` or `text` | `reasoning` | Legal/Operational Risk LLM | `RiskResult`: riskLevel (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`), risks[] (type, description, clauseReference, severity) | Missing contract text, malformed risk taxonomy |

---

## 4. Action: Transform (5 Variants) — Test Catalog DOC-04

| Test ID | Variant (`variant` / `action`) | Primary Inputs | Connector Slot | Processing Type | Expected Output Structure | Failure Cases |
|---|---|---|---|---|---|---|
| `DOC-04-v1` | `convert` | `artifactIds` or `text`, `outputFormat` | None (pure local) | Local Converter (`document-kit`) | `TransformResult`: contentRef, outputFormat (`md`/`html`/`csv`/`json`) | Unsupported format conversion (e.g. image to csv), corrupted input |
| `DOC-04-v2` | `translate` | `artifactIds` or `text`, `targetLanguage`, `tone?` | `reasoning` | Translation LLM | `TransformResult`: contentRef with translated text in requested language | Missing targetLanguage, unsupported language code |
| `DOC-04-v3` | `rewrite` | `artifactIds` or `text`, `style`, `tone?` | `reasoning` | Paraphrasing LLM | `TransformResult`: contentRef with rewritten text matching style (`academic`/`executive`/etc.) | Missing text, unknown style option |
| `DOC-04-v4` | `redact` | `artifactIds` or `text`, `redactPatterns?` | `reasoning` / Local Regex | PII Masking Engine | `TransformResult`: redactedText with `[REDACTED]` tokens, countByPattern | Corrupted input, unsupported pattern syntax |
| `DOC-04-v5` | `template` | `artifactIds` or `text`, `template` | None / Local Engine | Template Interpolation | `TransformResult`: populated document text/html | Missing template string, unmatched mandatory variables |

---

## 5. Action: Generate (6 Variants) — Test Catalog DOC-05

| Test ID | Variant (`task`) | Primary Inputs | Connector Slot | Processing Type | Expected Output Structure | Failure Cases |
|---|---|---|---|---|---|---|
| `DOC-05-v1` | `summary` | `artifactIds` or `text`, `format?`, `maxWords?` | `reasoning` | Summarization LLM | `GenerationResult`: summaryText, keyPoints[], wordCount | Empty document text, negative maxWords |
| `DOC-05-v2` | `outline` | `artifactIds` or `text`, `format?` | `reasoning` | Outline Extraction LLM | `GenerationResult`: outline (hierarchical H1/H2/H3 items) | Text too brief for outline, unstructured output |
| `DOC-05-v3` | `report` | `artifactIds` or `text`, `audience?`, `tone?` | `reasoning` | Report Synthesis LLM | `GenerationResult`: executiveSummary, sections[], conclusions | Provider fails to generate structured sections |
| `DOC-05-v4` | `email` | `artifactIds` or `text`, `tone?` | `reasoning` | Email Drafting LLM | `GenerationResult`: subject, greeting, body, signoff, followUpItems[] | Missing core message context, provider failure |
| `DOC-05-v5` | `minutes` | `artifactIds` or `text`, `format?` | `reasoning` | Meeting Minutes LLM | `GenerationResult`: meetingDate, attendees[], agendaItems[], decisions[], actionItems[] | Unstructured audio transcript, missing action item owners |
| `DOC-05-v6` | `qa` | `artifactIds` or `text`, `questions` | `reasoning` | Document QA LLM | `GenerationResult`: answers[] (question, answer, evidenceQuote, confidence) | Empty questions list, more than 20 questions cap exceeded |

---

## 6. Action: Compare (3 Variants) — Test Catalog DOC-06

| Test ID | Variant (`mode`) | Primary Inputs | Connector Slot | Processing Type | Expected Output Structure | Failure Cases |
|---|---|---|---|---|---|---|
| `DOC-06-v1` | `diff` | `source` (artifact or text), `target` (artifact or text), `outputFormat?` | None (pure local) | Local Line/Word Diff (`document-kit`) | `ComparisonResult`: stats (additions, deletions, changes), hunks[] (lineNo, type, content) | Missing source or target side, binary unreadable file |
| `DOC-06-v2` | `semantic` | `source`, `target`, `focus?` | `reasoning` | Semantic Diff LLM | `ComparisonResult`: semanticChanges[] (clause, sourceMeaning, targetMeaning, legalImpact), summary | Missing side, focus area not found in either doc |
| `DOC-06-v3` | `version` | `source`, `target`, `outputFormat?` | `reasoning` | Changelog Synthesis LLM | `ComparisonResult`: versionSummary, addedFeatures[], modifiedClauses[], removedItems[] | Both sides identical (empty changelog returned gracefully), missing input side |
