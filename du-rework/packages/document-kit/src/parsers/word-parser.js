"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WordParser = void 0;
const zip_extractor_1 = require("../archives/zip-extractor");
class WordParser {
    name = 'WordParser';
    canHandle(formatInfo) {
        return ['docx', 'doc'].includes(formatInfo.format);
    }
    async parse(fileBuffer, fileName) {
        const warnings = [];
        // 1. Direct OpenXML extraction via SafeArchiveExtractor (supports rich markdown tables)
        try {
            const archiveResult = await zip_extractor_1.SafeArchiveExtractor.extractBuffer(fileBuffer);
            const docXmlEntry = archiveResult.entries.find((e) => e.path === 'word/document.xml' || e.path.endsWith('/document.xml'));
            if (docXmlEntry && docXmlEntry.content) {
                const xmlContent = docXmlEntry.content.toString('utf8');
                const extracted = this.extractContentFromWordXml(xmlContent);
                const wordCount = extracted.text.trim().split(/\s+/).filter(Boolean).length;
                return {
                    text: extracted.text,
                    markdown: extracted.markdown,
                    metadata: {
                        wordCount,
                        characterCount: extracted.text.length,
                        detectedFormat: 'docx',
                        parser: 'word-xml',
                        provenance: 'native_parse',
                    },
                    warnings,
                };
            }
        }
        catch (zipErr) {
            const msg = zipErr instanceof Error ? zipErr.message : String(zipErr);
            warnings.push(`Direct XML extraction failed: ${msg}`);
        }
        // 2. Fallback to mammoth if installed
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mammoth = require('mammoth');
            if (mammoth && typeof mammoth.extractRawText === 'function') {
                const textResult = (await Promise.race([
                    mammoth.extractRawText({ buffer: fileBuffer }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Mammoth extraction timed out')), 500)),
                ]));
                const text = textResult.value || '';
                const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
                return {
                    text,
                    markdown: text,
                    metadata: {
                        wordCount,
                        characterCount: text.length,
                        detectedFormat: 'docx',
                        parser: 'mammoth',
                        provenance: 'native_parse',
                        customMetadata: {
                            mammothMessages: textResult.messages,
                        },
                    },
                    warnings: textResult.messages.map((m) => m.message),
                };
            }
        }
        catch {
            warnings.push('Mammoth library not available or timed out');
        }
        throw new Error(`Unable to parse Word document "${fileName || 'document'}": parser error. Warnings: ${warnings.join('; ')}`);
    }
    extractContentFromWordXml(xml) {
        const textBlocks = [];
        const markdownBlocks = [];
        // Parse tables (<w:tbl>) and standalone paragraphs (<w:p>)
        const blockRegex = /<w:(tbl|p)(?:\s+[^>]*)?>([\s\S]*?)<\/w:\1>/g;
        let match;
        while ((match = blockRegex.exec(xml)) !== null) {
            const type = match[1];
            const content = match[2];
            if (!type || !content)
                continue;
            if (type === 'p') {
                const textParts = [];
                const tRegex = /<w:t(?:\s+[^>]*)?>([^<]*)<\/w:t>/g;
                let tMatch;
                while ((tMatch = tRegex.exec(content)) !== null) {
                    if (tMatch[1]) {
                        textParts.push(tMatch[1]);
                    }
                }
                const paragraph = textParts.join('').trim();
                if (paragraph) {
                    textBlocks.push(paragraph);
                    markdownBlocks.push(paragraph);
                }
            }
            else if (type === 'tbl') {
                // Table parsing
                const rows = [];
                const trRegex = /<w:tr(?:\s+[^>]*)?>([\s\S]*?)<\/w:tr>/g;
                let trMatch;
                while ((trMatch = trRegex.exec(content)) !== null) {
                    const rowContent = trMatch[1];
                    if (!rowContent)
                        continue;
                    const cells = [];
                    const tcRegex = /<w:tc(?:\s+[^>]*)?>([\s\S]*?)<\/w:tc>/g;
                    let tcMatch;
                    while ((tcMatch = tcRegex.exec(rowContent)) !== null) {
                        const cellContent = tcMatch[1];
                        if (!cellContent)
                            continue;
                        const cellTextParts = [];
                        const tRegex = /<w:t(?:\s+[^>]*)?>([^<]*)<\/w:t>/g;
                        let tMatch;
                        while ((tMatch = tRegex.exec(cellContent)) !== null) {
                            if (tMatch[1]) {
                                cellTextParts.push(tMatch[1]);
                            }
                        }
                        cells.push(cellTextParts.join('').trim());
                    }
                    if (cells.length > 0) {
                        rows.push(cells);
                    }
                }
                if (rows.length > 0) {
                    const maxCols = Math.max(...rows.map((r) => r.length));
                    const tableLines = [];
                    const headers = rows[0] || [];
                    const headerStr = Array.from({ length: maxCols }, (_, i) => headers[i] || `Col ${i + 1}`);
                    tableLines.push(`| ${headerStr.join(' | ')} |`);
                    tableLines.push(`| ${headerStr.map(() => '---').join(' | ')} |`);
                    for (let r = 1; r < rows.length; r++) {
                        const row = rows[r] || [];
                        const rowStr = Array.from({ length: maxCols }, (_, c) => row[c] || '');
                        tableLines.push(`| ${rowStr.join(' | ')} |`);
                    }
                    markdownBlocks.push(tableLines.join('\n'));
                    const textTable = rows.map((r) => r.join('\t')).join('\n');
                    textBlocks.push(textTable);
                }
            }
        }
        return {
            text: textBlocks.join('\n\n'),
            markdown: markdownBlocks.join('\n\n'),
        };
    }
}
exports.WordParser = WordParser;
//# sourceMappingURL=word-parser.js.map