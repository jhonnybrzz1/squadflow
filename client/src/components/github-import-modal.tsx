import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AlertTriangle, Loader2, Github, Check, X, Server, Monitor, Layers } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';

interface GitHubImportModalProps {
  onImportSuccess: (indexedContent: string, analysisResult: string, repoNames?: string[]) => void;
  demandDescription?: string;
  isProfissional?: boolean;
  allowMultiple?: boolean;
}

export function GitHubImportModal({
  onImportSuccess,
  isProfissional = false,
  allowMultiple = true,
}: GitHubImportModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [repoSearch, setRepoSearch] = useState('');
  const [showConfirmation, setShowConfirmation] = useState(false);

  const {
    data: repos,
    isLoading: isLoadingRepos,
    isError: isErrorRepos,
    error: reposError,
    refetch: refetchRepos,
  } = useQuery({
    queryKey: ['github/repos'],
    queryFn: () => api.github.listRepos(),
    enabled: isOpen,
    retry: false,
  });

  const { data: currentUser } = useQuery({
    queryKey: ['github/me'],
    queryFn: () => api.github.getCurrentUser(),
    enabled: isOpen,
    staleTime: 10 * 60 * 1000, // 10 min
  });

  const handleRepoToggle = (repoFullName: string) => {
    if (!allowMultiple) {
      // Single selection mode - select and confirm immediately
      setSelectedRepos(new Set([repoFullName]));
      onImportSuccess('', '', [repoFullName]);
      setIsOpen(false);
      return;
    }

    // Multi-selection mode
    const newSelected = new Set(selectedRepos);
    if (newSelected.has(repoFullName)) {
      newSelected.delete(repoFullName);
    } else {
      newSelected.add(repoFullName);
    }
    setSelectedRepos(newSelected);
  };

  const handleConfirmSelection = () => {
    if (selectedRepos.size === 0) return;
    onImportSuccess('', '', Array.from(selectedRepos));
    setIsOpen(false);
    setSelectedRepos(new Set());
    setShowConfirmation(false);
  };

  const handleCancel = () => {
    setSelectedRepos(new Set());
    setShowConfirmation(false);
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setSelectedRepos(new Set());
      setShowConfirmation(false);
      setRepoSearch('');
    }
  };

  const myLogin = currentUser?.login?.toLowerCase() || null;

  const filteredRepos = (repos || []).filter((repo) => {
    const matchesSearch = (repo.fullName || '').toLowerCase().includes(repoSearch.toLowerCase());
    if (!matchesSearch) return false;

    // Sem login conhecido (token sem permissão de user, etc.) — não filtra por owner
    if (!myLogin) return true;

    const ownerLogin = (repo.owner?.login || '').toLowerCase();
    const isMyRepo = ownerLogin === myLogin;

    // OFF (default - "Pessoal"): só meus repos (sou owner)
    // ON ("Profissional"): só repos onde sou convidado/colaborador (não sou owner)
    return isProfissional ? !isMyRepo : isMyRepo;
  });

  const ownedCount = (repos || []).filter(
    (r) => myLogin && (r.owner?.login || '').toLowerCase() === myLogin,
  ).length;
  const collaboratorCount = (repos || []).length - ownedCount;

  // Categorize selected repos for display
  const getRepoCategory = (repoName: string): 'backend' | 'frontend' | 'other' => {
    const lower = repoName.toLowerCase();
    if (
      lower.includes('api') ||
      lower.includes('backend') ||
      lower.includes('server') ||
      lower.includes('service')
    ) {
      return 'backend';
    }
    if (
      lower.includes('web') ||
      lower.includes('frontend') ||
      lower.includes('client') ||
      lower.includes('ui') ||
      lower.includes('app')
    ) {
      return 'frontend';
    }
    return 'other';
  };

  const selectedArray = Array.from(selectedRepos);
  const categorizedSelection = {
    backend: selectedArray.filter((r) => getRepoCategory(r) === 'backend'),
    frontend: selectedArray.filter((r) => getRepoCategory(r) === 'frontend'),
    other: selectedArray.filter((r) => getRepoCategory(r) === 'other'),
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Github className="mr-2" size={16} />
          Adicionar Projeto
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {showConfirmation ? 'Confirmar Repositórios' : 'Selecionar Repositórios do GitHub'}
          </DialogTitle>
          <DialogDescription>
            {showConfirmation
              ? 'Revise os repositórios selecionados antes de confirmar.'
              : allowMultiple
                ? 'Selecione um ou mais repositórios que a squad deve usar como contexto. Útil para projetos com front-end e back-end separados.'
                : 'Selecione o repositório que a squad deve usar como contexto.'}
          </DialogDescription>
        </DialogHeader>

        {showConfirmation ? (
          // Confirmation View
          <div className="space-y-4">
            <div className="bg-muted/40 rounded-lg p-4 space-y-3">
              <div className="text-sm font-medium text-foreground">
                {selectedRepos.size} repositório{selectedRepos.size !== 1 ? 's' : ''} selecionado
                {selectedRepos.size !== 1 ? 's' : ''}:
              </div>

              {categorizedSelection.backend.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Server className="w-3 h-3" />
                    <span>Backend / API</span>
                  </div>
                  {categorizedSelection.backend.map((repo) => (
                    <div
                      key={repo}
                      className="flex items-center justify-between pl-5 py-1 text-sm font-mono"
                    >
                      <span className="text-[var(--status-backend)]">{repo}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const newSet = new Set(selectedRepos);
                          newSet.delete(repo);
                          setSelectedRepos(newSet);
                          if (newSet.size === 0) setShowConfirmation(false);
                        }}
                        className="p-1 hover:bg-destructive/10 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                        aria-label={`Remover ${repo} da seleção`}
                      >
                        <X className="w-3 h-3 text-destructive" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {categorizedSelection.frontend.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Monitor className="w-3 h-3" />
                    <span>Frontend / Web</span>
                  </div>
                  {categorizedSelection.frontend.map((repo) => (
                    <div
                      key={repo}
                      className="flex items-center justify-between pl-5 py-1 text-sm font-mono"
                    >
                      <span className="text-[var(--status-frontend)]">{repo}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const newSet = new Set(selectedRepos);
                          newSet.delete(repo);
                          setSelectedRepos(newSet);
                          if (newSet.size === 0) setShowConfirmation(false);
                        }}
                        className="p-1 hover:bg-destructive/10 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                        aria-label={`Remover ${repo} da seleção`}
                      >
                        <X className="w-3 h-3 text-destructive" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {categorizedSelection.other.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Layers className="w-3 h-3" />
                    <span>Outros</span>
                  </div>
                  {categorizedSelection.other.map((repo) => (
                    <div
                      key={repo}
                      className="flex items-center justify-between pl-5 py-1 text-sm font-mono"
                    >
                      <span>{repo}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const newSet = new Set(selectedRepos);
                          newSet.delete(repo);
                          setSelectedRepos(newSet);
                          if (newSet.size === 0) setShowConfirmation(false);
                        }}
                        className="p-1 hover:bg-destructive/10 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                        aria-label={`Remover ${repo} da seleção`}
                      >
                        <X className="w-3 h-3 text-destructive" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedRepos.size > 1 && (
              <div className="text-xs text-muted-foreground bg-[var(--status-info-bg)] border border-[var(--status-info-border)] rounded-md p-3">
                <strong>Dica:</strong> Ao selecionar múltiplos repositórios, a squad terá contexto
                de ambos os projetos para análises de integração entre front-end e back-end.
              </div>
            )}
          </div>
        ) : (
          // Selection View
          <div className="space-y-4">
            {/* Indicador do modo atual */}
            <div className="text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded-md flex items-center justify-between">
              <span>
                {isProfissional
                  ? `Exibindo repositórios profissionais (onde sou convidado)${myLogin ? ` (${collaboratorCount})` : ''}`
                  : `Exibindo repositórios pessoais${myLogin ? ` — ${myLogin} (${ownedCount})` : ''}`}
              </span>
              {allowMultiple && selectedRepos.size > 0 && (
                <span className="font-medium text-primary">
                  {selectedRepos.size} selecionado{selectedRepos.size !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            <label htmlFor="github-repo-search" className="sr-only">
              Buscar repositórios no GitHub
            </label>
            <Input
              id="github-repo-search"
              name="githubRepoSearch"
              placeholder="Buscar repositórios..."
              value={repoSearch}
              onChange={(e) => setRepoSearch(e.target.value)}
            />

            {isLoadingRepos && (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="ml-2 text-muted-foreground">Carregando repositórios...</span>
              </div>
            )}

            {isErrorRepos && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
                  <div className="space-y-2">
                    <p className="font-medium text-destructive">
                      Não foi possível carregar os repositórios do GitHub.
                    </p>
                    <p className="text-muted-foreground">
                      A chamada falhou após retry com backoff. Verifique token, permissões ou
                      instabilidade temporária da API.
                    </p>
                    {reposError instanceof Error && (
                      <p className="font-mono text-xs text-muted-foreground">
                        {reposError.message}
                      </p>
                    )}
                    <Button variant="outline" size="sm" onClick={() => refetchRepos()}>
                      Tentar novamente
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {!isLoadingRepos && !isErrorRepos && filteredRepos.length === 0 && (
              <div className="text-muted-foreground text-center p-4">
                {repos && repos.length > 0
                  ? isProfissional
                    ? 'Nenhum repositório onde você é convidado.'
                    : `Nenhum repositório próprio${myLogin ? ` de ${myLogin}` : ''}.`
                  : 'Nenhum repositório encontrado.'}
              </div>
            )}

            {!isLoadingRepos && filteredRepos.length > 0 && (
              <ScrollArea className="h-[300px] w-full rounded-md border">
                <div className="p-2">
                  {filteredRepos.map((repo) => {
                    const isSelected = selectedRepos.has(repo.fullName);
                    const category = getRepoCategory(repo.fullName);
                    const categoryIcon =
                      category === 'backend' ? (
                        <Server className="w-3 h-3 text-[var(--status-backend)]" />
                      ) : category === 'frontend' ? (
                        <Monitor className="w-3 h-3 text-[var(--status-frontend)]" />
                      ) : null;

                    return (
                      <div
                        key={repo.id}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          'flex min-h-[44px] items-center gap-3 p-2 cursor-pointer hover:bg-muted rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                          isSelected && 'bg-primary/10 border border-primary/30',
                        )}
                        onClick={() => handleRepoToggle(repo.fullName)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleRepoToggle(repo.fullName);
                          }
                        }}
                      >
                        {allowMultiple ? (
                          <span className="flex min-h-[44px] min-w-[44px] items-center justify-center">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => handleRepoToggle(repo.fullName)}
                              className="pointer-events-none"
                            />
                          </span>
                        ) : (
                          <div
                            className={cn(
                              'w-4 h-4 rounded-full border-2 flex items-center justify-center',
                              isSelected
                                ? 'border-primary bg-primary'
                                : 'border-muted-foreground/30',
                            )}
                          >
                            {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                          </div>
                        )}
                        <div className="flex-1 flex items-center gap-2">
                          {categoryIcon}
                          <span className="text-sm">{repo.fullName}</span>
                        </div>
                        {repo.description && (
                          <span
                            className="text-xs text-muted-foreground truncate max-w-[150px]"
                            title={repo.description}
                          >
                            {repo.description}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        )}

        {allowMultiple && (
          <DialogFooter className="gap-2">
            {showConfirmation ? (
              <>
                <Button variant="outline" onClick={() => setShowConfirmation(false)}>
                  Voltar
                </Button>
                <Button onClick={handleConfirmSelection} disabled={selectedRepos.size === 0}>
                  <Check className="w-4 h-4 mr-2" />
                  Confirmar {selectedRepos.size} Repositório{selectedRepos.size !== 1 ? 's' : ''}
                </Button>
              </>
            ) : (
              <>
                {selectedRepos.size > 0 && (
                  <Button variant="ghost" onClick={handleCancel}>
                    Limpar Seleção
                  </Button>
                )}
                <Button
                  onClick={() => setShowConfirmation(true)}
                  disabled={selectedRepos.size === 0}
                >
                  Revisar Seleção ({selectedRepos.size})
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
