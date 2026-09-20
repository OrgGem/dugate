/**
 * FormatConverter provides local conversion between text, markdown, HTML, and CSV formats.
 */
export declare class FormatConverter {
    static convertText(sourceText: string, sourceFormat: string, targetFormat: string): string;
    static stripFormatting(markdownOrHtml: string): string;
    static markdownToSimpleHtml(markdown: string): string;
    private static escapeHtml;
}
//# sourceMappingURL=format-converter.d.ts.map