/**
 * Segurança H-3: valida o protocolo de uma URL antes de chamar `window.open`,
 * prevenindo redirecionamentos/openers para esquemas perigosos (javascript:,
 * data:, file:, etc.). Permite URLs relativas começando com `/`, `#` ou `?`,
 * além de URLs absolutas http:, https: e mailto:.
 */
export function safeWindowOpen(url: string): void {
  const trimmed = url.trim();

  // URLs relativas seguras (path-absolute, hash ou query) — preservamos o valor original.
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) {
    window.open(trimmed, '_blank');
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    console.warn('[safeWindowOpen] URL inválida ignorada:', url);
    return;
  }

  const allowedProtocols = new Set(['http:', 'https:', 'mailto:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    console.warn('[safeWindowOpen] protocolo bloqueado:', parsed.protocol, url);
    return;
  }

  // mailto: não precisa de aba em branco; abrir na mesma janela delega ao handler nativo.
  const target = parsed.protocol === 'mailto:' ? '_self' : '_blank';
  window.open(trimmed, target);
}
