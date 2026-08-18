import type { PDFFont, PDFPage } from 'pdf-lib';

/**
 * Wraps text to fit within maxWidth using simple character count.
 * Fallback method when font metrics are not available.
 *
 * @param text - Text to wrap
 * @param maxWidth - Maximum width in points
 * @param font - Font for character width estimation
 * @param fontSize - Font size
 * @returns Array of wrapped lines
 */
export function wrapText(
  text: string,
  maxWidth: number,
  font: PDFFont,
  fontSize: number,
): string[] {
  const avgCharWidth = font.widthOfTextAtSize('x', fontSize);
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).length * avgCharWidth <= maxWidth) {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Wraps text using font metrics for accurate line breaking.
 *
 * @param text - Text to wrap
 * @param maxWidth - Maximum width in points
 * @param font - Font for measuring
 * @param fontSize - Font size
 * @returns Array of wrapped lines
 */
export function wrapTextByFontMetrics(
  text: string,
  maxWidth: number,
  font: PDFFont,
  fontSize: number,
): string[] {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (!normalizedText) return [''];

  const lines: string[] = [];
  let currentLine = '';

  for (const word of normalizedText.split(' ')) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
      currentLine = word;
    } else {
      const brokenWordLines = breakLongWord(word, maxWidth, font, fontSize);
      lines.push(...brokenWordLines.slice(0, -1));
      currentLine = brokenWordLines[brokenWordLines.length - 1] || '';
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Breaks a long word into chunks that fit within maxWidth.
 *
 * @param word - Word to break
 * @param maxWidth - Maximum width in points
 * @param font - Font for measuring
 * @param fontSize - Font size
 * @returns Array of word chunks
 */
export function breakLongWord(
  word: string,
  maxWidth: number,
  font: PDFFont,
  fontSize: number,
): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const char of word) {
    const candidate = currentChunk + char;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth || !currentChunk) {
      currentChunk = candidate;
    } else {
      chunks.push(currentChunk);
      currentChunk = char;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length ? chunks : [word];
}

/**
 * Extracts H2 headings as TOC entries from markdown lines.
 *
 * @param lines - Array of markdown lines
 * @returns Array of TOC entries with title and line index
 */
export function extractTocEntries(lines: string[]): { title: string; lineIndex: number }[] {
  const entries: { title: string; lineIndex: number }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      entries.push({
        title: h2Match[1].trim(),
        lineIndex: i,
      });
    }
  }

  return entries;
}

/**
 * Draws a zebra-striped table on the PDF page.
 *
 * @param page - PDF page to draw on
 * @param font - Regular font
 * @param boldFont - Bold font
 * @param rows - Table rows (array of arrays)
 * @param yStart - Starting Y position
 * @returns Ending Y position after drawing
 */
export function drawZebraTable(
  page: PDFPage,
  font: PDFFont,
  boldFont: PDFFont,
  rows: string[][],
  yStart: number,
): number {
  const rowHeight = 20;
  const colWidth = 150;
  const marginX = 54;
  let y = yStart;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length === 0) continue;

    const isHeader = rowIndex === 0;
    const isEven = rowIndex % 2 === 0;

    // Draw background
    if (isHeader) {
      page.drawRectangle({
        x: marginX,
        y: y - rowHeight,
        width: colWidth * row.length,
        height: rowHeight,
        color: [0.08, 0.18, 0.31] as any, // tableHeader
      });
    } else if (!isEven) {
      page.drawRectangle({
        x: marginX,
        y: y - rowHeight,
        width: colWidth * row.length,
        height: rowHeight,
        color: [0.96, 0.97, 0.99] as any, // zebraOdd
      });
    }

    // Draw text
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const cellText = row[colIndex];
      const x = marginX + colIndex * colWidth;
      page.drawText(cellText, {
        x,
        y: y - rowHeight / 2 - 4,
        font: isHeader ? boldFont : font,
        size: 10,
        color: isHeader ? ([1.0, 1.0, 1.0] as any) : ([0.1, 0.1, 0.1] as any),
      });
    }

    y -= rowHeight;
  }

  return y;
}
