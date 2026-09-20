import { RedactionResult } from '../types';
export interface PiiPattern {
    name: string;
    regex: RegExp;
    mask: string;
}
export declare class PiiRedactor {
    private static readonly DEFAULT_PATTERNS;
    static redact(text: string, activePatternNames?: string[]): RedactionResult;
}
//# sourceMappingURL=pii-redactor.d.ts.map