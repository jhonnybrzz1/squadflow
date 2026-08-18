#!/usr/bin/env node
/**
 * Audit WCAG contrast ratios for design tokens defined in client/src/index.css.
 *
 * Extracts color pairs (foreground/background) from :root and .light, computes
 * WCAG contrast ratio, and flags pairs below AA (4.5:1 for normal text, 3:1 for
 * large text / UI components).
 *
 * Usage: node scripts/audit-contrast.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const CSS_PATH = path.resolve('client/src/index.css');
const source = fs.readFileSync(CSS_PATH, 'utf8');

// --- Color parsing -----------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return { r, g, b };
}

function parseColor(value) {
  const v = value.trim();
  // rgba(r,g,b,a)
  const rgba = v.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i,
  );
  if (rgba) {
    return {
      r: parseFloat(rgba[1]),
      g: parseFloat(rgba[2]),
      b: parseFloat(rgba[3]),
      a: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
    };
  }
  // #hex
  if (v.startsWith('#')) {
    const { r, g, b } = hexToRgb(v);
    return { r, g, b, a: 1 };
  }
  return null;
}

function relativeLuminance({ r, g, b }) {
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg, bg) {
  // Composite fg over bg when fg has alpha
  const a = fg.a ?? 1;
  const composite = (channel) => a * fg[channel] + (1 - a) * bg[channel];
  const fgComposited = { r: composite('r'), g: composite('g'), b: composite('b'), a: 1 };
  const l1 = relativeLuminance(fgComposited);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- Token extraction --------------------------------------------------------

function extractTokensFromBlock(block) {
  const tokens = {};
  const lines = block.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) {
      const name = m[1];
      let value = m[2].trim();
      // Resolve var() references using already-parsed tokens
      const varRef = value.match(/var\(--([a-z0-9-]+)\)/i);
      if (varRef && tokens[varRef[1]]) {
        value = tokens[varRef[1]];
      }
      tokens[name] = value;
    }
  }
  return tokens;
}

function extractBlock(selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*{([\\s\\S]*?)}`,
    'm',
  );
  const m = source.match(re);
  return m ? m[1] : '';
}

const darkTokens = extractTokensFromBlock(extractBlock(':root'));
const lightTokens = extractTokensFromBlock(extractBlock('.light'));

// --- Audit pairs -------------------------------------------------------------

// Pairs to check: [foreground, background, label]
const PAIRS = [
  ['foreground', 'background', 'Texto principal'],
  ['foreground-muted', 'background', 'Texto secundário'],
  ['foreground-muted', 'background-elevated', 'Texto secundário em card'],
  ['foreground-muted', 'background-card', 'Texto secundário em card'],
  ['muted-foreground', 'background', 'Texto muted'],
  ['muted-foreground', 'background-elevated', 'Texto muted em card'],
  ['muted-foreground', 'muted', 'Texto muted em surface'],
  ['primary', 'background', 'Primary sobre fundo'],
  ['primary-foreground', 'primary', 'Texto sobre primary'],
  ['secondary-foreground', 'secondary', 'Texto sobre secondary'],
  ['destructive', 'background', 'Destructive sobre fundo'],
  ['destructive-foreground', 'destructive', 'Texto sobre destructive'],
  ['success', 'background', 'Success sobre fundo'],
  ['success-foreground', 'success', 'Texto sobre success'],
  ['warning', 'background', 'Warning sobre fundo'],
  ['warning-foreground', 'warning', 'Texto sobre warning'],
  ['info', 'background', 'Info sobre fundo'],
  ['info-foreground', 'info', 'Texto sobre info'],
  ['processing', 'background', 'Processing sobre fundo'],
  ['processing-foreground', 'processing', 'Texto sobre processing'],
  ['accent-cyan', 'background', 'Accent cyan sobre fundo'],
  ['accent-cyan', 'background-elevated', 'Accent cyan em card'],
  ['accent-magenta', 'background', 'Accent magenta sobre fundo'],
  ['accent-lime', 'background', 'Accent lime sobre fundo'],
  ['accent-orange', 'background', 'Accent orange sobre fundo'],
  ['accent-violet', 'background', 'Accent violet sobre fundo'],
  ['accent-gold', 'background', 'Accent gold sobre fundo'],
  ['sidebar-foreground', 'sidebar-background', 'Sidebar texto'],
  ['sidebar-primary', 'sidebar-background', 'Sidebar primary'],
];

function auditTheme(themeName, tokens) {
  const results = [];
  for (const [fgKey, bgKey, label] of PAIRS) {
    const fgRaw = tokens[fgKey];
    const bgRaw = tokens[bgKey];
    if (!fgRaw || !bgRaw) {
      results.push({
        label,
        fg: fgKey,
        bg: bgKey,
        ratio: null,
        status: 'MISSING',
        theme: themeName,
      });
      continue;
    }
    const fg = parseColor(fgRaw);
    const bg = parseColor(bgRaw);
    if (!fg || !bg) {
      results.push({
        label,
        fg: fgRaw,
        bg: bgRaw,
        ratio: null,
        status: 'UNPARSEABLE',
        theme: themeName,
      });
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    let status = 'FAIL';
    if (ratio >= 7) status = 'AAA';
    else if (ratio >= 4.5) status = 'AA';
    else if (ratio >= 3) status = 'AA-LARGE'; // large text / UI only
    results.push({
      label,
      fg: fgKey,
      bg: bgKey,
      ratio: ratio.toFixed(2),
      status,
      theme: themeName,
    });
  }
  return results;
}

const darkResults = auditTheme('dark', darkTokens);
const lightResults = auditTheme('light', lightTokens);
const all = [...darkResults, ...lightResults];

// --- Report ------------------------------------------------------------------

const fails = all.filter((r) => r.status === 'FAIL');
const aaLarge = all.filter((r) => r.status === 'AA-LARGE');
const aa = all.filter((r) => r.status === 'AA');
const aaa = all.filter((r) => r.status === 'AAA');
const missing = all.filter((r) => r.status === 'MISSING' || r.status === 'UNPARSEABLE');

console.log('=== Auditoria de Contraste WCAG ===\n');
console.log(`Total de pares verificados: ${all.length}`);
console.log(`AAA (>=7:1): ${aaa.length}`);
console.log(`AA (>=4.5:1): ${aa.length}`);
console.log(`AA-LARGE apenas (>=3:1, <4.5:1): ${aaLarge.length}`);
console.log(`FAIL (<3:1): ${fails.length}`);
console.log(`MISSING/UNPARSEABLE: ${missing.length}\n`);

if (aaLarge.length > 0) {
  console.log('--- AA-LARGE apenas (ok para texto grande/UI, falha para texto normal) ---');
  for (const r of aaLarge) {
    console.log(`  [${r.theme}] ${r.label}: ${r.fg} sobre ${r.bg} = ${r.ratio}:1`);
  }
  console.log();
}

if (fails.length > 0) {
  console.log('--- FAIL (abaixo de 3:1 — crítico) ---');
  for (const r of fails) {
    console.log(`  [${r.theme}] ${r.label}: ${r.fg} sobre ${r.bg} = ${r.ratio}:1`);
  }
  console.log();
}

if (missing.length > 0) {
  console.log('--- MISSING/UNPARSEABLE ---');
  for (const r of missing) {
    console.log(`  [${r.theme}] ${r.label}: ${r.fg} / ${r.bg} (${r.status})`);
  }
  console.log();
}

// Write full report to file
const reportPath = path.resolve('contrast-audit-report.md');
const lines = [
  '# Auditoria de Contraste WCAG — Tokens de Design',
  '',
  `Gerado por \`scripts/audit-contrast.mjs\` em ${new Date().toISOString()}.`,
  '',
  '## Resumo',
  '',
  `| Status | Quantidade |`,
  `| --- | --- |`,
  `| AAA (>=7:1) | ${aaa.length} |`,
  `| AA (>=4.5:1) | ${aa.length} |`,
  `| AA-LARGE apenas (>=3:1) | ${aaLarge.length} |`,
  `| FAIL (<3:1) | ${fails.length} |`,
  `| MISSING/UNPARSEABLE | ${missing.length} |`,
  '',
  '## Resultados Detalhados',
  '',
  '### Tema Escuro (padrão)',
  '',
  '| Par | Foreground | Background | Razão | Status |',
  '| --- | --- | --- | --- | --- |',
];
for (const r of darkResults) {
  lines.push(`| ${r.label} | ${r.fg} | ${r.bg} | ${r.ratio ?? '-'} | ${r.status} |`);
}
lines.push(
  '',
  '### Tema Claro',
  '',
  '| Par | Foreground | Background | Razão | Status |',
  '| --- | --- | --- | --- | --- |',
);
for (const r of lightResults) {
  lines.push(`| ${r.label} | ${r.fg} | ${r.bg} | ${r.ratio ?? '-'} | ${r.status} |`);
}
lines.push('', '## Recomendações', '');
if (fails.length === 0 && aaLarge.length === 0) {
  lines.push('Todos os pares atendem AA (>=4.5:1). Nenhuma ação necessária.');
} else {
  if (fails.length > 0) {
    lines.push('### Crítico (FAIL <3:1)', '');
    for (const r of fails)
      lines.push(
        `- [${r.theme}] **${r.label}**: ${r.fg} sobre ${r.bg} = ${r.ratio}:1 — ajustar cor do token.`,
      );
  }
  if (aaLarge.length > 0) {
    lines.push('', '### Atenção (AA-LARGE apenas, <4.5:1)', '');
    lines.push(
      'Estes pares só servem para texto grande (>=18pt ou >=14pt bold) ou componentes UI. Não usar para texto normal.',
      '',
    );
    for (const r of aaLarge)
      lines.push(`- [${r.theme}] **${r.label}**: ${r.fg} sobre ${r.bg} = ${r.ratio}:1`);
  }
}
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`Relatório completo: ${reportPath}`);

process.exitCode = fails.length > 0 ? 1 : 0;
