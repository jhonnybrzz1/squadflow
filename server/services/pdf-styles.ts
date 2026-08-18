import { resolvePath } from '@shared/utils/paths';
import { rgb } from 'pdf-lib';
import fs from 'fs';

/**
 * Load brand tokens from design-system.json (graceful fallback)
 */
function loadDesignTokens() {
  try {
    const tokenPath = resolvePath('config/design-system.json');
    if (fs.existsSync(tokenPath)) {
      return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    }
  } catch (_) {
    // silently fall back to defaults
  }
  return null;
}

export const designTokens = loadDesignTokens();

/**
 * Converts a brand color key to RGB with fallback.
 */
function brandRgb(key: string, fallback: [number, number, number]) {
  const c = designTokens?.colors?.[key];
  if (c && typeof c.r === 'number') return rgb(c.r, c.g, c.b);
  return rgb(...fallback);
}

/**
 * Professional layout configuration for PDF generation.
 */
export const professionalLayout = {
  pageWidth: designTokens?.layout?.pageWidth ?? 612,
  pageHeight: designTokens?.layout?.pageHeight ?? 792,
  marginX: designTokens?.layout?.marginX ?? 54,
  headerHeight: designTokens?.layout?.headerHeight ?? 116,
  footerHeight: designTokens?.layout?.footerHeight ?? 58,
  bodyFontSize: designTokens?.layout?.bodyFontSize ?? 10.5,
  bodyLineHeight: designTokens?.layout?.bodyLineHeight ?? 15,
  sectionGap: designTokens?.layout?.sectionGap ?? 12,
  paragraphGap: designTokens?.layout?.paragraphGap ?? 5,
  bulletIndent: designTokens?.layout?.bulletIndent ?? 14,
  tocMinPages: designTokens?.layout?.tocMinPages ?? 3,
  primaryColor: brandRgb('primary', [0.08, 0.18, 0.31]),
  accentColor: brandRgb('accent', [0.0, 0.45, 0.62]),
  mutedColor: brandRgb('muted', [0.38, 0.43, 0.5]),
  bodyColor: brandRgb('body', [0.1, 0.1, 0.1]),
  borderColor: brandRgb('border', [0.82, 0.85, 0.88]),
  headerFill: brandRgb('headerFill', [0.96, 0.98, 0.99]),
  zebraEven: brandRgb('zebraEven', [1.0, 1.0, 1.0]),
  zebraOdd: brandRgb('zebraOdd', [0.96, 0.97, 0.99]),
  tableHeader: brandRgb('tableHeader', [0.08, 0.18, 0.31]),
  tableHeaderText: brandRgb('tableHeaderText', [1.0, 1.0, 1.0]),
};

/**
 * Font sizes for different text elements.
 */
export const fontSizes = {
  h1: 24,
  h2: 18,
  h3: 14,
  body: 10.5,
  small: 9,
} as const;

/**
 * Spacing constants.
 */
export const spacing = {
  sectionGap: 12,
  paragraphGap: 5,
  bulletIndent: 14,
  listItemIndent: 18,
} as const;

/**
 * PDF metadata defaults.
 */
export const pdfMetadata = {
  author: 'AICHATflow Platform',
  creator: 'AICHATflow PDF Engine v2',
  producer: 'AICHATflow PDF Engine v2',
  keywords: ['AICHATflow', 'PRD', 'Document'],
} as const;
