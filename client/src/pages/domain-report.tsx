import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Activity, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function DomainReportPage() {
  const { domain } = useParams<{ domain: string }>();

  const {
    data: report,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['domainReport', domain],
    queryFn: async () => {
      const res = await fetch(`/api/domains/${domain}/report`);
      if (!res.ok) {
        if (res.status === 404)
          throw new Error(
            'Sem dados suficientes para este domínio. Execute alguns refinamentos usando este domínio.',
          );
        throw new Error('Falha ao carregar relatório do domínio');
      }
      return res.json();
    },
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="text-center space-y-4">
          <Activity className="h-8 w-8 animate-pulse text-primary mx-auto" />
          <p className="text-muted-foreground">Carregando telemetria do domínio...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-8 max-w-4xl space-y-4">
        <div className="flex items-center space-x-4 mb-8">
          <Link href="/">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          {/* Estado de erro: título secundário; a visão principal mantém o único <h1> da rota */}
          <h2 className="text-3xl font-bold tracking-tight text-foreground capitalize">
            Relatório de Domínio: {domain}
          </h2>
        </div>
        <Card className="border-destructive/50 bg-destructive/10">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Erro ao carregar relatório
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p>{(error as Error).message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const getClassificationBadge = (classification: string) => {
    switch (classification) {
      case 'NEVER_ELIGIBLE':
        return <Badge variant="destructive">Nunca Elegível</Badge>;
      case 'ELIGIBLE_NOT_VALID':
        return (
          <Badge variant="outline" className="text-amber-500 border-amber-500">
            Elegível, Uso Inválido
          </Badge>
        );
      case 'VALID_NOT_CONSOLIDATED':
        return (
          <Badge variant="secondary" className="bg-blue-500/20 text-blue-500">
            Válido, Descartado no Final
          </Badge>
        );
      case 'VALID_AND_CONSOLIDATED':
        return (
          <Badge variant="default" className="bg-green-500 hover:bg-green-600 text-white">
            Saudável
          </Badge>
        );
      default:
        return <Badge>{classification}</Badge>;
    }
  };

  return (
    <div className="container mx-auto py-8 max-w-5xl space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center space-x-4 mb-8">
        <Link href="/">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground capitalize">
            Performance do Domínio: {report.domain}
          </h1>
          <p className="text-muted-foreground mt-1">
            Visualização gerada pelo Cognitive Core / MLRouter
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="brutal-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Classificação Operacional
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold mb-1">
              {getClassificationBadge(report.classification)}
            </div>
            <p className="text-xs text-muted-foreground">
              Amostragem: {report.totalExecutions} execuções
            </p>
          </CardContent>
        </Card>

        <Card className="brutal-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Taxa de Acionamento
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{report.triggerRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">% das demandas usando o domínio</p>
          </CardContent>
        </Card>

        <Card className="brutal-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Retorno Útil (Agentes)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{report.usableReturnRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">% das respostas úteis geradas</p>
          </CardContent>
        </Card>

        <Card className="brutal-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Impacto Final (Consolidado)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{report.impactRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">% de sobrevivência na síntese</p>
          </CardContent>
        </Card>
      </div>

      <Card className="brutal-card bg-primary/5 border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5 text-primary" />
            Recomendação do Sistema
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-medium">{report.recommendedAction}</p>

          <div className="mt-6 flex flex-col gap-2 text-sm text-muted-foreground border-t border-border/50 pt-4">
            <div className="flex justify-between items-center">
              <span>Taxa de Erro/Fallback (Error Rate):</span>
              <span className="font-mono">{report.errorRate.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between items-center">
              <span>Latência de Síntese (P95):</span>
              <span className="font-mono">{report.latencyP95}ms</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
