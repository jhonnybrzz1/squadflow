/**
 * Demanda #10364 T4 — página /vibe/upgrade com comparação Free vs Pro e
 * integração do Paddle Checkout (Fatia 2A).
 *
 * Zero manipulação de dados de cartão no frontend — tokenização 100% via Paddle.
 * Após checkout bem-sucedido, redireciona para o app com confirmação visual.
 */
import { useEffect, useState } from 'react';
import { vibeApi, type VibePlan } from '@/lib/vibe-api';
import { useVibeAuth } from '@/hooks/use-vibe-auth';
import { VibeHeader } from '@/components/vibe/vibe-header';

const PADDLE_VENDOR_ID = import.meta.env.VITE_PADDLE_VENDOR_ID as string | undefined;
const PADDLE_PRICE_ID = import.meta.env.VITE_PADDLE_PRICE_ID as string | undefined;
const PADDLE_ENVIRONMENT = (import.meta.env.VITE_PADDLE_ENVIRONMENT as string) || 'sandbox';

// Declaração global para Paddle.js
declare global {
  interface Window {
    Paddle?: {
      Environment: { set: (env: string) => void };
      Setup: (opts: { vendor: number }) => void;
      Checkout: {
        open: (opts: {
          product: string;
          custom_data?: Record<string, unknown>;
          success?: string;
          close?: string;
          email?: string;
        }) => void;
      };
    };
  }
}

function loadPaddleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Paddle) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.paddle.com/paddle/paddle.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Falha ao carregar Paddle.js'));
    document.head.appendChild(script);
  });
}

const FREE_FEATURES = [
  { label: '3 refinamentos por mês', included: true },
  { label: '1 repositório Git conectado', included: true },
  { label: 'Refinamento com IA (prompt livre)', included: true },
  { label: 'Histórico completo de refinamentos', included: false },
  { label: '30 refinamentos por mês', included: false },
  { label: 'Repositórios Git ilimitados', included: false },
];

const PRO_FEATURES = [
  { label: '30 refinamentos por mês', included: true },
  { label: 'Repositórios Git ilimitados', included: true },
  { label: 'Refinamento com IA (prompt livre)', included: true },
  { label: 'Histórico completo de refinamentos', included: true },
  { label: 'Suporte prioritário', included: true },
  { label: 'Cancelamento a qualquer momento', included: true },
];

