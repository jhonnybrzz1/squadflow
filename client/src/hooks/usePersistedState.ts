/**
 * Demanda 10082 (F1) — estado persistido em localStorage, para não perder o
 * conteúdo em andamento ao trocar de módulo/rota no editor.
 *
 * - Chave versionada (prefixo `v1:`): mudança de schema futura invalida dados
 *   antigos em vez de corromper a leitura.
 * - Debounce na escrita (default 400ms): não grava a cada tecla.
 * - Fail-safe de quota: se o localStorage estourar (5–10MB), tenta sessionStorage;
 *   se também falhar, mantém só em memória — nunca lança.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const VERSION = 'v1';
const keyOf = (k: string) => `${VERSION}:persist:${k}`;

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(keyOf(key)) ?? window.sessionStorage.getItem(keyOf(key));
  } catch (_) {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(keyOf(key), value);
  } catch (_) {
    try {
      window.sessionStorage.setItem(keyOf(key), value);
    } catch (_) {
      // memória apenas — sem persistência, mas sem quebrar a UI.
    }
  }
}

export function usePersistedState(
  key: string,
  initialValue = '',
  debounceMs = 400,
): [string, (v: string) => void, () => void] {
  const [value, setValue] = useState<string>(() => safeRead(key) ?? initialValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => safeWrite(key, value), debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, value, debounceMs]);

  const clear = useCallback(() => {
    setValue('');
    try {
      window.localStorage.removeItem(keyOf(key));
      window.sessionStorage.removeItem(keyOf(key));
    } catch (_) {
      /* noop */
    }
  }, [key]);

  return [value, setValue, clear];
}
