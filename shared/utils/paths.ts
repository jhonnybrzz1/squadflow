import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * Resolve o root do projeto procurando package.json a partir do diretório deste arquivo.
 * Funciona em ESM e garante caminhos estáveis independentemente de process.cwd().
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('Could not find project root (package.json)');
    }
    dir = parent;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export const projectRoot = findProjectRoot(__dirname);

/**
 * Resolve um caminho relativo ao root do projeto.
 * Substitui o uso de `path.join(process.cwd(), 'relativo')`.
 *
 * Exemplo: resolvePath('config/feature-flags.json')
 */
export function resolvePath(relativePath: string): string {
  return resolve(projectRoot, relativePath);
}
