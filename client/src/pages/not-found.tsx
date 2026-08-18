import { Link } from 'wouter';
import { AlertTriangle, ArrowLeft, Terminal } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="min-h-[70vh] w-full flex items-center justify-center px-4 py-12 bg-[var(--background)] text-[var(--foreground)]">
      <div className="neo-card w-full max-w-lg">
        {/* Header bar — mirrors the command-bar style used across the app */}
        <div className="flex items-center gap-3 border-b-2 border-[var(--border)] bg-[var(--muted)] p-4">
          <div className="flex h-8 w-8 items-center justify-center bg-[var(--destructive)]">
            <AlertTriangle
              className="h-4 w-4 text-[var(--destructive-foreground)]"
              aria-hidden="true"
            />
          </div>
          <span className="font-mono text-sm font-bold tracking-wide">ERRO 404</span>
        </div>

        <div className="p-6 space-y-4">
          <h1 className="font-mono text-2xl font-bold">Página não encontrada</h1>
          <p className="font-mono text-sm text-[var(--foreground-muted)]">
            O endereço acessado não existe ou foi movido. Verifique o link ou volte para a página
            inicial para continuar refinando suas demandas.
          </p>

          <Link
            href="/"
            className="cmd-button primary inline-flex items-center justify-center gap-2 no-underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Voltar ao início</span>
          </Link>

          <p className="flex items-center gap-2 pt-2 font-mono text-xs text-[var(--foreground-muted)]">
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            AICHATFLOW — Squad de refinamento
          </p>
        </div>
      </div>
    </main>
  );
}
