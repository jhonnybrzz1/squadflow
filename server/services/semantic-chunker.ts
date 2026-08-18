/**
 * Semantic Chunker
 *
 * Zero-dependency recursive character text splitter inspired by LangChain's
 * RecursiveCharacterTextSplitter. Splits text using a hierarchy of separators,
 * trying to keep semantically coherent units together.
 *
 * Separator priority:
 *   1. Markdown headers (## , ### )  — section boundaries
 *   2. Double newlines (\n\n)        — paragraph boundaries
 *   3. Single newlines (\n)          — line boundaries
 *   4. Sentences (. )                — sentence boundaries
 *   5. Clauses (, )                  — clause boundaries
 *   6. Words ( )                     — word boundaries
 *
 * Features:
 * - Configurable chunk size and overlap
 * - Generates hierarchical chunks (document → section → paragraph) for parent-child retrieval
 * - Metadata extraction (section headers, position)
 */

export interface ChunkOptions {
  /** Target chunk size in characters (default: 800) */
  chunkSize?: number;
  /** Overlap between chunks in characters (default: 150) */
  chunkOverlap?: number;
  /** Custom separators (default: markdown-aware hierarchy) */
  separators?: string[];
  /** Include section headers as metadata (default: true) */
  trackHeaders?: boolean;
}

export interface SemanticChunk {
  content: string;
  index: number;
  /** The section header this chunk belongs to */
  sectionHeader: string;
  /** Hierarchical level: 'document' | 'section' | 'paragraph' */
  level: 'document' | 'section' | 'paragraph';
  /** Parent chunk index (null for top-level) */
  parentIndex: number | null;
  /** Approximate token count */
  tokenEstimate: number;
  /** Character offset in original document */
  startOffset: number;
}

const DEFAULT_SEPARATORS = [
  '\n## ', // H2 headers
  '\n### ', // H3 headers
  '\n#### ', // H4 headers
  '\n\n', // Paragraphs
  '\n', // Lines
  '. ', // Sentences
  ', ', // Clauses
  ' ', // Words
];

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_OVERLAP = 150;

