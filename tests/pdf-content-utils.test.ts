import { describe, expect, it } from 'vitest';
import {
  removeUnsupportedPdfGlyphs,
  sanitizePdfContent,
  stripMarkdownForPdfText,
} from '../server/services/pdf-content-utils';

describe('pdf content utils', () => {
  it('normalizes checklist and dash glyphs', () => {
    expect(sanitizePdfContent('☐ item — ok')).toBe('[ ] item -- ok');
  });

  it('removes unsupported glyphs while preserving text', () => {
    expect(removeUnsupportedPdfGlyphs('texto 🚀 ok')).toBe('texto  ok');
  });

  it('strips common markdown markers', () => {
    expect(stripMarkdownForPdfText('**Bold** and [link](https://x.test)')).toBe(
      'Bold and link (https://x.test)',
    );
  });
});
