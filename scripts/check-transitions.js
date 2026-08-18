import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve('client/src');
const indexCssPath = path.join(rootDir, 'index.css');
const supportedExtensions = new Set(['.css', '.ts', '.tsx', '.js', '.jsx']);
const declarationPattern = /\b(?:animation|transition)(?:-[a-z-]+)?\s*:\s*([^;'"`}]*)/gi;
const durationPattern = /(?<![\w-])(\d*\.?\d+)(ms|s)(?![\w-])/gi;

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function walk(dirPath, files = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      walk(entryPath, files);
      continue;
    }

    if (supportedExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function toMilliseconds(value, unit) {
  const numericValue = Number.parseFloat(value);
  return unit === 's' ? numericValue * 1000 : numericValue;
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function hasGlobalReducedMotionSafetyNet() {
  const indexCss = readFile(indexCssPath);

  return (
    indexCss.includes('@media (prefers-reduced-motion: reduce)') &&
    indexCss.includes('animation-duration: 0.001ms !important') &&
    indexCss.includes('animation-iteration-count: 1 !important') &&
    indexCss.includes('transition-duration: 0.001ms !important') &&
    indexCss.includes('scroll-behavior: auto !important')
  );
}

const globalSafetyNet = hasGlobalReducedMotionSafetyNet();
const longDurationDeclarations = [];

for (const filePath of walk(rootDir)) {
  const source = readFile(filePath);
  let declarationMatch;

  while ((declarationMatch = declarationPattern.exec(source)) !== null) {
    const declaration = declarationMatch[0];
    const value = declarationMatch[1];
    let durationMatch;

    while ((durationMatch = durationPattern.exec(value)) !== null) {
      const [, rawDuration, unit] = durationMatch;
      const durationMs = toMilliseconds(rawDuration, unit);

      if (durationMs > 500) {
        longDurationDeclarations.push({
          file: path.relative(process.cwd(), filePath),
          line: lineNumberForOffset(source, declarationMatch.index),
          duration: `${rawDuration}${unit}`,
          declaration: declaration.trim(),
        });
      }
    }
  }
}

if (longDurationDeclarations.length === 0) {
  console.log('No animation or transition declarations above 500ms found in client/src.');
  process.exit(0);
}

console.log('Animation or transition declarations above 500ms found:');
for (const item of longDurationDeclarations) {
  console.log(`- ${item.file}:${item.line} ${item.duration} :: ${item.declaration}`);
}

if (globalSafetyNet) {
  console.log(
    'All reported declarations are covered by the global prefers-reduced-motion safety net in client/src/index.css.',
  );
  process.exit(0);
}

console.error(
  'Global prefers-reduced-motion safety net is missing or incomplete. Long declarations are not covered.',
);
process.exit(1);
