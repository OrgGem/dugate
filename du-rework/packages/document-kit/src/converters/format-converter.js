"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FormatConverter = void 0;
/**
 * FormatConverter provides local conversion between text, markdown, HTML, and CSV formats.
 */
class FormatConverter {
    static convertText(sourceText, sourceFormat, targetFormat) {
        const src = sourceFormat.toLowerCase();
        const dst = targetFormat.toLowerCase();
        if (src === dst) {
            return sourceText;
        }
        if (dst === 'text' || dst === 'txt') {
            return this.stripFormatting(sourceText);
        }
        if (dst === 'md' || dst === 'markdown') {
            return sourceText; // Standard text is valid markdown
        }
        if (dst === 'html') {
            return this.markdownToSimpleHtml(sourceText);
        }
        if (dst === 'json') {
            return JSON.stringify({ content: sourceText });
        }
        throw new Error(`Unsupported conversion from "${sourceFormat}" to "${targetFormat}"`);
    }
    static stripFormatting(markdownOrHtml) {
        return markdownOrHtml
            .replace(/<[^>]*>/g, '') // Strip HTML tags
            .replace(/^#{1,6}\s+/gm, '') // Strip headers
            .replace(/\*\*([^*]+)\*\*/g, '$1') // Strip bold
            .replace(/\*([^*]+)\*/g, '$1') // Strip italic
            .replace(/`([^`]+)`/g, '$1') // Strip inline code
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Strip markdown links
            .trim();
    }
    static markdownToSimpleHtml(markdown) {
        const lines = markdown.split(/\r?\n/);
        const htmlLines = [];
        for (const line of lines) {
            if (line.startsWith('### ')) {
                htmlLines.push(`<h3>${this.escapeHtml(line.slice(4))}</h3>`);
            }
            else if (line.startsWith('## ')) {
                htmlLines.push(`<h2>${this.escapeHtml(line.slice(3))}</h2>`);
            }
            else if (line.startsWith('# ')) {
                htmlLines.push(`<h1>${this.escapeHtml(line.slice(2))}</h1>`);
            }
            else if (line.startsWith('- ')) {
                htmlLines.push(`<li>${this.escapeHtml(line.slice(2))}</li>`);
            }
            else if (line.trim().length === 0) {
                htmlLines.push('<br/>');
            }
            else {
                htmlLines.push(`<p>${this.escapeHtml(line)}</p>`);
            }
        }
        return htmlLines.join('\n');
    }
    static escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
exports.FormatConverter = FormatConverter;
//# sourceMappingURL=format-converter.js.map