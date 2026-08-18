#!/usr/bin/env tsx
/**
 * Prompt Test CLI
 *
 * Loads a prompt template, validates it, and runs test examples.
 *
 * Usage:
 *   npm run prompts:test                           # Test all templates
 *   npm run prompts:test rag/refinement           # Test specific template
 *   npm run prompts:test rag/refinement:HYDE      # Test specific section
 */

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {
  type PromptTemplate,
  type PromptTestExample,
  safeValidatePromptTemplate,
  extractSection,
  extractSectionNames,
} from '../shared/prompt-template-schema';

interface TestResult {
  name: string;
  section?: string;
  passed: boolean;
  errors: string[];
}

interface TemplateTestResults {
  category: string;
  name: string;
  valid: boolean;
  validationErrors: string[];
  testResults: TestResult[];
}

function loadTemplate(
  category: string,
  name: string,
): { template: PromptTemplate | null; errors: string[] } {
  const templatesDir = path.join(process.cwd(), 'agents', 'templates');
  const filePath = path.join(templatesDir, category, `prompt-${name}.yaml`);

  if (!fs.existsSync(filePath)) {
    return { template: null, errors: [`Template file not found: ${filePath}`] };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // CRIT-3 (10099 Fase 0): CORE_SCHEMA bloqueia tags customizadas.
    const rawData = yaml.load(content, { schema: yaml.CORE_SCHEMA });
    const result = safeValidatePromptTemplate(rawData);

    if (!result.success) {
      return {
        template: null,
        errors: result.error?.errors.map((e) => `${e.path.join('.')}: ${e.message}`) || [
          'Unknown validation error',
        ],
      };
    }

    return { template: result.data!, errors: [] };
  } catch (error) {
    return {
      template: null,
      errors: [`Failed to parse YAML: ${error instanceof Error ? error.message : 'unknown'}`],
    };
  }
}

function runTestExample(template: PromptTemplate, test: PromptTestExample): TestResult {
  const errors: string[] = [];

  // If test specifies a section, extract and verify it exists
  if (test.section) {
    const sectionContent = extractSection(template.prompt.system, test.section);
    if (!sectionContent) {
      errors.push(`Section '${test.section}' not found in template`);
      return { name: test.name, section: test.section, passed: false, errors };
    }

    // Check expected_contains against section content
    if (test.expected_contains) {
      for (const expected of test.expected_contains) {
        if (!sectionContent.includes(expected)) {
          errors.push(`Section '${test.section}' does not contain: "${expected}"`);
        }
      }
    }

    // Check expected_not_contains
    if (test.expected_not_contains) {
      for (const notExpected of test.expected_not_contains) {
        if (sectionContent.includes(notExpected)) {
          errors.push(`Section '${test.section}' should NOT contain: "${notExpected}"`);
        }
      }
    }
  } else {
    // Test against entire system prompt
    const systemPrompt = template.prompt.system;

    if (test.expected_contains) {
      for (const expected of test.expected_contains) {
        if (!systemPrompt.includes(expected)) {
          errors.push(`System prompt does not contain: "${expected}"`);
        }
      }
    }

    if (test.expected_not_contains) {
      for (const notExpected of test.expected_not_contains) {
        if (systemPrompt.includes(notExpected)) {
          errors.push(`System prompt should NOT contain: "${notExpected}"`);
        }
      }
    }
  }

  // Verify test has required input variables
  if (template.prompt.variables) {
    for (const variable of template.prompt.variables) {
      if (variable.required && !(variable.name in (test.input || {}))) {
        // This is informational, not a failure - variables are for runtime
      }
    }
  }

  return {
    name: test.name,
    section: test.section,
    passed: errors.length === 0,
    errors,
  };
}

