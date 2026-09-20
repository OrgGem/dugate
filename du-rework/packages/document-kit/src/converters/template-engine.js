"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateEngine = void 0;
/**
 * Pure local template engine supporting {{placeholder}} and {{nested.key}} variable interpolation.
 */
class TemplateEngine {
    static render(templateText, variables) {
        const missing = new Set();
        const rendered = templateText.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, path) => {
            const val = this.resolvePath(variables, path);
            if (val === undefined || val === null) {
                missing.add(path);
                return match; // Leave unrendered
            }
            return String(val);
        });
        return {
            rendered,
            missingVariables: Array.from(missing),
        };
    }
    static resolvePath(obj, path) {
        const segments = path.split('.');
        let current = obj;
        for (const seg of segments) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = current[seg];
        }
        return current;
    }
}
exports.TemplateEngine = TemplateEngine;
//# sourceMappingURL=template-engine.js.map