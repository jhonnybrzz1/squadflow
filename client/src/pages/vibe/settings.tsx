/**
 * Demanda #10367 T4 — página /vibe/settings com seções de Perfil, Git,
 * Plano e Danger Zone.
 *
 * Perfil: trocar email e senha (validar currentPassword no frontend).
 * Git: listar conexões GitHub ativas com botão "Desconectar".
 * Plano: exibir plano atual e link para upgrade (Fatia 2A).
 * Danger Zone: deletar conta com modal de confirmação.
 */
import { useEffect, useState } from 'react';
import { Link, Redirect } from 'wouter';
import { AlertCircle, Loader2, Trash2, Github, CreditCard, User, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useVibeAuth } from '@/hooks/use-vibe-auth';
import { useVibePlan } from '@/hooks/use-vibe-plan';
import { vibeApi } from '@/lib/vibe-api';
import { VibeHeader } from '@/components/vibe/vibe-header';
import { ApiError } from '@/lib/api-error';

export default function VibeSettingsPage() {
  const { isAuthenticated, user, clearSession } = useVibeAuth();
  const { plan } = useVibePlan({ enabled: true });
  const { toast } = useToast();

  // Profile form state
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Git connections
  const [gitConnections, setGitConnections] = useState<
    { id: number; provider: string; githubUsername: string | null }[]
  >([]);
  const [loadingGit, setLoadingGit] = useState(true);
  const [deletingGit, setDeletingGit] = useState<number | null>(null);

  // Delete account
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);

  useEffect(() => {
    if (user) setEmail(user.email);
  }, [user]);

  useEffect(() => {
    if (isAuthenticated) loadGitConnections();
  }, [isAuthenticated]);

  async function loadGitConnections() {
    setLoadingGit(true);
    try {
      // Reuse the git repos endpoint to check if connected
      await vibeApi.git.listRepos();
      // If we can list repos, there's a connection. We don't have a direct
      // list-connections endpoint, so we check via repos.
      setGitConnections([{ id: 1, provider: 'github', githubUsername: null }]);
    } catch {
      // No connection or error
      setGitConnections([]);
    } finally {
      setLoadingGit(false);
    }
  }

  async function handleUpdateProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const input: { email?: string; currentPassword?: string; newPassword?: string } = {};
      if (email && email !== user?.email) input.email = email;
      if (newPassword) {
        input.currentPassword = currentPassword;
        input.newPassword = newPassword;
      }
      if (Object.keys(input).length === 0) {
        toast({ title: 'Nada para atualizar.' });
        return;
      }
      await vibeApi.auth.updateProfile(input);
      toast({ title: 'Perfil atualizado com sucesso!' });
      setCurrentPassword('');
      setNewPassword('');
      if (input.newPassword) {
        // Password change invalidates session — need to re-login
        toast({
          title: 'Senha alterada',
          description: 'Faça login novamente com a nova senha.',
        });
        clearSession();
        window.location.href = '/vibe/login';
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Erro ao atualizar perfil.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleDeleteGit(id: number) {
    setDeletingGit(id);
    try {
      await vibeApi.auth.deleteGitConnection(id);
      setGitConnections([]);
      toast({ title: 'GitHub desconectado.' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Erro ao desconectar.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setDeletingGit(null);
    }
  }

  async function handleDeleteAccount() {
    if (deleteConfirm !== 'DELETAR') {
      toast({
        title: 'Confirmação necessária',
        description: 'Digite "DELETAR" para confirmar.',
        variant: 'destructive',
      });
      return;
    }
    setDeletingAccount(true);
    try {
      await vibeApi.auth.deleteAccount();
      clearSession();
      toast({ title: 'Conta deletada', description: 'Seus dados foram anonimizados.' });
      window.location.href = '/vibe';
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Erro ao deletar conta.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setDeletingAccount(false);
    }
  }

  if (!isAuthenticated) return <Redirect to="/vibe/login" replace />;

  const isPro = plan?.plan === 'pro';

  return (
    <div className="min-h-screen bg-[--background] text-[--foreground]">
      <VibeHeader activeRoute="settings" />

      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="font-[--font-display] text-2xl font-bold sm:text-3xl">Configurações</h1>

        {/* Profile Section */}
        <section className="mt-8 rounded-lg border border-white/10 bg-white/5 p-6">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-[--foreground-muted]" aria-hidden="true" />
            <h2 className="text-lg font-semibold">Perfil</h2>
          </div>
          <form onSubmit={handleUpdateProfile} className="mt-4 space-y-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="settings-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="settings-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={savingProfile}
              />
            </div>
            <div className="border-t border-white/10 pt-4">
              <p className="text-sm font-medium">Trocar senha</p>
              <p className="mt-1 text-xs text-[--foreground-muted]">
                A troca de senha invalida todas as sessões ativas.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="settings-current-password" className="text-xs">
                    Senha atual
                  </label>
                  <Input
                    id="settings-current-password"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    disabled={savingProfile}
                    placeholder="••••••••"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="settings-new-password" className="text-xs">
                    Nova senha
                  </label>
                  <Input
                    id="settings-new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={savingProfile}
                    placeholder="Mín. 8 chars, 1 maiúscula, 1 número"
                  />
                </div>
              </div>
            </div>
            <Button type="submit" disabled={savingProfile} className="gap-2">
              {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Salvar alterações
            </Button>
          </form>
        </section>

        {/* Git Section */}
        <section className="mt-6 rounded-lg border border-white/10 bg-white/5 p-6">
          <div className="flex items-center gap-2">
            <Github className="h-5 w-5 text-[--foreground-muted]" aria-hidden="true" />
            <h2 className="text-lg font-semibold">GitHub</h2>
          </div>
          {loadingGit ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-[--foreground-muted]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando…
            </div>
          ) : gitConnections.length > 0 ? (
            <div className="mt-4 space-y-3">
              {gitConnections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between rounded-md border border-white/10 px-4 py-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    <span>GitHub conectado</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDeleteGit(conn.id)}
                    disabled={deletingGit === conn.id}
                    className="gap-2"
                  >
                    {deletingGit === conn.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Desconectar
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[--foreground-muted]">
              Nenhuma conexão GitHub ativa.{' '}
              <Link href="/vibe/app" className="underline-offset-4 hover:underline">
                Conectar no app →
              </Link>
            </p>
          )}
        </section>

        {/* Plan Section */}
        <section className="mt-6 rounded-lg border border-white/10 bg-white/5 p-6">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-[--foreground-muted]" aria-hidden="true" />
            <h2 className="text-lg font-semibold">Plano</h2>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Plano atual: {isPro ? 'Pro' : 'Free'}</p>
              {plan?.currentPeriodEnd && isPro && (
                <p className="text-xs text-[--foreground-muted]">
                  Próxima cobrança: {new Date(plan.currentPeriodEnd).toLocaleDateString('pt-BR')}
                </p>
              )}
            </div>
            {!isPro && (
              <Link href="/vibe/upgrade">
                <Button size="sm" variant="outline">
                  Fazer upgrade
                </Button>
              </Link>
            )}
          </div>
        </section>

        {/* Danger Zone */}
        <section className="mt-6 rounded-lg border border-[--accent-orange]/30 bg-[--accent-orange]/5 p-6">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-[--accent-orange]" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-[--accent-orange]">Danger Zone</h2>
          </div>
          <p className="mt-3 text-sm text-[--foreground-muted]">
            Deletar sua conta é irreversível. Seu email será anonimizado e seus dados de uso
            preservados para analytics agregados.
          </p>
          <Button
            variant="outline"
            className="mt-4 gap-2 border-[--accent-orange]/50 text-[--accent-orange] hover:bg-[--accent-orange]/10"
            onClick={() => setShowDeleteModal(true)}
          >
            <Trash2 className="h-4 w-4" />
            Deletar Conta
          </Button>
        </section>

        {/* Delete Account Modal */}
        {showDeleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-lg border border-[--accent-orange]/30 bg-[--background-card] p-6">
              <div className="flex items-start gap-3">
                <AlertCircle
                  className="mt-0.5 h-6 w-6 shrink-0 text-[--accent-orange]"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-lg font-semibold">Deletar conta</h3>
                  <p className="mt-2 text-sm text-[--foreground-muted]">
                    Esta ação é irreversível. Para confirmar, digite{' '}
                    <strong className="text-[--accent-orange]">DELETAR</strong> abaixo.
                  </p>
                </div>
              </div>
              <Input
                className="mt-4"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="DELETAR"
                disabled={deletingAccount}
              />
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowDeleteModal(false);
                    setDeleteConfirm('');
                  }}
                  disabled={deletingAccount}
                >
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDeleteAccount}
                  disabled={deletingAccount || deleteConfirm !== 'DELETAR'}
                  className="gap-2"
                >
                  {deletingAccount ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Deletar permanentemente
                </Button>
              </div>
            </div>
          </div>
        )}

        <p className="mt-10 text-center text-xs text-[--foreground-muted]">
          <Link href="/vibe/app" className="underline-offset-4 hover:underline">
            ← Voltar para o app
          </Link>
        </p>
      </main>
    </div>
  );
}