function testTemplate(category: string, name: string, sectionFilter?: string): TemplateTestResults {
  const { template, errors: validationErrors } = loadTemplate(category, name);

  if (!template) {
    return {
      category,
      name,
      valid: false,
      validationErrors,
      testResults: [],
    };
  }

  const testResults: TestResult[] = [];
  const tests = template.test_examples || [];

  // Filter tests by section if specified
  const filteredTests = sectionFilter ? tests.filter((t) => t.section === sectionFilter) : tests;

  if (filteredTests.length === 0 && sectionFilter) {
    testResults.push({
      name: `No tests for section: ${sectionFilter}`,
      section: sectionFilter,
      passed: false,
      errors: [`No test examples found for section '${sectionFilter}'`],
    });
  }

  for (const test of filteredTests) {
    testResults.push(runTestExample(template, test));
  }

  // If no tests defined, validate sections exist
  if (tests.length === 0) {
    const sections = extractSectionNames(template.prompt.system);
    if (sections.length === 0) {
      testResults.push({
        name: 'section_check',
        passed: true,
        errors: [],
      });
    } else {
      // Verify each section is extractable
      for (const section of sections) {
        const content = extractSection(template.prompt.system, section);
        testResults.push({
          name: `section_${section}`,
          section,
          passed: !!content && content.length > 0,
          errors: content ? [] : [`Section '${section}' could not be extracted`],
        });
      }
    }
  }

  return {
    category,
    name,
    valid: true,
    validationErrors: [],
    testResults,
  };
}

function discoverTemplates(): Array<{ category: string; name: string }> {
  const templatesDir = path.join(process.cwd(), 'agents', 'templates');
  const templates: Array<{ category: string; name: string }> = [];

  if (!fs.existsSync(templatesDir)) {
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
      templates.push({ category, name });
    }
  }

  return templates;
}

function printResults(results: TemplateTestResults[]): void {
  console.log('\n========================================');
  console.log('       PROMPT TEMPLATE TESTS');
  console.log('========================================\n');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalInvalid = 0;

  for (const result of results) {
    const templateId = `${result.category}/${result.name}`;

    if (!result.valid) {
      console.log(`\x1b[31m[INVALID]\x1b[0m ${templateId}`);
      for (const error of result.validationErrors) {
        console.log(`   - ${error}`);
      }
      totalInvalid++;
      console.log('');
      continue;
    }

    const passedTests = result.testResults.filter((t) => t.passed).length;
    const failedTests = result.testResults.filter((t) => !t.passed).length;

    if (failedTests === 0) {
      console.log(
        `\x1b[32m[PASS]\x1b[0m ${templateId} (${passedTests}/${result.testResults.length} tests)`,
      );
    } else {
      console.log(
        `\x1b[31m[FAIL]\x1b[0m ${templateId} (${passedTests}/${result.testResults.length} tests)`,
      );
    }

    for (const testResult of result.testResults) {
      const sectionLabel = testResult.section ? `:${testResult.section}` : '';
      if (testResult.passed) {
        console.log(`   \x1b[32m✓\x1b[0m ${testResult.name}${sectionLabel}`);
        totalPassed++;
      } else {
        console.log(`   \x1b[31m✗\x1b[0m ${testResult.name}${sectionLabel}`);
        for (const error of testResult.errors) {
          console.log(`      - ${error}`);
        }
        totalFailed++;
      }
    }

    console.log('');
  }

  // Summary
  console.log('========================================');
  console.log(`Total: ${results.length} template(s)`);
  if (totalInvalid > 0) {
    console.log(`  \x1b[31mInvalid: ${totalInvalid}\x1b[0m`);
  }
  console.log(`  Tests passed: \x1b[32m${totalPassed}\x1b[0m`);
  if (totalFailed > 0) {
    console.log(`  Tests failed: \x1b[31m${totalFailed}\x1b[0m`);
  }
  console.log('========================================\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const results: TemplateTestResults[] = [];

  if (args.length === 0) {
    // Test all templates
    const templates = discoverTemplates();
    if (templates.length === 0) {
      console.log('No templates found in agents/templates/');
      process.exit(0);
    }

    for (const { category, name } of templates) {
      results.push(testTemplate(category, name));
    }
  } else {
    // Test specific template(s)
    for (const arg of args) {
      // Parse format: category/name or category/name:section
      const [templatePath, section] = arg.split(':');
      const [category, name] = templatePath.split('/');

      if (!category || !name) {
        console.error(`Invalid template path: ${arg}`);
        console.error('Expected format: category/name or category/name:SECTION_NAME');
        process.exit(1);
      }

      results.push(testTemplate(category, name, section));
    }
  }

  printResults(results);

  // Exit with error code if any tests failed or templates invalid
  const hasFailures = results.some((r) => !r.valid || r.testResults.some((t) => !t.passed));
  process.exit(hasFailures ? 1 : 0);
}

main().catch((error) => {
  console.error('Error running tests:', error);
  process.exit(1);
});
