"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TextParser = void 0;
class TextParser {
    name = 'TextParser';
    canHandle(formatInfo) {
        return ['txt', 'md'].includes(formatInfo.format);
    }
    async parse(fileBuffer, fileName) {
        const rawText = fileBuffer.toString('utf8');
        const wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
        const isMarkdown = fileName?.endsWith('.md') ?? false;
        return {
            text: rawText,
            markdown: isMarkdown ? rawText : this.wrapInMarkdown(rawText),
            metadata: {
                wordCount,
                characterCount: rawText.length,
                detectedFormat: isMarkdown ? 'md' : 'txt',
                parser: this.name,
                provenance: 'native_parse',
            },
            warnings: [],
        };
    }
    wrapInMarkdown(text) {
        return text;
    }
}
exports.TextParser = TextParser;
//# sourceMappingURL=text-parser.js.map