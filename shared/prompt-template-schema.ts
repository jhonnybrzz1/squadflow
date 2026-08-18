import { z } from 'zod';

/**
 * Schema for prompt template extraction metadata.
 * Tracks where the prompt was extracted from for traceability.
 */
export const ExtractedFromSchema = z.object({
  file: z.string().describe('Original source file path'),
  lines: z.array(z.number()).optional().describe('Line numbers where prompt was found'),
  method: z.string().optional().describe('Method name containing the prompt'),
});

/**
 * Schema for prompt template metadata.
 * Contains versioning, categorization, and origin tracking.
 */
export const PromptMetaSchema = z.object({
  name: z.string().min(1).describe('Unique identifier for the prompt template'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .describe('Semantic version (e.g., 1.0.0)'),
  description: z.string().describe('Human-readable description of the template purpose'),
  category: z
    .enum(['rag', 'agent', 'classifier', 'validator', 'summarizer', 'general'])
    .describe('Functional category of the prompt'),
  extracted_from: ExtractedFromSchema.optional().describe('Source tracking for extracted prompts'),
  tags: z.array(z.string()).optional().describe('Additional categorization tags'),
  author: z.string().optional().describe('Author or team responsible'),
  last_updated: z.string().optional().describe('ISO date of last modification'),
});

/**
 * Schema for prompt variables.
 * Defines placeholders that will be replaced at runtime.
 */
export const PromptVariableSchema = z.object({
  name: z.string().describe('Variable name (used in template as {{name}})'),
  description: z.string().describe('Description of what this variable represents'),
  required: z.boolean().default(true).describe('Whether the variable must be provided'),
  default: z.string().optional().describe('Default value if not provided'),
  example: z.string().optional().describe('Example value for documentation'),
});

/**
 * Schema for the prompt content itself.
 * Contains the actual system prompt with optional variables.
 */
export const PromptContentSchema = z.object({
  system: z
    .string()
    .min(1)
    .describe('The system prompt content, may contain ## SECTION_NAME markers'),
  variables: z.array(PromptVariableSchema).optional().describe('Variables used in the prompt'),
});

/**
 * Schema for test example inputs.
 * Defines the input variables for a test case.
 */
export const TestInputSchema = z
  .record(z.string(), z.unknown())
  .describe('Input variables for the test');

/**
 * Schema for test examples.
 * Used to validate prompt behavior with expected outputs.
 */
export const PromptTestExampleSchema = z.object({
  name: z.string().describe('Unique name for this test case'),
  description: z.string().optional().describe('Description of what this test validates'),
  section: z.string().optional().describe('Specific section to test (e.g., QUERY_VARIATION)'),
  input: TestInputSchema.describe('Input variables for the test'),
  expected_contains: z
    .array(z.string())
    .optional()
    .describe('Strings that should appear in the output'),
  expected_not_contains: z
    .array(z.string())
    .optional()
    .describe('Strings that should NOT appear in the output'),
  expected_format: z
    .enum(['json', 'list', 'paragraph', 'numbered_list'])
    .optional()
    .describe('Expected output format'),
});

/**
 * Complete schema for a prompt template file (YAML).
 * Combines metadata, content, and test examples.
 */
export const PromptTemplateSchema = z.object({
  meta: PromptMetaSchema,
  prompt: PromptContentSchema,
  test_examples: z.array(PromptTestExampleSchema).optional().describe('Test cases for validation'),
});

/**
 * Schema for a cached prompt template entry.
 * Includes the template data plus cache metadata.
 */
export const CachedPromptTemplateSchema = z.object({
  template: PromptTemplateSchema,
  loadedAt: z.number().describe('Unix timestamp when loaded'),
  filePath: z.string().describe('Path to the YAML file'),
});

// Type exports
export type ExtractedFrom = z.infer<typeof ExtractedFromSchema>;
export type PromptMeta = z.infer<typeof PromptMetaSchema>;
export type PromptVariable = z.infer<typeof PromptVariableSchema>;
export type PromptContent = z.infer<typeof PromptContentSchema>;
export type TestInput = z.infer<typeof TestInputSchema>;
export type PromptTestExample = z.infer<typeof PromptTestExampleSchema>;
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;
export type CachedPromptTemplate = z.infer<typeof CachedPromptTemplateSchema>;

/**
 * Utility function to validate a raw YAML object against the schema.
 * Returns a validated PromptTemplate or throws a ZodError.
 */
export function validatePromptTemplate(raw: unknown): PromptTemplate {
  return PromptTemplateSchema.parse(raw);
}

/**
 * Safe validation that returns success/error instead of throwing.
 */
export function safeValidatePromptTemplate(raw: unknown): {
  success: boolean;
  data?: PromptTemplate;
  error?: z.ZodError;
} {
  const result = PromptTemplateSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Extract section names from a system prompt.
 * Sections are marked with ## SECTION_NAME format.
 */
export function extractSectionNames(systemPrompt: string): string[] {
  const sectionRegex = /^##\s+([A-Z_]+)\s*$/gm;
  const sections: string[] = [];
  let match;

  while ((match = sectionRegex.exec(systemPrompt)) !== null) {
    sections.push(match[1]);
  }

  return sections;
}

/**
 * Extract a specific section from a system prompt.
 * Returns the content between ## SECTION_NAME and the next section marker (or end).
 */
export function extractSection(systemPrompt: string, sectionName: string): string | null {
  // Split by section markers
  const lines = systemPrompt.split('\n');
  let inSection = false;
  const sectionContent: string[] = [];

  for (const line of lines) {
    // Check if this line is a section header
    const headerMatch = line.match(/^##\s+([A-Z_]+)\s*$/);

    if (headerMatch) {
      if (inSection) {
        // We've reached the next section, stop collecting
        break;
      }
      if (headerMatch[1] === sectionName) {
        // Found our section, start collecting
        inSection = true;
      }
    } else if (inSection) {
      sectionContent.push(line);
    }
  }

  if (sectionContent.length === 0) {
    return null;
  }

  return sectionContent.join('\n').trim();
}
