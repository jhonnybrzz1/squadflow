export interface RefinementFeedbackItem {
  itemIndex: number;
  itemKey: string;
  text: string;
}

function normalizeItemText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stableFeedbackHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function tableItem(line: string): string | null {
  if (!line.trim().startsWith('|')) return null;
  const cells = line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(normalizeItemText);
  if (cells.length === 0 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.find((cell) => cell.length > 0) ?? null;
}

export function extractRefinementFeedbackItems(message: string): RefinementFeedbackItem[] {
  const lines = message.split(/\r?\n/);
  const candidates: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listMatch) {
      candidates.push(normalizeItemText(listMatch[1]));
      continue;
    }

    const fromTable = tableItem(line);
    if (fromTable) {
      const nextLine = lines[index + 1] ?? '';
      // A table row followed by the Markdown separator is a header, not an item.
      if (/^\s*\|?\s*:?-{3,}/.test(nextLine)) continue;
      candidates.push(fromTable);
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((text) => text.length > 0)
    .filter((text) => {
      const normalized = text.toLocaleLowerCase('pt-BR');
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .map((text, itemIndex) => ({
      itemIndex,
      itemKey: stableFeedbackHash(text.toLocaleLowerCase('pt-BR')),
      text,
    }));
}
