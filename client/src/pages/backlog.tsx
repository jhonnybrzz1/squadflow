/**
 * Demanda 10090 — menu "Backlog de Specs".
 *
 * Lista as specs do projeto com status claro (Desenvolvida / Não Desenvolvida)
 * e um changelog acessível (Radix Dialog) com a justificativa de negócio das
 * não desenvolvidas. Fonte: JSON estático (débito técnico aceito no MVP);
 * JSON inválido cai em fallback visual sem quebrar a página.
 */
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import specsData from './backlog-specs.json';

type SpecStatus = 'developed' | 'not-developed';

interface SpecEntry {
  id: string;
  title: string;
  category?: string;
  status: SpecStatus;
  justification?: string;
  changelog?: string;
}

function parseSpecs(raw: unknown): { specs: SpecEntry[]; invalid: boolean } {
  try {
    const list = (raw as { specs?: unknown }).specs;
    if (!Array.isArray(list)) return { specs: [], invalid: true };
    const specs = list.filter(
      (s): s is SpecEntry =>
        !!s &&
        typeof (s as SpecEntry).id === 'string' &&
        typeof (s as SpecEntry).title === 'string',
    );
    return { specs, invalid: false };
  } catch (err) {
    console.error('Backlog: specs.json inválido', err);
    return { specs: [], invalid: true };
  }
}

function StatusBadge({ status }: { status: SpecStatus | 'error' }) {
  if (status === 'developed')
    return (
      <Badge className="bg-green-600/20 text-green-500 border border-green-600/30">
        Desenvolvida
      </Badge>
    );
  if (status === 'not-developed')
    return (
      <Badge className="bg-orange-500/20 text-orange-400 border border-orange-500/30">
        Não desenvolvida
      </Badge>
    );
  return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30">Erro</Badge>;
}

export default function BacklogPage() {
  const { specs, invalid } = useMemo(() => parseSpecs(specsData), []);
  const [open, setOpen] = useState<string | null>(null);

  const notDeveloped = specs.filter((s) => s.status === 'not-developed');

  return (
    <section className="mx-auto max-w-4xl px-6 py-8" data-testid="backlog-page">
      <h1 className="mb-1 text-xl font-semibold text-[var(--foreground)]">Backlog de Specs</h1>
      <p className="mb-6 text-sm text-[var(--foreground-muted)]">
        Specs do projeto e seu estado de desenvolvimento.
      </p>

      {invalid ? (
        <div className="rounded-lg border border-[var(--border)] p-4 text-sm">
          <StatusBadge status="error" />
          <span className="ml-2 text-[var(--foreground-muted)]">
            Não foi possível ler a lista de specs.
          </span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-xs uppercase text-[var(--foreground-muted)]">
              <tr>
                <th className="px-4 py-2">Spec</th>
                <th className="px-4 py-2">Categoria</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Changelog</th>
              </tr>
            </thead>
            <tbody>
              {specs.map((s) => (
                <tr key={s.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 align-top">
                    <span className="font-mono text-xs text-[var(--foreground-muted)]">
                      #{s.id}
                    </span>{' '}
                    {s.title}
                  </td>
                  <td className="px-4 py-2 align-top text-[var(--foreground-muted)]">
                    {s.category ?? '—'}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-2 align-top">
                    {s.changelog ? (
                      <Dialog open={open === s.id} onOpenChange={(v) => setOpen(v ? s.id : null)}>
                        <DialogTrigger className="text-xs text-[var(--accent-cyan)] underline underline-offset-2">
                          Ver
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>
                              #{s.id} — {s.title}
                            </DialogTitle>
                            <DialogDescription>{s.changelog}</DialogDescription>
                          </DialogHeader>
                          {s.justification && (
                            <p className="text-sm text-[var(--foreground-muted)]">
                              <strong>Impacto de negócio:</strong> {s.justification}
                            </p>
                          )}
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <span className="text-xs text-[var(--foreground-muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notDeveloped.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Decisões de não-desenvolvimento</h2>
          <ul className="space-y-2">
            {notDeveloped.map((s) => (
              <li
                key={s.id}
                className="rounded-lg border border-[var(--border)] p-3 text-sm text-[var(--foreground-muted)]"
              >
                <span className="font-mono text-xs">#{s.id}</span> {s.title} —{' '}
                {s.justification ?? 'sem justificativa registrada'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
