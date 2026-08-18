/**
 * Demanda #10358 T1 — landing page pública da plataforma Vibe Coders.
 *
 * Página única (React + Vite, conforme Tasks.md) com headline, 3 bullets de
 * valor, CTA "Entrar na lista de espera" e formulário de waitlist que valida
 * email via o mesmo `validator` usado no backend (sanitização robusta, conforme
 * divergência security_specialist). Email persistido em `waitlist` pelo backend.
 *
 * Rota: `/vibe` — superfície separada do painel administrativo (`/admin/*`).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, CheckCircle2, Github, Loader2, Sparkles, Timer, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { vibeApi } from '@/lib/vibe-api';
import { useVibeAuth } from '@/hooks/use-vibe-auth';
import { VibeHeader } from '@/components/vibe/vibe-header';
import { ApiError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

const VALUE_BULLETS = [
  {
    icon: Timer,
    title: 'Refine em 30s',
    body: 'Descreva sua ideia em linguagem natural e receba um refinamento estruturado: descrição clara, tarefas sugeridas e complexidade estimada — sem setup, sem pipeline complexo.',
  },
  {
    icon: Github,
    title: 'Contexto do seu repo',
    body: 'Conecte GitHub (somente leitura) para enriquecer o refinamento com o contexto do seu projeto. Zero escrita, zero push — só leitura.',
  },
  {
    icon: Sparkles,
    title: 'Free Tier honesto',
    body: '3 refinamentos por mês e 1 conexão Git de graça. Sem cartão, sem pegadinha. Faça upgrade só quando fizer sentido para você.',
  },
];

export default function VibeLandingPage() {
  const { isAuthenticated } = useVibeAuth();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const result = await vibeApi.waitlist.join(trimmed, 'landing');
      setDone(true);
      toast({
        title: result.alreadyRegistered ? 'Você já está na lista!' : 'Inscrição confirmada!',
        description: result.alreadyRegistered
          ? 'Seu email já estava cadastrado. Te avisaremos quando o acesso abrir.'
          : 'Te avisaremos assim que a plataforma abrir para beta testers.',
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 400
          ? 'Email inválido. Confira e tente novamente.'
          : err instanceof ApiError && err.status === 429
            ? 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'
            : 'Não foi possível inscrever agora. Tente novamente em instantes.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[--background] text-[--foreground]">
      <VibeHeader activeRoute="landing" />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div
            className="pointer-events-none absolute inset-0 opacity-30"
            style={{
              background:
                'radial-gradient(60% 50% at 50% 0%, var(--accent-cyan) 0%, transparent 70%)',
            }}
            aria-hidden="true"
          />
          <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:py-28">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-[--foreground-muted]">
              <Zap className="h-3 w-3 text-[--accent-cyan]" aria-hidden="true" />
              Beta abrindo para Vibe Coders
            </span>
            <h1 className="mt-6 font-[--font-display] text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Transforme sua ideia em um{' '}
              <span className="text-[--accent-cyan]">refinamento estruturado</span> em menos de 30
              segundos.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base text-[--foreground-muted] sm:text-lg">
              Para devs solo e side-projects que usam IA para prototipar. Descreva, refine, conecte
              seu repo. Sem fricção, sem cartão de crédito.
            </p>

            {/* Waitlist form */}
            {done ? (
              <div className="mx-auto mt-10 flex max-w-md items-center justify-center gap-3 rounded-lg border border-[--accent-lime]/30 bg-[--accent-lime]/10 px-5 py-4 text-sm text-[--foreground]">
                <CheckCircle2 className="h-5 w-5 text-[--accent-lime]" aria-hidden="true" />
                <span>Inscrição confirmada. Te avisaremos quando o acesso abrir.</span>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                className="mx-auto mt-10 flex max-w-md flex-col gap-3 sm:flex-row"
              >
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu@email.com"
                  autoComplete="email"
                  disabled={submitting}
                  className="flex-1"
                  aria-label="Email para a lista de espera"
                />
                <Button type="submit" size="lg" disabled={submitting} className="gap-2">
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Inscrevendo…
                    </>
                  ) : (
                    <>
                      Entrar na lista
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>
            )}

            {isAuthenticated && (
              <p className="mt-6 text-sm text-[--foreground-muted]">
                Você já tem conta.{' '}
                <Link
                  href="/vibe/app"
                  className="font-medium text-[--accent-cyan] underline-offset-4 hover:underline"
                >
                  Abrir o app →
                </Link>
              </p>
            )}
          </div>
        </section>

        {/* Value bullets */}
        <section className="mx-auto max-w-5xl px-4 pb-24">
          <div className="grid gap-6 sm:grid-cols-3">
            {VALUE_BULLETS.map((b) => (
              <div
                key={b.title}
                className="rounded-lg border border-white/10 bg-[--background-card] p-6 transition-colors hover:border-[--accent-cyan]/40"
              >
                <div className="grid h-10 w-10 place-items-center rounded-md bg-[--accent-cyan]/10 text-[--accent-cyan]">
                  <b.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h2 className="mt-4 font-[--font-display] text-lg font-semibold">{b.title}</h2>
                <p className="mt-2 text-sm text-[--foreground-muted]">{b.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-white/10 bg-[--background-elevated]">
          <div className="mx-auto max-w-3xl px-4 py-16 text-center">
            <h2 className="font-[--font-display] text-2xl font-bold sm:text-3xl">
              Pronto para vibe-codar com mais clareza?
            </h2>
            <p className="mt-3 text-[--foreground-muted]">
              Entre na lista ou crie sua conta agora — o Free Tier já está disponível.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" variant="default" className="gap-2">
                <Link href="/vibe/signup">
                  Criar conta grátis
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/vibe/login">Já tenho conta</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer
        className={cn(
          'border-t border-white/10 py-6 text-center text-xs text-[--foreground-muted]',
        )}
      >
        <p>VibeFlow — Fatia 1 beta. Feito para Vibe Coders.</p>
      </footer>
    </div>
  );
}
