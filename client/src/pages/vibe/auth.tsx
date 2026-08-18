/**
 * Demanda #10358 T2 — tela de signup/login da plataforma pública.
 *
 * Componente único com toggle entre "criar conta" e "entrar" (Tasks.md pede
 * Context API simples, sem React Router complexo). Em caso de sucesso,
 * redireciona para `/vibe/app`. Se já autenticado, redireciona direto.
 *
 * Validação leve no cliente (email não vazio, senha >= 8 chars) — a validação
 * robusta (validator.js + bcrypt) fica no backend, fonte única de verdade.
 */
import { useEffect, useState } from 'react';
import { Link, Redirect, useLocation } from 'wouter';
import { ArrowLeft, Loader2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useVibeAuth } from '@/hooks/use-vibe-auth';
import { ApiError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

type Mode = 'login' | 'signup';

export default function VibeAuthPage() {
  const { isAuthenticated, login, signup } = useVibeAuth();
  const [location] = useLocation();
  const { toast } = useToast();

  const initialMode: Mode = location.includes('signup') ? 'signup' : 'login';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Sincroniza modo com a URL (/vibe/login vs /vibe/signup) ao navegar.
  useEffect(() => {
    setMode(location.includes('signup') ? 'signup' : 'login');
  }, [location]);

  if (isAuthenticated) return <Redirect to="/vibe/app" replace />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || password.length < 8) {
      toast({
        title: 'Dados inválidos',
        description: 'Email válido e senha de no mínimo 8 caracteres.',
        variant: 'destructive',
      });
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'signup') {
        await signup(trimmedEmail, password);
        toast({ title: 'Conta criada!', description: 'Bem-vindo ao VibeFlow.' });
      } else {
        await login(trimmedEmail, password);
        toast({ title: 'Login realizado', description: 'Bem-vindo de volta.' });
      }
      // Redirect acontece via <Redirect> quando isAuthenticated vira true.
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? 'Este email já está cadastrado. Tente entrar.'
          : err instanceof ApiError && err.status === 401
            ? 'Email ou senha incorretos.'
            : err instanceof ApiError && err.status === 400
              ? 'Email ou senha inválidos.'
              : err instanceof ApiError && err.status === 429
                ? 'Muitas tentativas. Aguarde alguns minutos.'
                : 'Não foi possível completar agora. Tente novamente.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[--background] text-[--foreground]">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <Link
            href="/vibe"
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-[--foreground-muted] hover:text-[--foreground]"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar para a landing
          </Link>

          <div className="mb-8 flex items-center gap-2 font-[--font-display] text-xl font-bold">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-[--accent-cyan] text-[--background]">
              <Zap className="h-4 w-4" aria-hidden="true" />
            </span>
            Vibe<span className="text-[--accent-cyan]">Flow</span>
          </div>

          <h1 className="font-[--font-display] text-2xl font-bold">
            {mode === 'signup' ? 'Criar sua conta' : 'Entrar na sua conta'}
          </h1>
          <p className="mt-2 text-sm text-[--foreground-muted]">
            {mode === 'signup'
              ? 'Free Tier: 3 refinamentos/mês e 1 conexão GitHub. Sem cartão.'
              : 'Bem-vindo de volta.'}
          </p>

          {/* Toggle login / signup */}
          <div className="mt-6 grid grid-cols-2 gap-1 rounded-md border border-white/10 bg-white/5 p-1 text-sm">
            <ToggleTab
              active={mode === 'login'}
              onClick={() => setMode('login')}
              href="/vibe/login"
            >
              Entrar
            </ToggleTab>
            <ToggleTab
              active={mode === 'signup'}
              onClick={() => setMode('signup')}
              href="/vibe/signup"
            >
              Criar conta
            </ToggleTab>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vibe-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="vibe-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                autoComplete="email"
                disabled={submitting}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vibe-password" className="text-sm font-medium">
                Senha
              </label>
              <Input
                id="vibe-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="mínimo 8 caracteres"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                disabled={submitting}
              />
            </div>
            <Button type="submit" size="lg" disabled={submitting} className="mt-2 gap-2">
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {mode === 'signup' ? 'Criando conta…' : 'Entrando…'}
                </>
              ) : mode === 'signup' ? (
                'Criar conta grátis'
              ) : (
                'Entrar'
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-[--foreground-muted]">
            Ao continuar você aceita os termos do beta. Seus dados ficam isolados por conta.
          </p>
        </div>
      </div>
    </div>
  );
}

function ToggleTab({
  active,
  onClick,
  href,
  children,
}: {
  active: boolean;
  onClick: () => void;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1.5 text-center font-medium transition-colors',
        active
          ? 'bg-[--accent-cyan] text-[--background]'
          : 'text-[--foreground-muted] hover:text-[--foreground]',
      )}
    >
      {children}
    </Link>
  );
}
