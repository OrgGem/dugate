/**
 * TextChunker splits large text into bounded chunks with complete coverage,
 * ensuring no content is silently truncated or discarded.
 */
export class TextChunker {
  /**
   * Splits text into complete chunks up to maxChunkSize characters each.
   * Guarantees that the tail of the document is preserved and covered.
   */
  public static splitIntoChunks(
    text: string,
    maxChunkSize: number = 4000,
    overlap: number = 0
  ): string[] {
    if (!text || text.trim().length === 0) return [];
    if (text.length <= maxChunkSize) return [text];

    const chunks: string[] = [];
    let startIndex = 0;
    const totalLen = text.length;

    while (startIndex < totalLen) {
      let endIndex = Math.min(startIndex + maxChunkSize, totalLen);

      // Attempt to split at a natural boundary (paragraph > line > sentence)
      if (endIndex < totalLen) {
        const slice = text.substring(startIndex, endIndex);
        const paragraphBreak = slice.lastIndexOf('\n\n');
        const lineBreak = slice.lastIndexOf('\n');
        const sentenceBreak = slice.lastIndexOf('. ');

        if (paragraphBreak > maxChunkSize * 0.5) {
          endIndex = startIndex + paragraphBreak + 2;
        } else if (lineBreak > maxChunkSize * 0.5) {
          endIndex = startIndex + lineBreak + 1;
        } else if (sentenceBreak > maxChunkSize * 0.5) {
          endIndex = startIndex + sentenceBreak + 2;
        }
      }

      const chunk = text.substring(startIndex, endIndex).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      if (endIndex >= totalLen) {
        break;
      }

      // Ensure forward progress even if overlap is requested
      const nextStart = endIndex - overlap;
      startIndex = nextStart > startIndex ? nextStart : endIndex;
    }

    return chunks;
  }
}
