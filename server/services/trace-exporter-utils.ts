/**
 * Parse headers de environment variable para formato de objeto
 *
 * 🟢 Guard clause: retorna objeto vazio se headersRaw for vazio
 */
export function parseHeaders(headersRaw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headersRaw) {
    return headers;
  }

  for (const pair of headersRaw.split(',')) {
    const [key, ...rest] = pair.split('=');
    if (key && rest.length > 0) {
      headers[key.trim()] = rest.join('=').trim();
    }
  }
  return headers;
}

/**
 * Parse batchSize de environment variable com valor padrão
 *
 * 🟢 Guard clause: retorna valor padrão se parsing falhar
 */
export function parseBatchSize(envValue: string | undefined, defaultValue: number): number {
  return parseInt(envValue || '', 10) || defaultValue;
}

/**
 * Parse flushIntervalMs de environment variable com valor padrão
 *
 * 🟢 Guard clause: retorna valor padrão se parsing falhar
 */
export function parseFlushIntervalMs(envValue: string | undefined, defaultValue: number): number {
  return parseInt(envValue || '', 10) || defaultValue;
}
