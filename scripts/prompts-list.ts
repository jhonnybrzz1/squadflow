#!/usr/bin/env tsx
/**
 * Prompt List CLI
 *
 * Lists all available prompt templates with validation status.
 *
 * Usage: npm run prompts:list
 */

import path from 'path';

// Import the registry - need to handle the fact that this is a CLI script
// We'll directly instantiate the class to avoid server dependencies
import fs from 'fs';
import yaml from 'js-yaml';
import { safeValidatePromptTemplate, extractSectionNames } from '../shared/prompt-template-schema';

interface TemplateInfo {
  category: string;
  name: string;
  version: string;
  description: string;
  sections: string[];
  isValid: boolean;
  filePath: string;
  testCount: number;
}

function listAllTemplates(): TemplateInfo[] {
  const templatesDir = path.join(process.cwd(), 'agents', 'templates');
  const templates: TemplateInfo[] = [];

  if (!fs.existsSync(templatesDir)) {
    console.log(`Templates directory not found: ${templatesDir}`);
    return templates;
  }

  const categories = fs.readdirSync(templatesDir, { withFileTypes: true });

  for (const categoryEntry of categories) {
    if (!categoryEntry.isDirectory()) continue;

    const category = categoryEntry.name;
    const categoryPath = path.join(templatesDir, category);
    const files = fs.readdirSync(categoryPath);

    for (const file of files) {
      if (!file.startsWith('prompt-') || !file.endsWith('.yaml')) continue;

      const name = file.replace(/^prompt-/, '').replace(/\.yaml$/, '');
      const filePath = path.join(categoryPath, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // CRIT-3 (10099 Fase 0): CORE_SCHEMA bloqueia tags customizadas.
        const rawData = yaml.load(content, { schema: yaml.CORE_SCHEMA });
        const result = safeValidatePromptTemplate(rawData);

        if (result.success && result.data) {
          templates.push({
            category,
            name,
            version: result.data.meta.version,
            description: result.data.meta.description,
            sections: extractSectionNames(result.data.prompt.system),
            isValid: true,
            filePath,
            testCount: result.data.test_examples?.length || 0,
          });
        } else {
          templates.push({
            category,
            name,
            version: 'N/A',
            description: `Invalid: ${result.error?.errors[0]?.message || 'unknown error'}`,
            sections: [],
            isValid: false,
            filePath,
            testCount: 0,
          });
        }
      } catch (error) {
        templates.push({
          category,
          name,
          version: 'N/A',
          description: `Error: ${error instanceof Error ? error.message : 'unknown'}`,
          sections: [],
          isValid: false,
          filePath,
          testCount: 0,
        });
      }
    }
  }

  return templates;
}

function printTemplates(templates: TemplateInfo[]): void {
  console.log('\n========================================');
  console.log('       PROMPT TEMPLATES');
  console.log('========================================\n');

  if (templates.length === 0) {
    console.log('No templates found.');
    console.log('Templates should be placed in: agents/templates/<category>/prompt-<name>.yaml');
    return;
  }

  // Group by category
  const byCategory = new Map<string, TemplateInfo[]>();
  for (const template of templates) {
    if (!byCategory.has(template.category)) {
      byCategory.set(template.category, []);
    }
    byCategory.get(template.category)!.push(template);
  }

  for (const [category, categoryTemplates] of byCategory) {
    console.log(`\n--- ${category.toUpperCase()} ---\n`);

    for (const template of categoryTemplates) {
      const status = template.isValid ? '\x1b[32m[VALID]\x1b[0m' : '\x1b[31m[INVALID]\x1b[0m';
      console.log(`${status} ${category}/${template.name} (v${template.version})`);
      console.log(`   ${template.description}`);

      if (template.sections.length > 0) {
        console.log(`   Sections: ${template.sections.join(', ')}`);
      }

      if (template.testCount > 0) {
        console.log(`   Tests: ${template.testCount}`);
      }

      console.log(`   File: ${path.relative(process.cwd(), template.filePath)}`);
      console.log('');
    }
  }

  // Summary
  const validCount = templates.filter((t) => t.isValid).length;
  const invalidCount = templates.filter((t) => !t.isValid).length;
  const totalSections = templates.reduce((sum, t) => sum + t.sections.length, 0);
  const totalTests = templates.reduce((sum, t) => sum + t.testCount, 0);

  console.log('========================================');
  console.log(`Total: ${templates.length} template(s)`);
  console.log(`  Valid: ${validCount}`);
  if (invalidCount > 0) {
    console.log(`  Invalid: ${invalidCount}`);
  }
  console.log(`  Total sections: ${totalSections}`);
  console.log(`  Total tests: ${totalTests}`);
  console.log('========================================\n');
}

async function main(): Promise<void> {
  const templates = listAllTemplates();
  printTemplates(templates);
  process.exit(templates.some((t) => !t.isValid) ? 1 : 0);
}

main().catch((error) => {
  console.error('Error listing templates:', error);
  process.exit(1);
});
