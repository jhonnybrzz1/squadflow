import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sync } from 'glob';

/**
 * Spec 10177: ensure .env.example contains every environment variable read by
 * server/, shared/ and scripts/. Captures:
 *   - process.env.VAR
 *   - process.env['VAR'] / process.env["VAR"]
 *   - const { VAR } = process.env
 *   - string-key helpers like getEnvAsNumber('VAR', ...)
 *
 * Excludes npm_package_version (runtime npm metadata) and auth/admin keys per
 * the demand scope.
 */

function extractEnvVars(content: string): Set<string> {
  const used = new Set<string>();

  // process.env.VAR
  const dotMatches = content.match(/process\.env\.([A-Za-z0-9_]+)/g) || [];
  for (const m of dotMatches) {
    used.add(m.replace('process.env.', ''));
  }

  // process.env['VAR'] or process.env["VAR"]
  const bracketMatches = content.match(/process\.env\[(['"])([A-Za-z0-9_]+)\1\]/g) || [];
  for (const m of bracketMatches) {
    const name = m.replace(/process\.env\[(['"])(.+)\1\]/, '$2');
    if (name) used.add(name);
  }

  // destructuring: const { VAR1, VAR2 } = process.env
  const destructuringRegex = /(?:const|let|var)\s*\{\s*([A-Za-z0-9_,\s]+)\s*\}\s*=\s*process\.env/g;
  let destructuringMatch: RegExpExecArray | null;
  while ((destructuringMatch = destructuringRegex.exec(content)) !== null) {
    for (const name of destructuringMatch[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) used.add(trimmed);
    }
  }

  // string-key helpers: getEnvAsNumber('VAR', ...), getEnvAsString('VAR', ...), getEnvAsBoolean('VAR', ...)
  const helperRegex = /getEnvAs(?:Number|String|Boolean)\(\s*(['"])([A-Za-z0-9_]+)\1\s*[\),]/g;
  let helperMatch: RegExpExecArray | null;
  while ((helperMatch = helperRegex.exec(content)) !== null) {
    used.add(helperMatch[2]);
  }

  return used;
}

describe('.env.example consistency', () => {
  it('declares every environment variable used in server/shared/scripts', () => {
    const sourceFiles = [
      ...sync('server/**/*.{ts,js}'),
      ...sync('shared/**/*.{ts,js}'),
      ...sync('scripts/**/*.{ts,js}'),
    ];

    const used = new Set<string>();
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const name of extractEnvVars(content)) {
        used.add(name);
      }
    }

    // npm_package_version is provided by npm, not by .env.
    used.delete('npm_package_version');

    const envExample = readFileSync('.env.example', 'utf-8');
    const declared = new Set<string>();
    const regex = /^#?\s*([A-Z_][A-Za-z0-9_]*)\s*=/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(envExample)) !== null) {
      declared.add(match[1]);
    }

    const missing = [...used].filter((v) => !declared.has(v));
    if (missing.length > 0) {
      console.warn('Missing from .env.example:', missing);
    }
    expect(missing).toEqual([]);
  });
});
