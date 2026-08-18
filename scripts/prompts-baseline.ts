#!/usr/bin/env tsx
/**
 * Prompt Baseline Scanner
 *
 * Scans source files for inline system prompts and generates a metrics report.
 * Used to track prompt extraction progress and before/after comparison.
 *
 * Usage: npm run prompts:baseline
 */

import fs from 'fs';
import path from 'path';

interface PromptLocation {
  file: string;
  line: number;
  method: string;
  preview: string;
  tokenEstimate: number;
}

interface BaselineReport {
  generatedAt: string;
  summary: {
    totalPrompts: number;
    totalTokens: number;
    filesScanned: number;
    filesWithPrompts: number;
  };
  byFile: Record<
    string,
    {
      prompts: number;
      tokens: number;
      locations: PromptLocation[];
    }
  >;
  prompts: PromptLocation[];
}

// Files to scan for inline prompts
const FILES_TO_SCAN = [
  'server/services/ai-squad.ts',
  'server/services/refinement-agent.ts',
  'server/services/cognitive-core.ts',
];

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

function findMethodName(lines: string[], lineIndex: number): string {
  // Look backwards for function/method declaration
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 20); i--) {
    const line = lines[i];
    // Match async method(args) or function name(args)
    const methodMatch = line.match(
      /(?:async\s+)?(?:private\s+)?(?:public\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?{?/,
    );
    if (methodMatch) {
      return methodMatch[1];
    }
    // Match arrow function assignment
    const arrowMatch = line.match(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (arrowMatch) {
      return arrowMatch[1];
    }
  }
  return 'unknown';
}

function extractPromptPreview(content: string, maxLength: number = 100): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.substring(0, maxLength) + '...';
}

function scanFileForPrompts(filePath: string): PromptLocation[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const prompts: PromptLocation[] = [];

  // Track line numbers for each character position
  const lineAtPosition: number[] = [];
  let currentLine = 0;
  for (let i = 0; i < content.length; i++) {
    lineAtPosition[i] = currentLine;
    if (content[i] === '\n') {
      currentLine++;
    }
  }

  // Scan for template literal system prompts (most common pattern)
  const templateLiteralPattern = /(?:const|let)\s+systemPrompt\s*=\s*`([\s\S]*?)`/g;
  let match;

  while ((match = templateLiteralPattern.exec(content)) !== null) {
    const lineNumber = lineAtPosition[match.index] + 1;
    const promptContent = match[1];

    prompts.push({
      file: filePath,
      line: lineNumber,
      method: findMethodName(lines, lineNumber - 1),
      preview: extractPromptPreview(promptContent),
      tokenEstimate: estimateTokens(promptContent),
    });
  }

  // Scan for inline object prompts
  const objectPattern = /systemPrompt:\s*`([\s\S]*?)`/g;
  while ((match = objectPattern.exec(content)) !== null) {
    const lineNumber = lineAtPosition[match.index] + 1;
    const promptContent = match[1];

    // Check if this wasn't already captured
    const alreadyCaptured = prompts.some((p) => Math.abs(p.line - lineNumber) < 5);
    if (!alreadyCaptured) {
      prompts.push({
        file: filePath,
        line: lineNumber,
        method: findMethodName(lines, lineNumber - 1),
        preview: extractPromptPreview(promptContent),
        tokenEstimate: estimateTokens(promptContent),
      });
    }
  }

  // Scan for simple string prompts
  const stringPattern = /const\s+systemPrompt\s*=\s*["']([^"']{50,})["']/g;
  while ((match = stringPattern.exec(content)) !== null) {
    const lineNumber = lineAtPosition[match.index] + 1;
    const promptContent = match[1];

    const alreadyCaptured = prompts.some((p) => Math.abs(p.line - lineNumber) < 3);
    if (!alreadyCaptured) {
      prompts.push({
        file: filePath,
        line: lineNumber,
        method: findMethodName(lines, lineNumber - 1),
        preview: extractPromptPreview(promptContent),
        tokenEstimate: estimateTokens(promptContent),
      });
    }
  }

  return prompts;
}

function generateReport(): BaselineReport {
  const prompts: PromptLocation[] = [];
  const byFile: BaselineReport['byFile'] = {};
  let filesWithPrompts = 0;

  for (const relativePath of FILES_TO_SCAN) {
    const fullPath = path.join(process.cwd(), relativePath);
    const filePrompts = scanFileForPrompts(fullPath);

    if (filePrompts.length > 0) {
      filesWithPrompts++;
      const totalTokens = filePrompts.reduce((sum, p) => sum + p.tokenEstimate, 0);

      byFile[relativePath] = {
        prompts: filePrompts.length,
        tokens: totalTokens,
        locations: filePrompts,
      };

      prompts.push(...filePrompts);
    }
  }

  const totalTokens = prompts.reduce((sum, p) => sum + p.tokenEstimate, 0);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalPrompts: prompts.length,
      totalTokens,
      filesScanned: FILES_TO_SCAN.length,
      filesWithPrompts,
    },
    byFile,
    prompts,
  };
}

function printReport(report: BaselineReport): void {
  console.log('\n========================================');
  console.log('       PROMPT BASELINE REPORT');
  console.log('========================================\n');

  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Files scanned: ${report.summary.filesScanned}`);
  console.log(`Files with prompts: ${report.summary.filesWithPrompts}`);
  console.log(`Total inline prompts: ${report.summary.totalPrompts}`);
  console.log(`Total estimated tokens: ${report.summary.totalTokens.toLocaleString()}`);

  console.log('\n--- By File ---\n');

  for (const [file, data] of Object.entries(report.byFile)) {
    console.log(`\n${file}:`);
    console.log(`  Prompts: ${data.prompts}`);
    console.log(`  Tokens: ${data.tokens.toLocaleString()}`);
    console.log('  Locations:');
    for (const loc of data.locations) {
      console.log(`    - Line ${loc.line} (${loc.method}): ${loc.preview.substring(0, 60)}...`);
    }
  }

  console.log('\n--- Prompts by Method ---\n');

  const byMethod = new Map<string, PromptLocation[]>();
  for (const prompt of report.prompts) {
    const key = `${path.basename(prompt.file)}:${prompt.method}`;
    if (!byMethod.has(key)) {
      byMethod.set(key, []);
    }
    byMethod.get(key)!.push(prompt);
  }

  for (const [method, prompts] of byMethod) {
    console.log(
      `${method}: ${prompts.length} prompt(s), ${prompts.reduce((s, p) => s + p.tokenEstimate, 0)} tokens`,
    );
  }

  console.log('\n========================================\n');
}

async function main(): Promise<void> {
  console.log('Scanning for inline prompts...\n');

  const report = generateReport();

  // Print to console
  printReport(report);

  // Save JSON report
  const reportPath = path.join(process.cwd(), 'prompts-baseline-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`JSON report saved to: ${reportPath}`);

  // Exit with success
  process.exit(0);
}

main().catch((error) => {
  console.error('Error generating baseline report:', error);
  process.exit(1);
});
