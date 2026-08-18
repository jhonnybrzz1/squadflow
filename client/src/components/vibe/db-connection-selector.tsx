/**
 * Demanda #10365 T5 — seletor de conexão de banco no formulário de refinamento.
 *
 * Componente opcional — refinamento funciona sem conexão selecionada.
 * Permite selecionar uma conexão cadastrada ou abrir o modal de cadastro.
 */
import { useEffect, useState } from 'react';
import { Database, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { vibeApi, type VibeDbConnection } from '@/lib/vibe-api';
import { ApiError } from '@/lib/api-error';

const DB_TYPES = [
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'supabase', label: 'Supabase' },
  { value: 'neon', label: 'Neon' },
];

interface DbConnectionSelectorProps {
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  disabled?: boolean;
}

export function DbConnectionSelector({
  selectedId,
  onSelect,
  disabled,
}: DbConnectionSelectorProps) {
  const { toast } = useToast();
  const [connections, setConnections] = useState<VibeDbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [dbType, setDbType] = useState('postgresql');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    loadConnections();
  }, []);

  async function loadConnections() {
    setLoading(true);
    try {
      const { connections: list } = await vibeApi.db.listConnections();
      setConnections(list);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }

  async function handleTest() {
    if (!host || !password) {
      toast({
        title: 'Campos obrigatórios',
        description: 'Preencha host e senha.',
        variant: 'destructive',
      });
      return;
    }
    setTesting(true);
    try {
      const result = await vibeApi.db.testConnection({
        dbType,
        host,
        port: port ? parseInt(port, 10) : undefined,
        databaseName: databaseName || undefined,
        username: username || undefined,
        password,
      });
      if (result.success) {
        toast({ title: 'Conexão bem-sucedida!', description: 'O banco está acessível.' });
      } else {
        toast({
          title: 'Falha na conexão',
          description: result.error ?? 'Erro desconhecido.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Erro ao testar conexão.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!name || !host || !password) {
      toast({
        title: 'Campos obrigatórios',
        description: 'Preencha nome, host e senha.',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    try {
      const conn = await vibeApi.db.createConnection({
        name,
        dbType,
        host,
        port: port ? parseInt(port, 10) : undefined,
        databaseName: databaseName || undefined,
        username: username || undefined,
        password,
      });
      setConnections((prev) => [...prev, conn]);
      onSelect(conn.id);
      setShowForm(false);
      // Limpa form
      setName('');
      setHost('');
      setPort('');
      setDatabaseName('');
      setUsername('');
      setPassword('');
      toast({ title: 'Conexão cadastrada!', description: `${conn.name} está pronta para uso.` });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? 'Limite de conexões atingido no plano gratuito.'
          : err instanceof ApiError
            ? err.message
            : 'Erro ao cadastrar conexão.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await vibeApi.db.deleteConnection(id);
      setConnections((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) onSelect(null);
      toast({ title: 'Conexão removida.' });
    } catch {
      toast({ title: 'Erro ao remover', variant: 'destructive' });
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">
        Conexão de banco{' '}
        <span className="text-[--foreground-muted]">
          (opcional, enriquece o refinamento com schema)
        </span>
      </label>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[--foreground-muted]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando conexões…
        </div>
      ) : connections.length === 0 && !showForm ? (
        <div className="flex items-center gap-3 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm">
          <Database className="h-5 w-5 text-[--foreground-muted]" aria-hidden="true" />
          <span className="flex-1 text-[--foreground-muted]">
            Conecte seu banco para enriquecer refinamentos com schema real.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => setShowForm(true)}
          >
            <Plus className="h-4 w-4" />
            Conectar
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <select
            value={selectedId ?? ''}
            onChange={(e) => onSelect(e.target.value ? Number(e.target.value) : null)}
            disabled={disabled}
            className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
          >
            <option value="">Sem conexão de banco</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.dbType})
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => setShowForm(true)}
            disabled={disabled}
          >
            <Plus className="h-4 w-4" />
            Nova
          </Button>
          {selectedId && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => handleDelete(selectedId)}
              disabled={disabled}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {showForm && (
        <div className="mt-2 space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Nova conexão de banco</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs">Nome *</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Minha base"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs">Tipo *</label>
              <select
                value={dbType}
                onChange={(e) => setDbType(e.target.value)}
                className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {DB_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs">Host *</label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="db.supabase.co"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs">Porta</label>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="5432"
                type="number"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs">Database</label>
              <Input
                value={databaseName}
                onChange={(e) => setDatabaseName(e.target.value)}
                placeholder="postgres"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs">Usuário</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="postgres"
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className="text-xs">Senha / Connection String *</label>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder="••••••••"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Testar Conexão'}
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar Conexão'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
