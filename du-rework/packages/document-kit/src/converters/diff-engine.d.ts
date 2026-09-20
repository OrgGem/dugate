import { DiffResult } from '../types';
/**
 * Pure local text diff engine implementing line-by-line comparison with additions, deletions, and line numbers.
 */
export declare class DiffEngine {
    static computeDiff(sourceText: string, targetText: string): DiffResult;
    private static computeLcsMatrix;
}
//# sourceMappingURL=diff-engine.d.ts.map