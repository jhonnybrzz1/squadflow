import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const TARGET_MAGIC_STRINGS = [
  'pm_ia',
  'pm_puro',
  'tech_lead',
  'qa',
  'architect',
  'product_owner',
  'financial_analyst',
  'security_specialist',
];

const EXCLUDED_FILES = ['agent-roles.ts', 'agent-role-derivations.ts', 'agent-identity.ts'];

// Baseline de violações conhecidas (10210). Novas entradas devem ser removidas, nunca adicionadas.
const ALLOWED_VIOLATIONS = new Set([
  'server/cognitive-core/demand-classifier.ts',
  'server/middleware/auth-stub.ts',
  'server/orchestration-contracts/squad.ts',
  'server/routes/governance-routes.ts',
  'server/services/agent-interaction.ts',
  'server/services/agent-router.ts',
  'server/services/ai-squad/document-generator.ts',
  'server/services/ai-squad/roundtable-orchestrator.ts',
  'server/services/ai-squad/self-improvement-extractor.ts',
  'server/services/devops-tools.ts',
  'server/services/disc-personality.ts',
  'server/services/dynamic-agent-triage.ts',
  'server/services/improvement-execution.ts',
  'server/services/model-routing.ts',
  'server/services/pdf-generator.ts',
  'server/services/product-manager-tools.ts',
  'server/services/qa-tools.ts',
  'server/services/retrospective-service.ts',
  'server/services/structured-summary.ts',
  'server/services/tech-lead-review.ts',
  'server/services/tech-lead-tools.ts',
  'server/services/trace-sampling.ts',
]);

function findTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...findTsFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Magic string regression for agent roles', () => {
  it('no NEW disallowed magic strings are introduced in shared/ or server/', () => {
    const roots = [path.resolve('shared'), path.resolve('server')];
    const allFiles = roots.flatMap(findTsFiles);
    const newViolations: string[] = [];

    for (const file of allFiles) {
      if (EXCLUDED_FILES.some((name) => file.endsWith(name))) continue;
      const content = fs.readFileSync(file, 'utf8');
      const relative = path.relative('.', file);
      const basename = path.basename(file);

      for (const role of TARGET_MAGIC_STRINGS) {
        const regex = new RegExp(`['"]${role}['"]`, 'g');
        if (regex.test(content)) {
          if (!ALLOWED_VIOLATIONS.has(relative) && !ALLOWED_VIOLATIONS.has(basename)) {
            newViolations.push(`${relative}: ${role}`);
          }
        }
      }
    }

    expect(newViolations).toEqual([]);
  });
});
