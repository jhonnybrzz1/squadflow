export function sanitizePdfContent(content: string): string {
  if (!content) return '';
  return content
    .replace(/[□☐]/g, '[ ]')
    .replace(/[■☑]/g, '[x]')
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•●]/g, '*')
    .replace(/\r\n/g, '\n');
}

export function removeUnsupportedPdfGlyphs(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

export function stripMarkdownForPdfText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^\s*>\s?/, '')
    .trim();
}
