// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/document-kit/src/converters/template-engine.ts (lines=39) sha256=3B89B5BDA6DE5172BC6B322E4C2511D181CF0F87DE51BC5B3E252B8178DA4497
// why: TemplateEngine for src/actions/transform/index.ts

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
