'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { FileText, ListTodo, FileDown, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';

interface ArtifactModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  demandId: number;
  type: 'PRD' | 'Tasks';
}

interface ArtifactFile {
  filename: string;
  createdAt: string;
  size: number;
}

function ImageWithFallback({ src, alt }: { src?: string; alt?: string }) {
  const [error, setError] = useState(false);
  if (error || !src) {
    return (
      <div className="flex items-center gap-2 rounded border border-dashed border-[var(--border)] bg-[var(--muted)] p-3 text-sm text-[var(--foreground-muted)]">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <span>Imagem indisponível</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt || 'Imagem do documento'}
      className="max-w-full rounded border border-[var(--border)]"
      onError={() => setError(true)}
    />
  );
}

function ArtifactSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Carregando artefato">
      <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--muted)]" />
      <div className="h-4 w-full animate-pulse rounded bg-[var(--muted)]" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-[var(--muted)]" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--muted)]" />
      <div className="h-32 w-full animate-pulse rounded bg-[var(--muted)]" />
      <div className="h-4 w-full animate-pulse rounded bg-[var(--muted)]" />
    </div>
  );
}

export function ArtifactModal({ open, onOpenChange, demandId, type }: ArtifactModalProps) {
  const [file, setFile] = useState<ArtifactFile | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'not-found' | 'ready'>(
    'idle',
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function load() {
      setStatus('loading');
      setContent(null);
      setFile(null);
      setErrorMessage(null);

      try {
        const { documents } = await api.documents.list(demandId, type);
        if (cancelled) return;

        if (documents.length === 0) {
          setStatus('not-found');
          return;
        }

        const latest = documents[0];
        setFile(latest);

        if (latest.filename.toLowerCase().endsWith('.pdf')) {
          setContent('');
          setStatus('ready');
          return;
        }

        const text = await api.documents.getContent(latest.filename);
        if (cancelled) return;

        setContent(text);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setStatus(err instanceof Error && err.message.includes('404') ? 'not-found' : 'error');
        setErrorMessage(err instanceof Error ? err.message : 'Erro desconhecido');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, demandId, type]);

  const icon = type === 'PRD' ? <FileText className="h-5 w-5" /> : <ListTodo className="h-5 w-5" />;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {icon}
            {type === 'PRD' ? 'PRD' : 'Tasks'} — Demanda #{demandId}
          </DialogTitle>
          <DialogDescription>
            {file && (
              <span className="font-mono text-[10px] text-[var(--foreground-muted)]">
                {file.filename} · {new Date(file.createdAt).toLocaleString('pt-BR')}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {status === 'loading' && <ArtifactSkeleton />}

        {status === 'not-found' && (
          <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-[var(--foreground-muted)]">
            <AlertCircle className="h-8 w-8 opacity-50" aria-hidden="true" />
            <p>Documento ausente</p>
            <p className="max-w-xs text-xs">
              O artefato {type} não foi encontrado no servidor. Pode ter sido removido ou ainda não
              foi gerado.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-destructive">
            <AlertCircle className="h-8 w-8" aria-hidden="true" />
            <p>Erro ao carregar o documento</p>
            <p className="max-w-xs text-xs">{errorMessage}</p>
          </div>
        )}

        {status === 'ready' && file?.filename.toLowerCase().endsWith('.pdf') && (
          <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-[var(--foreground-muted)]">
            <FileDown className="h-8 w-8 opacity-50" aria-hidden="true" />
            <p>Arquivo PDF</p>
            <a
              href={`/api/documents/${encodeURIComponent(file.filename)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--muted)]"
            >
              Baixar {file.filename}
            </a>
          </div>
        )}

        {status === 'ready' && content && (
          <div className="prose prose-invert max-w-none text-sm">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={{
                img: ({ src, alt }) => <ImageWithFallback src={src} alt={alt} />,
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
