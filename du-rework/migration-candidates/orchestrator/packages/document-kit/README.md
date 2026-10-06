# @du/document-kit — Native Document Understanding Kit

`@du/document-kit` provides pure, native in-memory document parsing, format conversion, PDF manipulation, and archive extraction utilities for business workers in the DUGate platform.

## Features & Modules

### 1. Format Detection (`DocumentFormatDetector`)
- Magic-byte sniffing first, then filename extension / MIME hint, then a UTF-8 text fallback.
- Supported formats: `pdf`, `docx`, `doc`, `xlsx`, `xls`, `txt`, `md`, `csv`, `zip`, `png`, `jpeg`, `tiff`, `webp`, `unknown`.
  `html`/`json` are **not** distinct formats — they fall through the text path as `txt`/`csv`.
- A ZIP is only reported as `docx`/`xlsx` when the archive actually contains `word/document.xml` /
  `xl/workbook.xml`; otherwise it stays `zip`. The caller-supplied MIME hint never
  upgrades a ZIP identity.
- Returns mime type, format, declared file name / MIME, and the `isBinary` /
  `isOfficeDocument` / `isImage` / `isArchive` flags. There is no confidence metric.

### 2. Parsers (`factory`, `text-parser`, `word-parser`, `excel-parser`, `pdf-parser`)
- **WordParser**: DOCX extraction via Mammoth when installed, with an XML fallback; converts to structured text and Markdown.
- **ExcelParser**: XLSX/XLS/CSV via SheetJS `xlsx`, with an XLSX-OpenXML archive fallback and a plain-text last resort; extracts tabular rows and formatted Markdown tables.
- **PdfParser**: Uses `pdf-lib` for page count only, then extracts readable text from `(...)Tj` operators with a byte-size placeholder fallback. It is **not** a full PDF text engine.
- **TextParser**: Plaintext, Markdown, CSV and JSON-shaped text with line normalization.
- **`defaultParserFactory`** (`DocumentParserFactory`): format detection + parser dispatch for arbitrary buffers.
- **`limits.ts` / `worker-isolation.ts`**: parsers validate options and, on the main thread, run inside a terminable worker thread with a CPU timeout.

### 3. PDF Splitting (`PdfSplitter`)
- Real PDF slicing using `pdf-lib ^1.17.1`.
- Page-expression parsing via `parsePageExpression()`: comma-separated numbers and
  ranges such as `'1-3,5,7-9'`. Results are deduplicated and sorted ascending.
  Open-ended forms like `'2-'` or the literal `'all'` are **not** supported.
  Out-of-range and non-positive page numbers throw.
- With `pdf-lib` available, slices are real page subsets. If `pdf-lib` is missing or
  errors, it falls back to a generated text-only PDF: the output is still a valid PDF, but
  non-text content (vector art, images) is not preserved on that path.

### 4. Archive Extraction (`SafeArchiveExtractor`)
- Hand-rolled ZIP reader built on `zlib.inflateRawSync` — **no** `adm-zip` / third-party archive dependency.
- **Fail-closed preflight before any parser is dispatched**, with bounded decompression and CRC verification:
  - Path traversal defense: blocks zip slip (`..`, absolute paths, Windows drive letters) via `validatePathSafety()`.
  - Zip bomb defense: `maxTotalSize` (default 50 MiB), `maxFileCount` (default 1000) and
    `maxDecompressionRatio` (default 100:1). Options are the real names — not `maxSizeBytes`/`maxEntries`.
  - ZIP64, data descriptors, encrypted entries and multi-disk archives are **rejected**, not tolerated.
  - Central-directory and local-header metadata must agree; duplicate entry paths fail.
  - Office archives must carry the expected marker entry (`word/document.xml` / `xl/workbook.xml`).
  - Verified results are cached per-buffer (WeakMap) so Office archives are not inflated twice.

### 5. Converters & Processing Engines
- **DiffEngine**: Lexical line-by-line and word diffing with change statistics and unified diff output.
- **FormatConverter**: In-memory text, markdown, HTML, and JSON transformations.
- **PiiRedactor**: Regex-based detection and masking for sensitive patterns (emails, phone numbers, credit card numbers, SSNs, IP addresses).
- **TemplateEngine**: Variable substitution and template rendering.
- **TextChunker**: Bounded document chunking (size-based, paragraph-based, sentence-based) with overlap support and zero silent truncation.

## Build & Test

```bash
# From the du-rework/ workspace root.
pnpm --filter @du/document-kit build
pnpm --filter @du/document-kit lint
pnpm --filter @du/document-kit test
```

Offline unit suite: **130 tests across 10 suites** (đo bằng `pnpm --filter @du/document-kit test`,
10/10 suite pass). Không cần DB/Redis/S3.

## Architectural Boundaries

- **No Platform Secrets**: `document-kit` never handles API keys, bearer tokens, or platform credentials.
- **No Direct Network I/O**: Operates purely on provided `Buffer` or `string` data in-memory.
- **No Direct Database Access**: Pure computational and parsing library.
- **Shared by Business Workers**: Imported as a workspace dependency by all three businesses — `@du/document-core`, `@du/example-review` and `@du/lc-checker` — for deterministic local document extraction and transformation.
