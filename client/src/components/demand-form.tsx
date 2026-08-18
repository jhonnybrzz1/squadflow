import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  Plus,
  TrendingUp,
  Bug,
  Compass,
  BarChart,
  Upload,
  Send,
  X,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Code,
  Briefcase,
  Building2,
  User,
  Zap,
  ShieldAlert,
  Wrench,
  Cloud,
  Sparkles,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { insertDemandSchema, type Demand, type InsertDemand } from '@shared/schema';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { cn } from '@/lib/utils';
import { GitHubImportModal } from './github-import-modal';
import { DEMAND_TYPES, type DemandType } from '@shared/demand-types';
import {
  evaluateDemandStartContract,
  formatDemandStartContract,
  getDemandStartContract,
  type DemandContractFields,
} from '@shared/demand-start-contract';

const demandTypeIconMap: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  Plus,
  TrendingUp,
  Bug,
  Compass,
  CheckCircle,
  BarChart,
  ShieldAlert,
  Wrench,
  Cloud,
};

interface DemandTypeOption {
  value: DemandType;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  shortLabel: string;
  color: string;
  description?: string;
  examples?: readonly string[];
}

const demandTypes: DemandTypeOption[] = Object.entries(DEMAND_TYPES)
  .filter(([value]) => value !== 'discovery')
  .map(([value, config]) => ({
    value: value as DemandType,
    ...config,
    icon: demandTypeIconMap[config.icon],
  }));

const priorities = [
  { value: 'baixa', label: 'BAIXA', color: 'text-[var(--foreground-muted)]' },
  { value: 'media', label: 'MÉDIA', color: 'text-[var(--accent-lime)]' },
  { value: 'alta', label: 'ALTA', color: 'text-[var(--accent-orange)]' },
  { value: 'critica', label: 'CRÍTICA', color: 'text-[var(--destructive)]' },
];

const demandSizes = [
  { value: 'P', label: 'PEQUENO', description: 'Baixa complexidade, 1-2 dias de esforço' },
  { value: 'M', label: 'MÉDIO', description: 'Complexidade moderada, 3-5 dias de esforço' },
  { value: 'G', label: 'GRANDE', description: 'Alta complexidade, mais de 1 semana' },
];

const refinementTypes = [
  {
    value: 'technical',
    label: 'TÉCNICO',
    icon: Code,
    color: 'cyan',
    description: 'Arquitetura, componentes, dependências, trade-offs',
  },
  {
    value: 'business',
    label: 'NEGÓCIOS',
    icon: Briefcase,
    color: 'lime',
    description: 'Objetivo, valor, impacto, prioridade',
  },
];

const refinementColorClasses: Record<
  string,
  { border: string; bg: string; bgSolid: string; text: string }
> = {
  cyan: {
    border: 'border-[var(--accent-cyan)]',
    bg: 'bg-[var(--accent-cyan)]/10',
    bgSolid: 'bg-[var(--accent-cyan)]',
    text: 'text-[var(--accent-cyan)]',
  },
  lime: {
    border: 'border-[var(--accent-lime)]',
    bg: 'bg-[var(--accent-lime)]/10',
    bgSolid: 'bg-[var(--accent-lime)]',
    text: 'text-[var(--accent-lime)]',
  },
};

const demandDomains = [
  { value: 'padrao', label: 'PADRÃO', description: 'Demandas genéricas de tecnologia' },
  {
    value: 'legaltech_lgpd',
    label: 'LEGALTECH / LGPD',
    description: 'Privacidade, proteção de dados e requisitos jurídicos',
  },
];

interface DemandFormProps {
  onDemandCreated?: (demand: Demand) => void;
  initialDescription?: string;
  initialOrigin?: string;
  initialOriginMetadata?: { frameworkName?: string; frameworkId?: string; sessionId?: string };
}

const accessibilityFieldContent = {
  title: {
    anchorId: 'demand-title-field',
    label: 'TÍTULO DA DEMANDA',
    helperText: 'Resuma o objetivo da demanda em uma frase clara.',
    summaryMessage: 'Informe um título para a demanda.',
  },
  description: {
    anchorId: 'demand-description-field',
    label: 'DESCRIÇÃO DETALHADA',
    helperText: 'Explique contexto, objetivo e resultado esperado da demanda.',
    summaryMessage: 'Descreva a demanda com detalhes suficientes para a squad.',
  },
} as const;

