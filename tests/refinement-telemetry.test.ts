import { describe, expect, it } from 'vitest';
import {
  containsMarkdownSyntax,
  getMessageLengthBucket,
  normalizeRefinementAgentText,
  parseRefinementAgentText,
  shouldUseRefinementPlainTextRenderer,
} from '../client/src/lib/refinement-telemetry';

describe('refinement plain text helpers', () => {
  it('converts literal newline tokens into visible line breaks', () => {
    expect(normalizeRefinementAgentText('Passo 1\\nPasso 2')).toBe('Passo 1\nPasso 2');
    expect(normalizeRefinementAgentText('Passo 1\\r\\nPasso 2')).toBe('Passo 1\nPasso 2');
  });

  it('keeps markdown tokens as literal text', () => {
    const content = '**obrigatorio**\\n- Primeiro\\n1. Faca X\\n```\\ncode\\n```\\n[ver](url)';

    expect(normalizeRefinementAgentText(content)).toContain('**obrigatorio**');
    expect(normalizeRefinementAgentText(content)).toContain('- Primeiro');
    expect(normalizeRefinementAgentText(content)).toContain('```');
    expect(normalizeRefinementAgentText(content)).toContain('[ver](url)');
  });

  it('parses leading asterisk list items without changing inline asterisks', () => {
    expect(parseRefinementAgentText('* item 1\\n* item 2')).toEqual([
      { type: 'list', items: ['item 1', 'item 2'] },
    ]);

    expect(parseRefinementAgentText('isso é *importante* no texto')).toEqual([
      { type: 'paragraph', text: 'isso é *importante* no texto' },
    ]);

    expect(parseRefinementAgentText('Aqui vai:\\n* item')).toEqual([
      { type: 'paragraph', text: 'Aqui vai:' },
      { type: 'list', items: ['item'] },
    ]);
  });

  it('classifies message length buckets deterministically', () => {
    expect(getMessageLengthBucket('curta')).toBe('short');
    expect(getMessageLengthBucket('m'.repeat(400))).toBe('medium');
    expect(getMessageLengthBucket('l'.repeat(1200))).toBe('long');
  });

  it('detects visible markdown syntax in streamed text', () => {
    expect(containsMarkdownSyntax('Texto com **negrito** parcial')).toBe(true);
    expect(containsMarkdownSyntax('- item de lista')).toBe(true);
    expect(containsMarkdownSyntax('[link](https://example.com)')).toBe(true);
    expect(containsMarkdownSyntax('Texto normal sem formatacao')).toBe(false);
  });

  it('gates literal rendering to refinement agent messages only', () => {
    expect(shouldUseRefinementPlainTextRenderer('refinement', 'agent')).toBe(true);
    expect(shouldUseRefinementPlainTextRenderer('refinement', 'user')).toBe(false);
    expect(shouldUseRefinementPlainTextRenderer('general', 'agent')).toBe(false);
  });
});
