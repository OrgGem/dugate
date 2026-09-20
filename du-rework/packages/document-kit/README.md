# @du/document-kit — Native Document Understanding Kit

`@du/document-kit` provides pure, native in-memory document parsing, format conversion, PDF manipulation, and archive extraction utilities for business workers in the DUGate platform.

## Features & Modules

### 1. Format Detection (`DocumentFormatDetector`)
- Fast magic-byte sniffing and fallback filename extension matching.
- Supported formats: `pdf`, `docx`, `xlsx`, `txt`, `md`, `html`, `csv`, `json`, `png`, `jpeg`, `tiff`, `zip`.
- Returns mime type, detected format, and confidence metrics.

### 2. Parsers (`factory`, `text-parser`, `word-parser`, `excel-parser`, `pdf-parser`)
- **WordParser**: Native DOCX extraction via Mammoth with fallback plain text extraction; converts to structured text and Markdown.
- **ExcelParser**: Native XLSX/XLS parsing via SheetJS/xlsx; extracts tabular rows, cell coordinates, and formatted Markdown tables.
- **PdfParser**: Native PDF text and page extraction via pdf-lib and PDF.js; provides page count and text streams.
- **TextParser**: Handles plaintext, Markdown, HTML, CSV, and JSON with line normalization and encoding detection.
- **defaultParserFactory**: Automated format detection and parser dispatch for arbitrary document buffers.

### 3. PDF Splitting (`PdfSplitter`)
- Real PDF slicing using `pdf-lib ^1.17.1`.
- Expression parsing for page ranges: `'1-3'`, `'1,3,5'`, `'2-'`, `'all'`.
- Generates valid, standards-compliant PDF slice artifacts with zero truncation.

### 4. Archive Extraction (`ZipExtractor`)
- Safe ZIP archive unpacking using adm-zip.
- **Security Protections**:
  - Path traversal defense: blocks zip slip attacks (`../`, absolute paths).
  - Zip bomb defense: enforces maximum extraction size bounds (`maxSizeBytes`, default 50 MB) and max entry counts (`maxEntries`, default 1000).

### 5. Converters & Processing Engines
- **DiffEngine**: Lexical line-by-line and word diffing with change statistics and unified diff output.
- **FormatConverter**: In-memory text, markdown, HTML, and JSON transformations.
- **PiiRedactor**: Regex-based detection and masking for sensitive patterns (emails, phone numbers, credit card numbers, SSNs, IP addresses).
- **TemplateEngine**: Variable substitution and template rendering.
- **TextChunker**: Bounded document chunking (size-based, paragraph-based, sentence-based) with overlap support and zero silent truncation.

## Build & Test

```bash
# Build TypeScript to dist/
npm run build

# Run unit tests (46 tests across 5 suites)
npm test
```

## Architectural Boundaries

- **No Platform Secrets**: `document-kit` never handles API keys, bearer tokens, or platform credentials.
- **No Direct Network I/O**: Operates purely on provided `Buffer` or `string` data in-memory.
- **No Direct Database Access**: Pure computational and parsing library.
- **Shared by Business Workers**: Imported as a dependency by `@du/document-core` to perform deterministic local document extraction and transformation.