export function DemandForm({
  onDemandCreated,
  initialDescription,
  initialOrigin,
  initialOriginMetadata,
}: DemandFormProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [selectedType, setSelectedType] = useState<DemandType | null>(null);
  const [selectedRefinementType, setSelectedRefinementType] = useState<'technical' | 'business'>(
    'business',
  );
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  // Estado persistente para modo Profissional/Pessoal
  const [isProfissional, setIsProfissional] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return false;
    }
    const saved = window.localStorage.getItem('githubRepoMode');
    return saved === 'profissional';
  });
  const [contractFields, setContractFields] = useState<DemandContractFields>({});
  const [skillRawUrl, setSkillShUrl] = useState('');
  // Spec 10015: modo go-live (fast-track) opt-in por demanda.
  // FR-015: toggle só aparece quando a feature flag `goLiveEnabled` está ligada
  // (rollout gradual). Default da flag é false — o módulo nunca fica exposto
  // por acidente.
  const goLiveEnabled = useFeatureFlag('goLiveEnabled');
  const [isGoLive, setIsGoLive] = useState(false);
  const [showGoLiveConfirm, setShowGoLiveConfirm] = useState(false);
  const [acceptedTypeSuggestion, setAcceptedTypeSuggestion] = useState(false);
  const [showErrorSummary, setShowErrorSummary] = useState(false);
  const [origin] = useState<string | undefined>(initialOrigin);
  const [originMetadata] = useState(initialOriginMetadata);
  const { toast } = useToast();
  const skillsQuery = useQuery({
    queryKey: ['skills-lockfile'],
    queryFn: api.getSkillsLockfile,
    staleTime: 5 * 60 * 1000,
  });
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const titleFieldId = useId();
  const titleHelperTextId = useId();
  const descriptionFieldId = useId();
  const descriptionHelperTextId = useId();

  // Persistir mudança de modo no localStorage
  const handleModeChange = (profissional: boolean) => {
    setIsProfissional(profissional);
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      window.localStorage.setItem('githubRepoMode', profissional ? 'profissional' : 'pessoal');
    }
  };
  const queryClient = useQueryClient();

  const form = useForm<InsertDemand>({
    resolver: zodResolver(insertDemandSchema),
    defaultValues: {
      title: '',
      description: initialDescription ?? '',
      type: 'nova_funcionalidade',
      priority: 'media',
      domain: 'padrao',
      size: undefined,
      origin: initialOrigin,
      originMetadata: initialOriginMetadata,
    },
  });

  // Demanda 10196: aplica descrição/origem vindas do handoff Discovery após mount.
  useEffect(() => {
    if (initialDescription?.trim()) {
      form.setValue('description', initialDescription, { shouldValidate: false });
    }
    if (initialOrigin) {
      form.setValue('origin', initialOrigin, { shouldValidate: false });
    }
    if (initialOriginMetadata) {
      form.setValue('originMetadata', initialOriginMetadata, { shouldValidate: false });
    }
  }, [form, initialDescription, initialOrigin, initialOriginMetadata]);

  const createDemandMutation = useMutation({
    mutationFn: ({
      demand,
      files,
      githubRepoOwner,
      githubRepoName,
      additionalRepos,
      refinementType,
      demandStartContract,
      demandStartContractPayload,
      skillRawUrl,
    }: {
      demand: InsertDemand;
      files?: FileList;
      githubRepoOwner?: string;
      githubRepoName?: string;
      additionalRepos?: string[];
      refinementType?: 'technical' | 'business';
      demandStartContract?: string;
      demandStartContractPayload?: string;
      skillRawUrl?: string;
    }) => {
      const formData = new FormData();
      Object.entries(demand).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          formData.append(key, value as string);
        }
      });
      // Usar set() para garantir que refinementType nunca seja duplicado
      if (refinementType) {
        formData.set('refinementType', refinementType);
      }
      if (demandStartContract) {
        formData.set('demandStartContract', demandStartContract);
      }
      if (demandStartContractPayload) {
        formData.set('demandStartContractPayload', demandStartContractPayload);
      }
      if (skillRawUrl && skillRawUrl.trim()) {
        formData.set('skillRawUrl', skillRawUrl.trim());
      }
      if (origin) {
        formData.set('origin', origin);
      }
      if (originMetadata) {
        formData.set('originMetadata', JSON.stringify(originMetadata));
      }
      if (githubRepoOwner && githubRepoName) {
        formData.append('githubRepoOwner', githubRepoOwner);
        formData.append('githubRepoName', githubRepoName);
        // Include additional repos for multi-repo context
        if (additionalRepos && additionalRepos.length > 0) {
          formData.append('additionalRepos', JSON.stringify(additionalRepos));
        }
        const allRepos = [`${githubRepoOwner}/${githubRepoName}`, ...(additionalRepos || [])];
        const reposText =
          allRepos.length === 1
            ? `Repositório: ${allRepos[0]}`
            : `Repositórios:\n${allRepos.map((r) => `  - ${r}`).join('\n')}`;
        formData.set(
          'description',
          `${demand.description}\n\n---\n**Contexto do(s) Repositório(s) GitHub:**\n${reposText}\n`,
        );
      }
      if (files) {
        Array.from(files).forEach((file) => {
          formData.append('files', file);
        });
      }
      return api.demands.createWithFormData(formData);
    },
    onSuccess: (createdDemand) => {
      toast({
        title: 'Demanda enviada para a Squad',
        description: `Os agentes de IA estão processando sua solicitação no modo ${selectedRefinementType === 'technical' ? 'Técnico' : 'Negócios'}.`,
      });
      form.reset();
      setSelectedFiles(null);
      setSelectedRepos([]);
      setSelectedType('nova_funcionalidade');
      setSelectedRefinementType('business');
      setContractFields({});
      setSkillShUrl('');
      setIsGoLive(false);
      setAcceptedTypeSuggestion(false);
      setShowErrorSummary(false);
      form.setValue('type', 'nova_funcionalidade');
      form.setValue('domain', 'padrao');
      setIsCollapsed(true);
      queryClient.invalidateQueries({ queryKey: ['/api/demands'] });

      if (onDemandCreated) {
        onDemandCreated(createdDemand);
      }

      setTimeout(() => {
        const chatAreaElement = document.querySelector('[data-chat-area]');
        if (chatAreaElement) {
          chatAreaElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 500);
    },
    onError: (error) => {
      console.error('Erro ao criar demanda:', error);
      const friendly = getFriendlyErrorFromException(error);
      toast({
        title: 'Erro ao criar demanda',
        description: friendly.message,
        variant: 'destructive',
      });
    },
  });

  const watchedTitle = form.watch('title');
  const watchedDescription = form.watch('description');

  // Spec 10020 US2: botão "Reformular e Estruturar". Reformula a descrição e
  // incorpora os contratos extraídos como bloco estruturado (nada se perde).
  // Suporta abort (FR AC4) e retry via toast (FR AC5).
  const [isReformulating, setIsReformulating] = useState(false);
  const reformulateAbortRef = useRef<AbortController | null>(null);

  const REFORMULATE_TIMEOUT_MS = 55_000;

  const handleReformulate = async () => {
    if (isReformulating) return;
    const draft = (form.getValues('description') || '').trim();
    if (draft.length < 10) {
      toast({
        title: 'Rascunho muito curto',
        description: 'Escreva ao menos uma frase antes de reformular.',
        variant: 'destructive',
      });
      return;
    }
    setIsReformulating(true);

    const payload = {
      draft,
      title: form.getValues('title') || undefined,
      type: effectiveType,
      domain: form.getValues('domain'),
      repoFullName: selectedRepos[0],
      additionalRepos: selectedRepos.length > 1 ? selectedRepos.slice(1) : undefined,
      refinementType: selectedRefinementType,
    };

    // BUG FIX (reformulação 502): retry automático com AbortController (55s).
    // A primeira tentativa que passar do limite é cancelada e reenviada uma vez,
    // evitando falsos 502 de proxies com timeout fixo em 60s.
    let result: Awaited<ReturnType<typeof api.demands.reformulate>> | undefined;
    let attempt = 0;
    while (attempt < 2) {
      const controller = new AbortController();
      reformulateAbortRef.current = controller;
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, REFORMULATE_TIMEOUT_MS);

        // Spec 10028: envia repo/tipo/domínio para o backend consultar o RAG do
        // repositório antes de reformular (evita termos genéricos/dados inventados).
        result = await api.demands.reformulate(payload, controller.signal);
        clearTimeout(timeoutId);
        break;
      } catch (error) {
        clearTimeout(timeoutId);
        if (timedOut) {
          if (attempt === 0) {
            toast({
              title: 'Reformulação em andamento...',
              description: 'A primeira tentativa demorou mais que o esperado. Tentando novamente.',
              variant: 'default',
            });
            attempt++;
            continue;
          }
          // Segunda tentativa também expirou: deixa o catch externo exibir a
          // mensagem amigável de TIMEOUT.
          throw error;
        }
        if (controller.signal.aborted) {
          // cancelado pelo usuário/unmount — não exibe erro
          setIsReformulating(false);
          return;
        }
        throw error;
      }
    }

    reformulateAbortRef.current = null;

    if (!result) {
      toast({
        title: 'Não foi possível reformular',
        description: 'A reformulação não retornou um resultado válido. Tente novamente.',
        variant: 'destructive',
      });
      setIsReformulating(false);
      return;
    }

    try {
      const sections: string[] = [result.descricao_reformulada.trim()];
      const appendList = (title: string, items: string[]) => {
        if (items.length > 0) {
          sections.push(`## ${title}\n${items.map((i) => `- ${i}`).join('\n')}`);
        }
      };
      appendList('Critérios de Aceite', result.criterios_aceite);
      appendList('Regras de Negócio', result.regras_negocio);
      appendList('Limitações de Escopo', result.limitacoes_escopo);
      appendList('SLAs', result.slas);
      form.setValue('description', sections.join('\n\n'), {
        shouldValidate: true,
        shouldDirty: true,
      });
      if (result.title) {
        form.setValue('title', result.title, { shouldValidate: true, shouldDirty: true });
      }
      if (result.contractFields && Object.keys(result.contractFields).length > 0) {
        setContractFields((current) => ({ ...current, ...result.contractFields }));
      }
      toast({
        title: 'Descrição reformulada',
        description: result.sem_contexto_repo
          ? 'Reformulado sem contexto de repositório — revise os campos marcados "[A DEFINIR]".'
          : 'Revise o texto e os contratos extraídos antes de enviar.',
        variant: result.sem_contexto_repo ? 'default' : undefined,
      });
    } catch (error) {
      const friendly = getFriendlyErrorFromException(error);
      toast({
        title: 'Não foi possível reformular',
        description:
          friendly.errorCode === 'REQUEST_TIMEOUT'
            ? 'A reformulação demorou demais. Tente novamente.'
            : friendly.message,
        variant: 'destructive',
      });
    } finally {
      setIsReformulating(false);
      reformulateAbortRef.current = null;
    }
  };

  useEffect(() => {
    return () => reformulateAbortRef.current?.abort();
  }, []);

  const effectiveType = selectedType || 'discovery';
  const selectedContract = getDemandStartContract(effectiveType);
  const readiness = evaluateDemandStartContract({
    type: effectiveType,
    title: watchedTitle,
    description: watchedDescription,
    fields: contractFields,
  });
  const errorSummaryItems = useMemo(() => {
    const fieldMetadata = {
      title: {
        ...accessibilityFieldContent.title,
        inputId: titleFieldId,
      },
      description: {
        ...accessibilityFieldContent.description,
        inputId: descriptionFieldId,
      },
    } satisfies Record<
      keyof typeof accessibilityFieldContent,
      (typeof accessibilityFieldContent)[keyof typeof accessibilityFieldContent] & {
        inputId: string;
      }
    >;

    return (
      Object.entries(fieldMetadata) as Array<
        [keyof typeof fieldMetadata, (typeof fieldMetadata)[keyof typeof fieldMetadata]]
      >
    ).flatMap(([fieldName, config]) =>
      form.formState.errors[fieldName]
        ? [
            {
              fieldName,
              anchorId: config.anchorId,
              inputId: config.inputId,
              label: config.label,
              message: config.summaryMessage,
            },
          ]
        : [],
    );
  }, [descriptionFieldId, form.formState.errors, titleFieldId]);

  useEffect(() => {
    if (!showErrorSummary || errorSummaryItems.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      errorSummaryRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [errorSummaryItems.length, showErrorSummary]);

  const focusFieldFromSummary = (fieldId: string) => {
    const fieldElement = document.getElementById(fieldId);

    if (!fieldElement) {
      return;
    }

    if (fieldElement instanceof HTMLElement) {
      fieldElement.focus({ preventScroll: true });
      fieldElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleInvalidSubmit = () => {
    setShowErrorSummary(true);
  };

  const onSubmit = (data: InsertDemand) => {
    setShowErrorSummary(false);
    if (!readiness.isComplete) {
      toast({
        title: readiness.statusLabel,
        description: 'A demanda será enviada para refinamento com as lacunas registradas.',
      });
    }
    // Submete direto — agentes e rodadas são decididos pelo backend
    // (DEFAULT_ROUNDTABLE_AGENTS ou triagem dinâmica via feature flag).
    handleExecuteSubmit(data);
  };

  const handleExecuteSubmit = (data: InsertDemand) => {
    // Support multiple repos - first repo as primary, rest as context
    let githubRepoOwner: string | undefined;
    let githubRepoName: string | undefined;
    let additionalRepos: string[] = [];
    if (selectedRepos.length > 0) {
      [githubRepoOwner, githubRepoName] = selectedRepos[0].split('/');
      additionalRepos = selectedRepos.slice(1);
    }
    const demandStartContract = formatDemandStartContract({
      type: effectiveType,
      fields: contractFields,
      readiness,
      acceptedTypeSuggestion,
    });
    const demandStartContractPayload = JSON.stringify({
      version: 1,
      type: effectiveType,
      fields: contractFields,
      readiness,
      acceptedTypeSuggestion,
      createdAt: new Date().toISOString(),
    });
    createDemandMutation.mutate({
      demand: { ...data, goLiveMode: goLiveEnabled ? isGoLive : false },
      files: selectedFiles || undefined,
      githubRepoOwner,
      githubRepoName,
      additionalRepos,
      refinementType: selectedRefinementType,
      demandStartContract,
      demandStartContractPayload,
      skillRawUrl: skillRawUrl || undefined,
    });
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFiles(event.target.files);
  };

  const handleRepoSelect = (
    _indexedContent: string,
    _analysisResult: string,
    repoNames?: string[],
  ) => {
    if (repoNames && repoNames.length > 0) {
      setSelectedRepos(repoNames);
      toast({
        title: repoNames.length === 1 ? 'Repositório vinculado' : 'Repositórios vinculados',
        description:
          repoNames.length === 1
            ? `${repoNames[0]} será usado como contexto.`
            : `${repoNames.length} repositórios serão usados como contexto.`,
      });
    }
  };

  const handleRemoveFile = (indexToRemove: number) => {
    if (selectedFiles) {
      const dt = new DataTransfer();
      Array.from(selectedFiles).forEach((file, index) => {
        if (index !== indexToRemove) {
          dt.items.add(file);
        }
      });
      setSelectedFiles(dt.files.length > 0 ? dt.files : null);
    }
  };

  const getTypeColor = (color: string) => {
    if (color.startsWith('#')) return color;
    switch (color) {
      case 'cyan':
        return 'var(--accent-cyan)';
      case 'lime':
        return 'var(--accent-lime)';
      case 'magenta':
        return 'var(--accent-magenta)';
      case 'violet':
        return 'var(--accent-violet)';
      case 'orange':
        return 'var(--accent-orange)';
      default:
        return 'var(--accent-cyan)';
    }
  };

  const applyDemandType = (
    type: DemandType,
    onChange: (value: DemandType) => void,
    acceptedSuggestion = false,
  ) => {
    setSelectedType(type);
    onChange(type);
    setAcceptedTypeSuggestion(acceptedSuggestion);

    if (!form.getFieldState('priority').isDirty) {
      form.setValue('priority', DEMAND_TYPES[type].suggestedPriority, {
        shouldDirty: false,
        shouldValidate: true,
      });
    }
  };

  return (
    <div className="neo-card">
      {/* Header */}
      <button
        className="w-full flex min-h-[44px] items-center justify-between p-4 border-b-2 border-[var(--border)] bg-[var(--muted)] hover:bg-[var(--background)] active:scale-[0.98] transition-all duration-150 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-expanded={!isCollapsed}
        aria-controls="demand-form-content"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[var(--accent-cyan)] flex items-center justify-center">
            <Plus className="w-4 h-4 text-[var(--background)]" />
          </div>
          <span className="font-mono text-sm font-bold tracking-wide">NOVA DEMANDA</span>
        </div>
        <div className="flex min-h-[44px] min-w-[44px] items-center justify-center border border-[var(--border)]">
          {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </div>
      </button>

      {/* Form Content */}
      {!isCollapsed && (
        <div id="demand-form-content" className="p-6">
          <Form {...form}>
            <form
              noValidate
              onSubmit={form.handleSubmit(onSubmit, handleInvalidSubmit)}
              className="space-y-6"
            >
              {/* Tips Banner */}
              <div className="border-l-4 border-[var(--accent-cyan)] bg-[var(--muted)] p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-[var(--accent-cyan)] flex-shrink-0 mt-0.5" />
                  <div className="font-mono text-xs space-y-1">
                    <p className="font-bold text-[var(--foreground)]">
                      DICAS PARA UMA BOA DEMANDA:
                    </p>
                    <ul className="text-[var(--foreground-muted)] space-y-0.5">
                      <li>→ Descreva detalhadamente o problema ou necessidade</li>
                      <li>→ Inclua contexto técnico e objetivos esperados</li>
                      <li>→ Anexe documentos relevantes se disponível</li>
                    </ul>
                  </div>
                </div>
              </div>

              {showErrorSummary && errorSummaryItems.length > 0 && (
                <div
                  ref={errorSummaryRef}
                  tabIndex={-1}
                  role="alert"
                  aria-live="assertive"
                  aria-labelledby="demand-form-error-summary-title"
                  className="border-2 border-[var(--destructive)] bg-[var(--destructive)]/10 p-4"
                >
                  <p
                    id="demand-form-error-summary-title"
                    className="font-mono text-sm font-bold text-[var(--destructive)]"
                  >
                    {errorSummaryItems.length === 1
                      ? '1 erro encontrado no formulário'
                      : `${errorSummaryItems.length} erros encontrados no formulário`}
                  </p>
                  <p className="mt-1 font-mono text-xs text-[var(--foreground-muted)]">
                    Revise os campos abaixo antes de continuar.
                  </p>
                  <ul className="mt-3 space-y-2 font-mono text-xs">
                    {errorSummaryItems.map((item) => (
                      <li key={item.fieldName}>
                        <a
                          href={`#${item.inputId}`}
                          className="text-[var(--destructive)] underline underline-offset-4"
                          onClick={(event) => {
                            event.preventDefault();
                            focusFieldFromSummary(item.inputId);
                          }}
                        >
                          {item.message}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* GitHub Context */}
              <div className="space-y-2">
                <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                  CONTEXTO DO PROJETO (OPCIONAL)
                </Label>
                <p className="font-mono text-xs text-[var(--foreground-muted)]">
                  Vincule repositórios quando a demanda depender de código existente ou contexto
                  técnico.
                </p>

                {/* Seletor Profissional/Pessoal externo ao modal */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    <button
                      type="button"
                      onClick={() => handleModeChange(false)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                        !isProfissional
                          ? 'bg-[var(--accent-cyan)] text-[var(--background)]'
                          : 'bg-[var(--muted)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]',
                      )}
                    >
                      <User className="w-3.5 h-3.5" />
                      <span>Pessoal</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModeChange(true)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                        isProfissional
                          ? 'bg-[var(--accent-violet)] text-[var(--background)]'
                          : 'bg-[var(--muted)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]',
                      )}
                    >
                      <Building2 className="w-3.5 h-3.5" />
                      <span>Profissional</span>
                    </button>
                  </div>
                  <span className="font-mono text-[10px] text-[var(--foreground-muted)]">
                    {isProfissional ? 'Repos onde sou convidado' : 'Meus repositórios'}
                  </span>
                </div>

                {selectedRepos.length > 0 ? (
                  <div className="space-y-2">
                    {selectedRepos.map((repo, index) => (
                      <div
                        key={repo}
                        className="flex items-center justify-between p-3 border-2 border-[var(--success)] bg-[var(--success)]/5"
                      >
                        <div className="flex items-center gap-2 font-mono text-sm">
                          <CheckCircle className="w-4 h-4 text-[var(--success)]" />
                          <span className="text-[var(--success)]">{repo}</span>
                          {index === 0 && selectedRepos.length > 1 && (
                            <span className="text-[10px] text-[var(--foreground-muted)] bg-[var(--muted)] px-1.5 py-0.5">
                              PRINCIPAL
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedRepos(selectedRepos.filter((r) => r !== repo))}
                          className="w-6 h-6 flex items-center justify-center hover:bg-[var(--destructive)]/10 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                          aria-label={`Remover ${repo} do contexto`}
                        >
                          <X className="w-4 h-4 text-[var(--destructive)]" />
                        </button>
                      </div>
                    ))}
                    <GitHubImportModal
                      onImportSuccess={handleRepoSelect}
                      demandDescription={form.watch('description')}
                      isProfissional={isProfissional}
                    />
                  </div>
                ) : (
                  <GitHubImportModal
                    onImportSuccess={handleRepoSelect}
                    demandDescription={form.watch('description')}
                    isProfissional={isProfissional}
                  />
                )}
              </div>

              {/* Demand Type Tabs */}
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                      TIPO DE DEMANDA
                    </Label>
                    <FormControl>
                      <Tabs
                        value={selectedType || 'nova_funcionalidade'}
                        onValueChange={(value: string) =>
                          applyDemandType(value as DemandType, field.onChange)
                        }
                        className="mt-2"
                      >
                        <TabsList aria-label="Tipo de demanda">
                          {demandTypes.map((type) => {
                            const Icon = type.icon;
                            const isActive = selectedType === type.value;
                            return (
                              <TabsTrigger
                                key={type.value}
                                value={type.value}
                                title={
                                  type.description
                                    ? `${type.description}${type.examples && type.examples.length > 0 ? ` Ex: ${type.examples.join(', ')}.` : ''}`
                                    : undefined
                                }
                                className="flex flex-col items-center gap-1 py-3 active:scale-[0.98] motion-reduce:transform-none"
                                style={{
                                  borderBottomColor: isActive
                                    ? getTypeColor(type.color)
                                    : undefined,
                                  borderBottomWidth: isActive ? '3px' : undefined,
                                }}
                              >
                                <Icon
                                  className="w-4 h-4"
                                  style={{ color: isActive ? undefined : getTypeColor(type.color) }}
                                />
                                <span className="hidden sm:inline text-[10px]">{type.label}</span>
                                <span className="sm:hidden text-[10px]">{type.shortLabel}</span>
                              </TabsTrigger>
                            );
                          })}
                        </TabsList>
                      </Tabs>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Title */}
              <FormField
                control={form.control}
                name="title"
                render={({ field, fieldState }) => (
                  <FormItem id={accessibilityFieldContent.title.anchorId} className="scroll-mt-24">
                    <Label
                      htmlFor={titleFieldId}
                      className="font-mono text-xs text-[var(--foreground-muted)]"
                    >
                      {accessibilityFieldContent.title.label} <span aria-hidden="true">*</span>
                      <span className="sr-only"> obrigatório</span>
                    </Label>
                    <Input
                      id={titleFieldId}
                      placeholder="Ex: Sistema de autenticação por biometria"
                      className="terminal-input mt-2"
                      aria-describedby={
                        fieldState.error
                          ? `${titleHelperTextId} ${titleFieldId}-error`
                          : titleHelperTextId
                      }
                      aria-invalid={fieldState.invalid}
                      required
                      {...field}
                    />
                    <p
                      id={titleHelperTextId}
                      className="font-mono text-xs text-[var(--foreground-muted)]"
                    >
                      {accessibilityFieldContent.title.helperText}
                    </p>
                    <FormMessage id={`${titleFieldId}-error`} />
                  </FormItem>
                )}
              />

              {/* Description */}
              <FormField
                control={form.control}
                name="description"
                render={({ field, fieldState }) => (
                  <FormItem
                    id={accessibilityFieldContent.description.anchorId}
                    className="scroll-mt-24"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Label
                        htmlFor={descriptionFieldId}
                        className="font-mono text-xs text-[var(--foreground-muted)]"
                      >
                        {accessibilityFieldContent.description.label}{' '}
                        <span aria-hidden="true">*</span>
                        <span className="sr-only"> obrigatório</span>
                      </Label>
                      {/* Spec 10020 US2: reformular e estruturar (sparkles) */}
                      <button
                        type="button"
                        onClick={handleReformulate}
                        disabled={isReformulating}
                        aria-label="Reformular e Estruturar"
                        aria-busy={isReformulating}
                        title="Reformular e Estruturar a descrição com IA"
                        className="inline-flex items-center gap-1.5 min-h-[36px] px-2.5 border border-[var(--accent-cyan)] text-[var(--accent-cyan)] font-mono text-[11px] hover:bg-[var(--accent-cyan)] hover:text-[var(--background)] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                      >
                        {isReformulating ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        {isReformulating ? 'Consultando repositório e reformulando…' : 'Reformular'}
                      </button>
                    </div>
                    <Textarea
                      id={descriptionFieldId}
                      placeholder="Descreva sua demanda em detalhes. Inclua contexto, objetivos e qualquer informação relevante..."
                      rows={5}
                      className="terminal-input mt-2 resize-none"
                      aria-describedby={
                        fieldState.error
                          ? `${descriptionHelperTextId} ${descriptionFieldId}-error`
                          : descriptionHelperTextId
                      }
                      aria-invalid={fieldState.invalid}
                      required
                      {...field}
                    />
                    <p
                      id={descriptionHelperTextId}
                      className="font-mono text-xs text-[var(--foreground-muted)]"
                    >
                      {accessibilityFieldContent.description.helperText}
                    </p>
                    <FormMessage id={`${descriptionFieldId}-error`} />
                  </FormItem>
                )}
              />

              {/* Smart Start Contract */}
              <div className="space-y-4 border-2 border-[var(--border)] bg-[var(--muted)] p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                      CONTRATO DE INÍCIO
                    </Label>
                    {/* Spec 008 / US7: "obrigatórios" contradizia a orientação não bloqueante */}
                    <p className="font-mono text-xs text-[var(--foreground-muted)] mt-1">
                      Campos recomendados para{' '}
                      {selectedType ? DEMAND_TYPES[selectedType]?.label : 'selecionar tipo'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-2 w-24 border border-[var(--border)] bg-[var(--background)]">
                      <div
                        className="h-full bg-[var(--accent-lime)]"
                        style={{ width: `${readiness.score}%` }}
                      />
                    </div>
                    <span className="font-mono text-xs font-bold">{readiness.score}%</span>
                  </div>
                </div>

                {readiness.suggestedType && (
                  <div className="flex flex-col gap-3 border-2 border-[var(--accent-orange)] bg-[var(--accent-orange)]/10 p-3 md:flex-row md:items-center md:justify-between">
                    <div className="font-mono text-xs">
                      <p className="font-bold text-[var(--foreground)]">POSSÍVEL TIPO INCORRETO</p>
                      <p className="text-[var(--foreground-muted)]">
                        {readiness.suggestedType.reason} Confiança:{' '}
                        {readiness.suggestedType.confidence}%.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="cmd-button secondary whitespace-nowrap"
                      onClick={() => {
                        const nextType = readiness.suggestedType!.type;
                        setSelectedType(nextType);
                        form.setValue('type', nextType, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                        setAcceptedTypeSuggestion(true);
                        if (!form.getFieldState('priority').isDirty) {
                          form.setValue('priority', DEMAND_TYPES[nextType].suggestedPriority, {
                            shouldDirty: false,
                            shouldValidate: true,
                          });
                        }
                      }}
                    >
                      TROCAR PARA {readiness.suggestedType.label}
                    </button>
                  </div>
                )}

                {readiness.classification?.fallback &&
                  `${watchedTitle} ${watchedDescription}`.trim().length >= 12 && (
                    <div
                      className="flex flex-col gap-3 border-2 border-[var(--accent-orange)] bg-[var(--accent-orange)]/10 p-3 md:flex-row md:items-center md:justify-between"
                      role="alert"
                      data-testid="classifier-fallback-banner"
                    >
                      <div className="font-mono text-xs">
                        <p className="font-bold text-[var(--foreground)]">
                          Reclassificar manualmente?
                        </p>
                        <p className="text-[var(--foreground-muted)]">
                          A confiança do classificador ficou abaixo de 70%. A sugestão conservadora
                          é NOVA FEATURE; confirme o tipo antes de enviar.
                        </p>
                      </div>
                      {effectiveType !== 'nova_funcionalidade' && (
                        <button
                          type="button"
                          className="cmd-button secondary whitespace-nowrap"
                          onClick={() =>
                            applyDemandType(
                              'nova_funcionalidade',
                              (value) => form.setValue('type', value, { shouldDirty: true }),
                              true,
                            )
                          }
                        >
                          USAR NOVA FEATURE
                        </button>
                      )}
                    </div>
                  )}

                <div className="grid gap-3 md:grid-cols-2">
                  {selectedContract.fields.map((contractField) => (
                    <div key={contractField.id} className="space-y-2">
                      <Label
                        htmlFor={`contract-field-${contractField.id}`}
                        className="font-mono text-xs text-[var(--foreground-muted)]"
                      >
                        {contractField.label.toUpperCase()}
                      </Label>
                      <Input
                        id={`contract-field-${contractField.id}`}
                        value={contractFields[contractField.id] || ''}
                        onChange={(event) => {
                          setContractFields((current) => ({
                            ...current,
                            [contractField.id]: event.target.value,
                          }));
                        }}
                        placeholder={contractField.placeholder}
                        className="terminal-input"
                        aria-describedby={
                          contractField.description ? `${contractField.id}-description` : undefined
                        }
                      />
                      {contractField.description && (
                        <p
                          id={`${contractField.id}-description`}
                          className="font-mono text-xs text-[var(--foreground-muted)]"
                        >
                          {contractField.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                <div
                  className={cn(
                    'border-2 p-3 font-mono text-xs',
                    readiness.isComplete
                      ? 'border-[var(--success)] bg-[var(--success)]/5'
                      : 'border-[var(--accent-orange)] bg-[var(--accent-orange)]/10',
                  )}
                >
                  <p className="font-bold">{readiness.statusLabel}</p>
                  <p className="text-[var(--foreground-muted)] mt-1">{readiness.nextStep}</p>
                  {readiness.missingFields.length > 0 && (
                    <p className="text-[var(--foreground-muted)] mt-2">
                      Faltando: {readiness.missingFields.map((field) => field.label).join(', ')}
                    </p>
                  )}
                  {!readiness.isComplete && (
                    <p className="mt-2 text-[var(--accent-cyan)]">
                      Orientação não bloqueante: a squad pode refinar mesmo assim.
                    </p>
                  )}
                </div>
              </div>

              {/* Priority */}
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                      PRIORIDADE
                    </Label>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="terminal-input mt-2">
                          <SelectValue placeholder="Selecione a prioridade" />
                        </SelectTrigger>
                        <SelectContent className="bg-[var(--background)] border-2 border-[var(--border)]">
                          {priorities.map((priority) => (
                            <SelectItem
                              key={priority.value}
                              value={priority.value}
                              className={cn('font-mono', priority.color)}
                            >
                              [{priority.value.toUpperCase()}] {priority.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription className="font-mono text-xs text-[var(--foreground-muted)]">
                      Define urgência e impacto esperado para orientar a ordem de execução.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Domain */}
              <FormField
                control={form.control}
                name="domain"
                render={({ field }) => (
                  <FormItem>
                    <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                      DOMÍNIO
                    </Label>
                    <FormControl>
                      <Select value={field.value || 'padrao'} onValueChange={field.onChange}>
                        <SelectTrigger className="terminal-input mt-2">
                          <SelectValue placeholder="Selecione o domínio" />
                        </SelectTrigger>
                        <SelectContent className="bg-[var(--background)] border-2 border-[var(--border)]">
                          {demandDomains.map((domain) => (
                            <SelectItem
                              key={domain.value}
                              value={domain.value}
                              className="font-mono"
                            >
                              <span>{domain.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription className="font-mono text-xs text-[var(--foreground-muted)]">
                      Escolha o contexto operacional. Domínios especializados usam somente corpus
                      humano curado; sem corpus, a lacuna será declarada.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Size / Classificação P/M/G */}
              <FormField
                control={form.control}
                name="size"
                render={({ field }) => (
                  <FormItem>
                    <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                      CLASSIFICAÇÃO DE ESFORÇO
                    </Label>
                    <FormControl>
                      <Select
                        value={field.value || ''}
                        onValueChange={(value: string) => field.onChange(value || undefined)}
                      >
                        <SelectTrigger className="terminal-input mt-2">
                          <SelectValue placeholder="Selecione P, M ou G" />
                        </SelectTrigger>
                        <SelectContent className="bg-[var(--background)] border-2 border-[var(--border)]">
                          {demandSizes.map((size) => (
                            <SelectItem key={size.value} value={size.value} className="font-mono">
                              [{size.value}] {size.label}
                              <span className="block text-[10px] text-[var(--foreground-muted)]">
                                {size.description}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription className="font-mono text-xs text-[var(--foreground-muted)]">
                      Estimativa de esforço (Pequeno / Médio / Grande) para calibrar risco.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Refinement Type */}
              <div className="space-y-2">
                <Label className="font-mono text-xs text-[var(--foreground-muted)]">
                  TIPO DE REFINAMENTO
                </Label>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  {refinementTypes.map((refType) => {
                    const Icon = refType.icon;
                    const isActive = selectedRefinementType === refType.value;
                    const refClasses = refinementColorClasses[refType.color];
                    return (
                      <button
                        key={refType.value}
                        type="button"
                        onClick={() =>
                          setSelectedRefinementType(refType.value as 'technical' | 'business')
                        }
                        className={cn(
                          'flex flex-col items-center gap-2 p-4 border-2 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                          isActive
                            ? [refClasses.border, refClasses.bg]
                            : 'border-[var(--border)] hover:border-[var(--foreground-muted)]',
                        )}
                      >
                        <div
                          className={cn(
                            'w-10 h-10 flex items-center justify-center',
                            isActive ? refClasses.bgSolid : 'bg-[var(--muted)]',
                          )}
                        >
                          <Icon
                            className={cn(
                              'w-5 h-5',
                              isActive ? 'text-[var(--background)]' : refClasses.text,
                            )}
                          />
                        </div>
                        <span
                          className={cn(
                            'font-mono text-sm font-bold',
                            isActive && 'text-[var(--foreground)]',
                          )}
                        >
                          {refType.label}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--foreground-muted)] text-center">
                          {refType.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="font-mono text-[10px] text-[var(--foreground-muted)] mt-1">
                  O tipo define a estrutura esperada do refinamento gerado.
                </p>
              </div>

              {/* Skill.sh — Spec 10085: catálogo de skills via lockfile */}
              <div className="space-y-2">
                <Label
                  htmlFor="skill-raw-select"
                  className="font-mono text-xs text-[var(--foreground-muted)]"
                >
                  SKILL DE REFINAMENTO (OPCIONAL)
                </Label>
                <p className="font-mono text-xs text-[var(--foreground-muted)]">
                  Selecione uma skill do catálogo para enriquecer o contexto do refinamento.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <Select
                    value={skillRawUrl || '_none_'}
                    onValueChange={(value) => setSkillShUrl(value === '_none_' ? '' : value)}
                    disabled={skillsQuery.isLoading}
                  >
                    <SelectTrigger id="skill-raw-select" className="flex-1 font-mono text-sm">
                      <Zap className="w-4 h-4 mr-2 text-[var(--accent-cyan)]" />
                      <SelectValue placeholder="Selecione uma skill..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none_">Nenhuma skill</SelectItem>
                      {skillsQuery.data?.skills.map((skill) => (
                        <SelectItem key={skill.id} value={skill.rawUrl}>
                          {skill.id}
                          {skill.targetAgents.length > 0 && (
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              ({skill.targetAgents.join(', ')})
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {skillRawUrl && (
                    <button
                      type="button"
                      onClick={() => setSkillShUrl('')}
                      className="w-8 h-8 flex items-center justify-center hover:bg-[var(--destructive)]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                      aria-label="Limpar URL da skill"
                    >
                      <X className="w-4 h-4 text-[var(--destructive)]" />
                    </button>
                  )}
                </div>
                {skillsQuery.error && (
                  <p className="font-mono text-[10px] text-[var(--destructive)]">
                    Não foi possível carregar o catálogo de skills.
                  </p>
                )}
                {skillRawUrl && (
                  <p className="font-mono text-[10px] text-[var(--accent-cyan)]">
                    Skill vinculada — o conteúdo será injetado no contexto dos agentes.
                  </p>
                )}
              </div>

              {/* Spec 10015: toggle Modo Go-Live (fast-track). FR-015: só
                  aparece quando a feature flag `goLiveEnabled` está ligada. */}
              {goLiveEnabled && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isGoLive) {
                        // FR-011: ao ativar, abre modal listando as etapas puladas.
                        setShowGoLiveConfirm(true);
                      } else {
                        setIsGoLive(false);
                      }
                    }}
                    aria-pressed={isGoLive}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2.5 border-2 transition-all text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                      isGoLive
                        ? 'border-[var(--warning)] bg-[var(--warning)]/10'
                        : 'border-[var(--border)] bg-[var(--background)] hover:border-[var(--warning)]',
                    )}
                  >
                    <Zap
                      className={cn(
                        'w-4 h-4 flex-shrink-0',
                        isGoLive ? 'text-[var(--warning)]' : 'text-[var(--foreground-muted)]',
                      )}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-xs font-bold">MODO GO-LIVE (FAST-TRACK)</span>
                      <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
                        Pula validações não críticas (RAG) para iterar mais rápido em testes. Mantém
                        schema, auth e erros de API.
                      </p>
                    </div>
                    <span
                      className={cn(
                        'font-mono text-[10px] font-bold px-2 py-0.5 border',
                        isGoLive
                          ? 'border-[var(--warning)] text-[var(--warning)]'
                          : 'border-[var(--border)] text-[var(--foreground-muted)]',
                      )}
                    >
                      {isGoLive ? 'ON' : 'OFF'}
                    </span>
                  </button>
                </div>
              )}

              {/* File Upload */}
              <div className="space-y-2">
                <Label
                  htmlFor="file-upload"
                  className="font-mono text-xs text-[var(--foreground-muted)]"
                >
                  ANEXAR DOCUMENTOS (OPCIONAL)
                </Label>
                <div className={cn('upload-zone mt-2', selectedFiles && 'has-files')}>
                  <label htmlFor="file-upload" className="cursor-pointer block">
                    <Upload
                      className="w-8 h-8 mx-auto mb-3 text-[var(--foreground-muted)]"
                      aria-hidden="true"
                    />
                    <p className="font-mono text-sm">
                      Arraste arquivos ou{' '}
                      <span className="text-[var(--accent-cyan)] underline">
                        clique para selecionar
                      </span>
                    </p>
                    <p className="font-mono text-xs text-[var(--foreground-muted)] mt-1">
                      Formatos: .txt, .pdf, .docx
                    </p>
                    <input
                      id="file-upload"
                      type="file"
                      className="sr-only"
                      accept=".txt,.pdf,.docx"
                      multiple
                      onChange={handleFileChange}
                      aria-describedby="file-upload-formats"
                    />
                    <span id="file-upload-formats" className="sr-only">
                      Formatos aceitos: txt, pdf, docx
                    </span>
                  </label>
                </div>

                {/* File List */}
                {selectedFiles && (
                  <div className="space-y-2 mt-3">
                    {Array.from(selectedFiles).map((file, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 border border-[var(--border)] bg-[var(--muted)]"
                      >
                        <div className="flex items-center gap-2 font-mono text-xs truncate">
                          <span className="text-[var(--success)]">✓</span>
                          <span className="truncate">{file.name}</span>
                          <span className="text-[var(--foreground-muted)]">
                            ({Math.round(file.size / 1024)}KB)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveFile(index)}
                          className="w-6 h-6 flex items-center justify-center hover:bg-[var(--destructive)]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                          aria-label={`Remover ${file.name}`}
                        >
                          <X className="w-3 h-3 text-[var(--destructive)]" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Submit Button — mesa redonda automática (agentes decididos pelo backend) */}
              <div className="pt-4 space-y-2">
                <p
                  className="font-mono text-xs text-[var(--foreground-muted)] leading-relaxed"
                  data-testid="unified-refinement-banner"
                >
                  <span className="text-[var(--foreground)] font-bold">Mesa redonda:</span> a squad
                  debate e estrutura sua demanda automaticamente.
                </p>
                <button
                  type="submit"
                  disabled={createDemandMutation.isPending}
                  className={cn(
                    'cmd-button primary w-full flex items-center justify-center gap-2',
                    createDemandMutation.isPending && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {createDemandMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>PROCESSANDO...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>REFINAR DEMANDA</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </Form>
        </div>
      )}

      {/* Spec 10015 FR-011: modal de confirmação listando as etapas puladas
          ao ativar o modo go-live. */}
      {showGoLiveConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="golive-confirm-title"
          data-testid="golive-confirm-modal"
        >
          <div className="bg-[var(--background)] border-2 border-[var(--warning)] p-6 max-w-md font-mono">
            <h2 id="golive-confirm-title" className="text-sm font-bold text-[var(--warning)]">
              MODO GO-LIVE (FAST-TRACK)
            </h2>
            <p className="text-xs mt-2 text-[var(--foreground)]">
              As seguintes etapas não críticas serão <strong>puladas</strong> nesta demanda:
            </p>
            <ul className="text-xs mt-2 space-y-1 text-[var(--foreground-muted)]">
              <li>• RAG quality (enriquecimento de contexto por retrieval)</li>
              <li>• Guardrails de conteúdo (passada semântica em modo shadow)</li>
            </ul>
            <p className="text-xs mt-3 text-[var(--foreground)]">
              Validações críticas <strong>permanecem ativas</strong>: schema (Zod), autenticação e
              erros de API.
            </p>
            <p className="text-[10px] mt-3 text-[var(--foreground-muted)]">
              Atenção: em demandas complexas, pular RAG pode reduzir a qualidade do refinamento.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                className="px-3 py-1.5 text-xs border border-[var(--border)] hover:bg-[var(--muted)]"
                onClick={() => setShowGoLiveConfirm(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs border-2 border-[var(--warning)] text-[var(--warning)] font-bold hover:bg-[var(--warning)]/10"
                onClick={() => {
                  setIsGoLive(true);
                  setShowGoLiveConfirm(false);
                }}
                data-testid="golive-confirm-accept"
              >
                Ativar go-live
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
