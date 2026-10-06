import { DiffHunk, DiffResult } from '../types';

/**
 * Pure local text diff engine implementing line-by-line comparison with additions, deletions, and line numbers.
 */
export class DiffEngine {
  public static computeDiff(sourceText: string, targetText: string): DiffResult {
    const sourceLines = sourceText.split(/\r?\n/);
    const targetLines = targetText.split(/\r?\n/);

    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    let unmodified = 0;

    const matrix = this.computeLcsMatrix(sourceLines, targetLines);
    let i = sourceLines.length;
    let j = targetLines.length;

    const reverseHunks: DiffHunk[] = [];

    while (i > 0 || j > 0) {
      const rowI = matrix[i];
      const rowPrev = matrix[i - 1];
      const leftVal = (rowI && rowI[j - 1]) ?? 0;
      const upVal = (rowPrev && rowPrev[j]) ?? 0;

      if (i > 0 && j > 0 && sourceLines[i - 1] === targetLines[j - 1]) {
        reverseHunks.push({
          type: 'EQUAL',
          content: sourceLines[i - 1] ?? '',
          sourceLineNumber: i,
          targetLineNumber: j,
        });
        unmodified++;
        i--;
        j--;
      } else if (j > 0 && (i === 0 || leftVal >= upVal)) {
        reverseHunks.push({
          type: 'ADD',
          content: targetLines[j - 1] ?? '',
          targetLineNumber: j,
        });
        additions++;
        j--;
      } else if (i > 0 && (j === 0 || leftVal < upVal)) {
        reverseHunks.push({
          type: 'DELETE',
          content: sourceLines[i - 1] ?? '',
          sourceLineNumber: i,
        });
        deletions++;
        i--;
      }
    }

    const orderedHunks = reverseHunks.reverse();

    const unifiedDiffLines: string[] = [
      '--- source',
      '+++ target',
    ];

    for (const hunk of orderedHunks) {
      if (hunk.type === 'ADD') {
        unifiedDiffLines.push(`+ ${hunk.content}`);
      } else if (hunk.type === 'DELETE') {
        unifiedDiffLines.push(`- ${hunk.content}`);
      } else {
        unifiedDiffLines.push(`  ${hunk.content}`);
      }
    }

    return {
      additionsCount: additions,
      deletionsCount: deletions,
      unmodifiedCount: unmodified,
      hunks: orderedHunks,
      unifiedDiff: unifiedDiffLines.join('\n'),
    };
  }

  private static computeLcsMatrix(a: string[], b: string[]): number[][] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      const currentRow = dp[i]!;
      const prevRow = dp[i - 1]!;
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          currentRow[j] = (prevRow[j - 1] ?? 0) + 1;
        } else {
          currentRow[j] = Math.max(prevRow[j] ?? 0, currentRow[j - 1] ?? 0);
        }
      }
    }

    return dp;
  }
}