export default function VibeUpgradePage() {
  const { user } = useVibeAuth();
  const [plan, setPlan] = useState<VibePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [paddleReady, setPaddleReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPlan() {
      try {
        const p = await vibeApi.plan.get();
        if (!cancelled) setPlan(p);
      } catch {
        // Sem auth ou erro — mostra página mesmo assim (visitante pode ver planos)
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPlan();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!PADDLE_VENDOR_ID) return;
    loadPaddleScript()
      .then(() => {
        if (window.Paddle) {
          window.Paddle.Environment.set(PADDLE_ENVIRONMENT);
          window.Paddle.Setup({ vendor: parseInt(PADDLE_VENDOR_ID, 10) });
          setPaddleReady(true);
        }
      })
      .catch(() => {
        setCheckoutError('Não foi possível carregar o checkout. Tente novamente.');
      });
  }, []);

  function handleUpgrade() {
    setCheckoutError(null);
    if (!window.Paddle || !PADDLE_PRICE_ID) {
      setCheckoutError(
        'Checkout indisponível. Configure VITE_PADDLE_VENDOR_ID e VITE_PADDLE_PRICE_ID.',
      );
      return;
    }
    if (!user) {
      // Redireciona para login se não autenticado
      window.location.href = '/vibe/login?redirect=/vibe/upgrade';
      return;
    }
    window.Paddle.Checkout.open({
      product: PADDLE_PRICE_ID,
      custom_data: { user_id: user.id },
      success: '/vibe/app?upgraded=1',
      close: '/vibe/upgrade',
      email: user.email,
    });
  }

  const isPro = plan?.plan === 'pro';

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <VibeHeader />
      <div className="mx-auto max-w-5xl px-4 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
            Escolha seu plano
          </h1>
          <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
            Comece grátis. Faça upgrade quando precisar de mais.
          </p>
        </div>

        {loading && (
          <div className="text-center text-slate-500 dark:text-slate-400">Carregando planos...</div>
        )}

        {checkoutError && (
          <div className="mx-auto mb-6 max-w-md rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {checkoutError}
          </div>
        )}

        <div className="grid gap-8 md:grid-cols-2">
          {/* Free Tier */}
          <div className="rounded-2xl border border-slate-200 bg-white p-8 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Free</h2>
            <p className="mt-2 text-slate-600 dark:text-slate-400">Para experimentar</p>
            <div className="mt-6">
              <span className="text-4xl font-bold text-slate-900 dark:text-white">R$ 0</span>
              <span className="text-slate-500 dark:text-slate-400">/mês</span>
            </div>
            <ul className="mt-8 space-y-3">
              {FREE_FEATURES.map((f) => (
                <li key={f.label} className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 text-lg ${f.included ? 'text-green-600 dark:text-green-400' : 'text-slate-300 dark:text-slate-700'}`}
                  >
                    {f.included ? '✓' : '✗'}
                  </span>
                  <span
                    className={`text-sm ${f.included ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-600 line-through'}`}
                  >
                    {f.label}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              {isPro ? (
                <span className="block rounded-lg border border-slate-200 py-3 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Você está no Pro
                </span>
              ) : (
                <span className="block rounded-lg border border-slate-200 py-3 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Seu plano atual
                </span>
              )}
            </div>
          </div>

          {/* Pro Tier */}
          <div className="relative rounded-2xl border-2 border-indigo-600 bg-white p-8 dark:bg-slate-900">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-4 py-1 text-xs font-semibold text-white">
              RECOMENDADO
            </div>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Pro</h2>
            <p className="mt-2 text-slate-600 dark:text-slate-400">Para Vibe Coders ativos</p>
            <div className="mt-6">
              <span className="text-4xl font-bold text-slate-900 dark:text-white">R$ 29</span>
              <span className="text-slate-500 dark:text-slate-400">/mês</span>
            </div>
            <ul className="mt-8 space-y-3">
              {PRO_FEATURES.map((f) => (
                <li key={f.label} className="flex items-start gap-3">
                  <span className="mt-0.5 text-lg text-green-600 dark:text-green-400">✓</span>
                  <span className="text-sm text-slate-700 dark:text-slate-300">{f.label}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              {isPro ? (
                <span className="block rounded-lg bg-green-600 py-3 text-center text-sm font-semibold text-white">
                  ✓ Plano Pro ativo
                </span>
              ) : (
                <button
                  onClick={handleUpgrade}
                  disabled={!paddleReady && !!PADDLE_VENDOR_ID}
                  className="block w-full rounded-lg bg-indigo-600 py-3 text-center text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  {paddleReady || !PADDLE_VENDOR_ID ? 'Assinar Pro por R$29/mês' : 'Carregando...'}
                </button>
              )}
            </div>
          </div>
        </div>

        {plan && (
          <div className="mx-auto mt-8 max-w-md text-center text-sm text-slate-500 dark:text-slate-400">
            {isPro && plan.currentPeriodEnd
              ? `Próxima cobrança: ${new Date(plan.currentPeriodEnd).toLocaleDateString('pt-BR')}`
              : 'Sem cobrança recorrente no plano Free.'}
          </div>
        )}

        <div className="mt-12 text-center text-xs text-slate-400 dark:text-slate-600">
          Pagamento processado por Paddle (Merchant of Record). Cartão nunca passa pelos nossos
          servidores.
        </div>
      </div>
    </div>
  );
}
