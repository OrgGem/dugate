/**
 * TextChunker splits large text into bounded chunks with complete coverage,
 * ensuring no content is silently truncated or discarded.
 */
export declare class TextChunker {
    /**
     * Splits text into complete chunks up to maxChunkSize characters each.
     * Guarantees that the tail of the document is preserved and covered.
     */
    static splitIntoChunks(text: string, maxChunkSize?: number, overlap?: number): string[];
}
//# sourceMappingURL=text-chunker.d.ts.map