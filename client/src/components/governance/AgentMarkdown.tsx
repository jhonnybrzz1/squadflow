/**
 * Spec "Ajustes claude" F1 — renderiza a saída do agente Claude como markdown
 * legível (parágrafos, tabelas GFM e code blocks com syntax highlight) em vez de
 * texto puro monospace.
 *
 * Usa apenas libs já instaladas: `react-markdown` + `remark-gfm` +
 * `rehype-highlight`. O tema de highlight (`highlight.js/styles/github-dark.css`)
 * já é importado globalmente em `client/src/main.tsx`.
 *
 * Escopo defensivo: nunca lança. Conteúdo não-string degrada para string vazia.
 */
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '@/lib/utils';

interface AgentMarkdownProps {
  content: string;
  className?: string;
}

export const AgentMarkdown = memo(function AgentMarkdown({
  content,
  className,
}: AgentMarkdownProps) {
  const text = typeof content === 'string' ? content : '';

  return (
    <div
      className={cn('agent-markdown text-xs leading-relaxed', className)}
      data-testid="agent-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-4 mb-2 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          h1: ({ children }) => <h1 className="text-sm font-bold mb-2 mt-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-bold mb-2 mt-1">{children}</h2>,
          h3: ({ children }) => (
            <h3 className="text-xs font-bold uppercase mb-1 mt-1">{children}</h3>
          ),
          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-gold)] underline underline-offset-2"
            >
              {children}
            </a>
          ),
          // `inline` distingue `code` inline de bloco. Só o inline recebe o
          // pill; o bloco fica a cargo do <pre> + rehype-highlight.
          code: ({ inline, className: codeClassName, children, ...props }: any) =>
            inline ? (
              <code className="bg-black/30 px-1 py-0.5 rounded text-[0.9em] font-mono">
                {children}
              </code>
            ) : (
              <code className={cn('font-mono', codeClassName)} {...props}>
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="bg-black/40 border border-[var(--border)] p-2 rounded overflow-x-auto my-2 text-[11px] leading-snug">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="border-collapse text-[11px] w-full">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-[var(--border)]">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--border)] px-2 py-1 text-left font-bold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--border)] px-2 py-1 align-top">{children}</td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--border)] pl-3 my-2 text-[var(--foreground-muted)]">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-[var(--border)]" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
