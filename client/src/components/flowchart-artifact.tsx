/**
 * Demanda 10037 — renderização de fluxogramas no cliente (ADR-0002).
 *
 * O servidor entrega o texto-fonte Mermaid; a renderização para SVG acontece
 * aqui. O `mermaid` entra por import dinâmico para ficar fora do entry chunk —
 * é a biblioteca mais pesada do bundle e só é necessária quando existe um
 * artefato para mostrar (`scripts/bundle-budget.mjs` mede só o entry).
 */

import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Download, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FlowchartArtifactProps {
  artifactId: string;
  source: string;
  createdAt: string;
}

type RenderState =
  { status: 'loading' } | { status: 'ready'; svg: string } | { status: 'error'; message: string };

export function FlowchartArtifact({ artifactId, source, createdAt }: FlowchartArtifactProps) {
  const [state, setState] = useState<RenderState>({ status: 'loading' });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

        // O id precisa ser único por render: o Mermaid injeta um <style> com
        // esse id e reaproveitá-lo entre diagramas vaza estilo de um no outro.
        const { svg } = await mermaid.render(`mermaid-${artifactId}-${Date.now()}`, source);
        if (!cancelled) {
          // H-5: sanitize the SVG with DOMPurify before injection. Mermaid's
          // securityLevel 'strict' helps, but defense-in-depth — the source
          // comes from LLM output, which could contain crafted Mermaid syntax
          // that bypasses Mermaid's internal sanitization. DOMPurify strips
          // any remaining script tags, event handlers, and dangerous SVG
          // elements (foreignObject, use href, etc.).
          const cleanSvg = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['script', 'foreignObject'],
            FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
          });
          setState({ status: 'ready', svg: cleanSvg });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Falha ao renderizar o fluxograma.',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [artifactId, source]);

  function handleDownload() {
    if (state.status !== 'ready') return;

    const blob = new Blob([state.svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fluxograma-${artifactId}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="neo-card" data-testid={`artifact-${artifactId}`}>
      <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--foreground-muted)]">
            Fluxograma
          </p>
          <p className="text-xs text-[var(--foreground-muted)]">
            {new Date(createdAt).toLocaleString('pt-BR')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={state.status !== 'ready'}
          data-testid={`artifact-download-${artifactId}`}
        >
          <Download className="mr-2 h-4 w-4" />
          Baixar SVG
        </Button>
      </div>

      <div className="p-4" ref={containerRef}>
        {state.status === 'loading' && (
          <p className="text-sm text-[var(--foreground-muted)]">Renderizando fluxograma…</p>
        )}

        {state.status === 'error' && (
          <div className="flex items-start gap-2 text-sm text-[var(--warning)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p>Não foi possível renderizar o fluxograma.</p>
              <p className="mt-1 font-mono text-xs opacity-80">{state.message}</p>
            </div>
          </div>
        )}

        {state.status === 'ready' && (
          <div
            className="overflow-x-auto"
            // H-5: SVG is sanitized with DOMPurify (USE_PROFILES svg+svgFilters,
            // script/foreignObject tags and event handler attrs forbidden) before
            // injection. Mermaid securityLevel 'strict' is the first layer; this
            // is the second.
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        )}
      </div>
    </div>
  );
}
