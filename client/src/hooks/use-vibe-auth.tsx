/**
 * Demanda #10358 T2/T6 — estado de autenticação da plataforma pública.
 *
 * Context API simples (sem Redux, conforme Tasks.md). Token + usuário
 * persistidos em localStorage para sobreviver a reloads sem precisar de um
 * endpoint `/api/auth/me` novo — qualquer chamada autenticada que volte 401
 * (sessão revogada em outro lugar) limpa o estado local via `clearSession`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api-error';
import { getStoredVibeToken, setStoredVibeToken, vibeApi, type VibeUser } from '@/lib/vibe-api';

const USER_STORAGE_KEY = 'vibe.auth.user';

function readStoredUser(): VibeUser | null {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as VibeUser) : null;
  } catch {
    return null;
  }
}

function writeStoredUser(user: VibeUser | null): void {
  try {
    if (user) localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

interface VibeAuthContextValue {
  user: VibeUser | null;
  token: string | null;
  isAuthenticated: boolean;
  signup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Limpa a sessão local sem chamar o backend — usado após um 401 inesperado. */
  clearSession: () => void;
}

const VibeAuthContext = createContext<VibeAuthContextValue | undefined>(undefined);

export function VibeAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStoredVibeToken());
  const [user, setUser] = useState<VibeUser | null>(() => readStoredUser());

  useEffect(() => {
    // Token sem usuário (ou vice-versa) é um estado inconsistente — não
    // finge sessão válida com metade dos dados.
    if (!token || !user) {
      setStoredVibeToken(null);
      writeStoredUser(null);
      if (token) setToken(null);
      if (user) setUser(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistSession = useCallback((nextToken: string, nextUser: VibeUser) => {
    setStoredVibeToken(nextToken);
    writeStoredUser(nextUser);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const clearSession = useCallback(() => {
    setStoredVibeToken(null);
    writeStoredUser(null);
    setToken(null);
    setUser(null);
  }, []);

  const signup = useCallback(
    async (email: string, password: string) => {
      await vibeApi.auth.signup(email, password);
      const { user: loggedInUser, token: sessionToken } = await vibeApi.auth.login(email, password);
      persistSession(sessionToken, loggedInUser);
    },
    [persistSession],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const { user: loggedInUser, token: sessionToken } = await vibeApi.auth.login(email, password);
      persistSession(sessionToken, loggedInUser);
    },
    [persistSession],
  );

  const logout = useCallback(async () => {
    try {
      await vibeApi.auth.logout();
    } catch (error) {
      // Sessão já pode estar inválida (401) — segue limpando o estado local.
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<VibeAuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: Boolean(token && user),
      signup,
      login,
      logout,
      clearSession,
    }),
    [user, token, signup, login, logout, clearSession],
  );

  return <VibeAuthContext.Provider value={value}>{children}</VibeAuthContext.Provider>;
}

export function useVibeAuth(): VibeAuthContextValue {
  const ctx = useContext(VibeAuthContext);
  if (!ctx) throw new Error('useVibeAuth precisa estar dentro de <VibeAuthProvider>.');
  return ctx;
}