export class SemanticChunker {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];
  private trackHeaders: boolean;

  constructor(options: ChunkOptions = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkOverlap = options.chunkOverlap ?? DEFAULT_OVERLAP;
    this.separators = options.separators ?? DEFAULT_SEPARATORS;
    this.trackHeaders = options.trackHeaders ?? true;
  }

  /**
   * Split text into semantically coherent chunks.
   */
  splitText(text: string): string[] {
    return this.recursiveSplit(text, this.separators);
  }

  /**
   * Split text into rich chunks with metadata (headers, level, position).
   */
  chunkDocument(text: string): SemanticChunk[] {
    const sections = this.extractSections(text);
    const chunks: SemanticChunk[] = [];
    let globalIndex = 0;
    let globalOffset = 0;

    // Create section-level chunks first
    const sectionChunks: SemanticChunk[] = [];

    for (const section of sections) {
      const sectionContent = section.content;

      // If section fits in one chunk, keep it whole
      if (sectionContent.length <= this.chunkSize) {
        chunks.push({
          content: sectionContent,
          index: globalIndex,
          sectionHeader: section.header,
          level: 'paragraph',
          parentIndex: null, // Will be linked to section chunk
          tokenEstimate: this.estimateTokens(sectionContent),
          startOffset: globalOffset,
        });
        globalIndex++;
        globalOffset += sectionContent.length;
        continue;
      }

      // Split section into paragraph-level chunks
      const textChunks = this.recursiveSplit(sectionContent, this.separators);
      const paragraphIndices: number[] = [];

      for (const chunk of textChunks) {
        paragraphIndices.push(globalIndex);
        chunks.push({
          content: chunk,
          index: globalIndex,
          sectionHeader: section.header,
          level: 'paragraph',
          parentIndex: null, // Will be set below
          tokenEstimate: this.estimateTokens(chunk),
          startOffset: globalOffset,
        });
        globalIndex++;
        globalOffset += chunk.length;
      }

      // Create section-level parent chunk (summary of all paragraphs)
      if (paragraphIndices.length > 1) {
        const sectionChunk: SemanticChunk = {
          content: sectionContent.slice(0, this.chunkSize * 2), // Larger parent chunk
          index: globalIndex,
          sectionHeader: section.header,
          level: 'section',
          parentIndex: null,
          tokenEstimate: this.estimateTokens(sectionContent.slice(0, this.chunkSize * 2)),
          startOffset: section.offset,
        };
        sectionChunks.push(sectionChunk);

        // Link paragraphs to their section parent
        for (const pIdx of paragraphIndices) {
          chunks[pIdx - (chunks[0]?.index || 0)].parentIndex = globalIndex;
        }
        globalIndex++;
      }
    }

    // Append section-level chunks
    chunks.push(...sectionChunks);

    return chunks;
  }

  /**
   * Core recursive splitting algorithm.
   * Tries each separator in order; if a split produces chunks that are still too large,
   * recursively splits those with the next separator.
   */
  private recursiveSplit(text: string, separators: string[]): string[] {
    if (text.length <= this.chunkSize) {
      return text.trim() ? [text.trim()] : [];
    }

    if (separators.length === 0) {
      // Last resort: split by character with overlap
      return this.splitBySize(text);
    }

    const [separator, ...remainingSeparators] = separators;
    const parts = this.splitKeepSeparator(text, separator);

    const merged: string[] = [];
    let current = '';

    for (const part of parts) {
      const candidate = current ? current + part : part;

      if (candidate.length <= this.chunkSize) {
        current = candidate;
      } else {
        // Flush current if it has content
        if (current.trim()) {
          merged.push(current.trim());
        }

        // If this part alone is too large, recursively split it
        if (part.length > this.chunkSize) {
          const subChunks = this.recursiveSplit(part, remainingSeparators);
          merged.push(...subChunks);
          current = '';
        } else {
          current = part;
        }
      }
    }

    if (current.trim()) {
      merged.push(current.trim());
    }

    // Apply overlap between consecutive chunks
    if (this.chunkOverlap > 0 && merged.length > 1) {
      return this.applyOverlap(merged);
    }

    return merged;
  }

  /**
   * Split text by separator, keeping the separator attached to the next segment.
   */
  private splitKeepSeparator(text: string, separator: string): string[] {
    const parts = text.split(separator);
    if (parts.length <= 1) return [text];

    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) {
        result.push(parts[i]);
      } else {
        result.push(separator + parts[i]);
      }
    }
    return result.filter((p) => p.trim().length > 0);
  }

  /**
   * Fixed-size splitting as a last resort.
   */
  private splitBySize(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      if (end >= text.length) break;
      start += this.chunkSize - this.chunkOverlap;
    }
    return chunks;
  }

  /**
   * Add overlap between consecutive chunks by prepending the tail of the previous chunk.
   */
  private applyOverlap(chunks: string[]): string[] {
    if (this.chunkOverlap <= 0) return chunks;

    const result: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-this.chunkOverlap);
      // Only prepend overlap if it doesn't make the chunk too large
      const withOverlap = prevTail + ' ' + chunks[i];
      if (withOverlap.length <= this.chunkSize * 1.2) {
        result.push(withOverlap);
      } else {
        result.push(chunks[i]);
      }
    }
    return result;
  }

  /**
   * Extract sections from markdown-like content.
   */
  private extractSections(
    text: string,
  ): Array<{ header: string; content: string; offset: number }> {
    const lines = text.split('\n');
    const sections: Array<{ header: string; content: string; offset: number }> = [];
    let currentHeader = 'Seção principal';
    let buffer: string[] = [];
    let currentOffset = 0;
    let sectionStartOffset = 0;

    const flush = () => {
      const content = buffer.join('\n').trim();
      if (content) {
        sections.push({ header: currentHeader, content, offset: sectionStartOffset });
      }
      buffer = [];
    };

    for (const line of lines) {
      if (/^#{1,4}\s+/.test(line)) {
        flush();
        currentHeader = line.replace(/^#{1,4}\s+/, '').trim();
        sectionStartOffset = currentOffset;
      } else {
        buffer.push(line);
      }
      currentOffset += line.length + 1; // +1 for newline
    }

    flush();
    return sections;
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

/**
 * Default chunker instance with production settings.
 */
export const semanticChunker = new SemanticChunker({
  chunkSize: 800,
  chunkOverlap: 150,
});
