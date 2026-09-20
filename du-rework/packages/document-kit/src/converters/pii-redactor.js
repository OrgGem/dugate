"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiiRedactor = void 0;
class PiiRedactor {
    static DEFAULT_PATTERNS = [
        {
            name: 'EMAIL',
            regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
            mask: '[REDACTED:EMAIL]',
        },
        {
            name: 'CREDIT_CARD',
            regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
            mask: '[REDACTED:CREDIT_CARD]',
        },
        {
            name: 'NATIONAL_ID',
            regex: /\b\d{9,12}\b/g, // Covers 9-digit or 12-digit national IDs/CCCD
            mask: '[REDACTED:NATIONAL_ID]',
        },
        {
            name: 'PHONE',
            regex: /(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
            mask: '[REDACTED:PHONE]',
        },
        {
            name: 'IP_ADDRESS',
            regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
            mask: '[REDACTED:IP_ADDRESS]',
        },
    ];
    static redact(text, activePatternNames) {
        let result = text;
        let totalRedactions = 0;
        const countsByPattern = {};
        const patternsToUse = activePatternNames && activePatternNames.length > 0
            ? this.DEFAULT_PATTERNS.filter((p) => activePatternNames.includes(p.name))
            : this.DEFAULT_PATTERNS;
        for (const pattern of patternsToUse) {
            let matchCount = 0;
            result = result.replace(pattern.regex, () => {
                matchCount++;
                totalRedactions++;
                return pattern.mask;
            });
            if (matchCount > 0) {
                countsByPattern[pattern.name] = matchCount;
            }
        }
        return {
            redactedText: result,
            redactionsCount: totalRedactions,
            countsByPattern,
        };
    }
}
exports.PiiRedactor = PiiRedactor;
//# sourceMappingURL=pii-redactor.js.map