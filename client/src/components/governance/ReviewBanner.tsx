import { Lock, CheckCircle } from 'lucide-react';
import Alert from '@/components/ui/alert';

interface ReviewBannerProps {
  documentState: 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'FINAL' | 'APPROVAL_REQUIRED';
  reviewSnapshotId?: string;
  snapshotHash?: string;
  approvalSessionId?: string;
}

export function ReviewBanner({
  documentState,
  reviewSnapshotId,
  snapshotHash,
  approvalSessionId,
}: ReviewBannerProps) {
  if (documentState === 'DRAFT') {
    return null; // No banner for draft state
  }

  if (documentState === 'APPROVAL_REQUIRED' || documentState === 'UNDER_REVIEW') {
    return (
      <Alert
        variant="warning"
        className="mb-4"
        title="Documento em Revisão (Versão Congelada)"
        icon={<Lock className="h-4 w-4 text-yellow-800" />}
      >
        <div className="space-y-2 mt-1">
          <p>
            Este documento está aguardando aprovação. O conteúdo exibido é uma versão imutável
            criada no momento da submissão para revisão.
          </p>
          <div className="text-xs space-y-1 mt-3 font-mono bg-yellow-100/50 p-2 rounded border border-yellow-200">
            <div>
              <span className="font-semibold">Snapshot ID:</span>{' '}
              {reviewSnapshotId?.substring(0, 8)}...
            </div>
            {snapshotHash && (
              <div>
                <span className="font-semibold">Hash:</span> {snapshotHash.substring(0, 16)}...
              </div>
            )}
            {approvalSessionId && (
              <div>
                <span className="font-semibold">Sessão:</span> {approvalSessionId.substring(0, 8)}
                ...
              </div>
            )}
          </div>
        </div>
      </Alert>
    );
  }

  if (documentState === 'APPROVED') {
    return (
      <Alert
        variant="success"
        className="mb-4"
        title="Documento Aprovado"
        icon={<CheckCircle className="h-4 w-4 text-green-600" />}
      >
        O conteúdo foi aprovado a partir do snapshot de revisão e está pronto para finalização.
      </Alert>
    );
  }

  if (documentState === 'FINAL') {
    return (
      <Alert
        variant="success"
        className="mb-4"
        title="Documento Finalizado"
        icon={<CheckCircle className="h-4 w-4 text-green-600" />}
      >
        Este documento foi aprovado e finalizado. O conteúdo está bloqueado para edição.
      </Alert>
    );
  }

  return null;
}
