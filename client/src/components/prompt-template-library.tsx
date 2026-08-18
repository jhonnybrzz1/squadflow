import { Clipboard, FileSearch, Flag, Globe, Hammer, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const promptTemplates = [
  {
    name: 'Feature Simples',
    icon: Wand2,
    prompt:
      'Implementar uma feature simples. Descreva objetivo, usuário impactado, arquivo provável, critérios de aceite e menor MVP possível.',
  },
  {
    name: 'Bugfix',
    icon: Flag,
    prompt:
      'Corrigir bug reproduzível. Informe comportamento atual, esperado, passos de reprodução, evidência de log e hipótese técnica inicial.',
  },
  {
    name: 'Refatoração',
    icon: Hammer,
    prompt:
      'Refatorar código sem mudar comportamento. Liste arquivos-alvo, acoplamentos, risco de regressão, testes de proteção e ordem segura de mudança.',
  },
  {
    name: 'Landing Page',
    icon: Globe,
    prompt:
      'Criar landing page enxuta. Defina ICP, promessa principal, seções mínimas, CTA, métricas de conversão e copy inicial.',
  },
  {
    name: 'Pesquisa de API',
    icon: FileSearch,
    prompt:
      'Pesquisar uma API externa. Validar autenticação, endpoints necessários, limites, payloads, riscos, custo e prova mínima com curl.',
  },
];

export function PromptTemplateLibrary() {
  const copyPrompt = async (prompt: string) => {
    await navigator.clipboard?.writeText(prompt);
  };

  return (
    <div className="neo-card">
      <div className="border-b-2 border-[var(--border)] bg-[var(--muted)] p-4">
        <h3 className="font-mono text-sm font-bold uppercase tracking-wide">Templates rápidos</h3>
      </div>
      <div className="space-y-2 p-4">
        {promptTemplates.map(({ name, icon: Icon, prompt }) => (
          <Button
            key={name}
            type="button"
            variant="outline"
            className="h-auto w-full justify-start gap-2 whitespace-normal py-2 text-left font-mono text-xs"
            onClick={() => copyPrompt(prompt)}
            title={prompt}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{name}</span>
            <Clipboard className="h-3 w-3 shrink-0 opacity-60" />
          </Button>
        ))}
      </div>
    </div>
  );
}
