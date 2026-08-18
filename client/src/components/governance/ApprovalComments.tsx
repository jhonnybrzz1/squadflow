import { useEffect, useState } from 'react';
import { MessageSquare, User, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ApprovalComment {
  commentId: number;
  demandId: number;
  reviewSnapshotId?: string;
  approvedSnapshotId?: string;
  author?: string;
  content: string;
  createdAt: string;
}

interface ApprovalCommentsProps {
  demandId: number;
}

export function ApprovalComments({ demandId }: ApprovalCommentsProps) {
  const [comments, setComments] = useState<ApprovalComment[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchComments();
  }, [demandId]);

  const fetchComments = async () => {
    try {
      const response = await fetch(`/api/governance/demands/${demandId}/approval-comments`);
      if (response.ok) {
        const data = await response.json();
        setComments(data);
      }
    } catch (error) {
      console.error('Error fetching approval comments:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Comentários de Revisão
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Carregando comentários...</p>
        </CardContent>
      </Card>
    );
  }

  if (comments.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Comentários de Revisão
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Nenhum comentário de revisão ainda.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          Comentários de Revisão ({comments.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          <div className="space-y-4">
            {comments.map((comment) => (
              <div key={comment.commentId} className="border rounded-lg p-4 space-y-2 bg-slate-50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{comment.author || 'Revisor'}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(comment.createdAt).toLocaleString('pt-BR')}
                  </div>
                </div>

                <p className="text-sm whitespace-pre-wrap">{comment.content}</p>

                {(comment.reviewSnapshotId || comment.approvedSnapshotId) && (
                  <div className="text-xs font-mono text-muted-foreground pt-2 border-t">
                    {comment.reviewSnapshotId && (
                      <div>
                        Review Snapshot: {comment.reviewSnapshotId.substring(0, 8)}
                        ...
                      </div>
                    )}
                    {comment.approvedSnapshotId && (
                      <div>Approved Snapshot: {comment.approvedSnapshotId.substring(0, 8)}...</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
