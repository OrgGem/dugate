/**
 * Pure local template engine supporting {{placeholder}} and {{nested.key}} variable interpolation.
 */
export declare class TemplateEngine {
    static render(templateText: string, variables: Record<string, unknown>): {
        rendered: string;
        missingVariables: string[];
    };
    private static resolvePath;
}
//# sourceMappingURL=template-engine.d.ts.map