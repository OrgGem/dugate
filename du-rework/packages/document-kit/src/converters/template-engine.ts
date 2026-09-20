/**
 * Pure local template engine supporting {{placeholder}} and {{nested.key}} variable interpolation.
 */
export class TemplateEngine {
  public static render(
    templateText: string,
    variables: Record<string, unknown>
  ): { rendered: string; missingVariables: string[] } {
    const missing: Set<string> = new Set();

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

  private static resolvePath(obj: Record<string, unknown>, path: string): unknown {
    const segments = path.split('.');
    let current: unknown = obj;

    for (const seg of segments) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[seg];
    }

    return current;
  }
}
