// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/document-kit/src/converters/format-converter.ts (lines=78) sha256=1A7DB031E41EB8529E8BB5A6FB39D3BFA0276194ACACC8CDA79C1DB4486F03DA
// why: FormatConverter for src/actions/transform/index.ts

/**
 * FormatConverter provides local conversion between text, markdown, HTML, and CSV formats.
 */
export class FormatConverter {
  public static convertText(
    sourceText: string,
    sourceFormat: string,
    targetFormat: string
  ): string {
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

  public static stripFormatting(markdownOrHtml: string): string {
    return markdownOrHtml
      .replace(/<[^>]*>/g, '') // Strip HTML tags
      .replace(/^#{1,6}\s+/gm, '') // Strip headers
      .replace(/\*\*([^*]+)\*\*/g, '$1') // Strip bold
      .replace(/\*([^*]+)\*/g, '$1') // Strip italic
      .replace(/`([^`]+)`/g, '$1') // Strip inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Strip markdown links
      .trim();
  }

  public static markdownToSimpleHtml(markdown: string): string {
    const lines = markdown.split(/\r?\n/);
    const htmlLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('### ')) {
        htmlLines.push(`<h3>${this.escapeHtml(line.slice(4))}</h3>`);
      } else if (line.startsWith('## ')) {
        htmlLines.push(`<h2>${this.escapeHtml(line.slice(3))}</h2>`);
      } else if (line.startsWith('# ')) {
        htmlLines.push(`<h1>${this.escapeHtml(line.slice(2))}</h1>`);
      } else if (line.startsWith('- ')) {
        htmlLines.push(`<li>${this.escapeHtml(line.slice(2))}</li>`);
      } else if (line.trim().length === 0) {
        htmlLines.push('<br/>');
      } else {
        htmlLines.push(`<p>${this.escapeHtml(line)}</p>`);
      }
    }

    return htmlLines.join('\n');
  }

  private static escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
