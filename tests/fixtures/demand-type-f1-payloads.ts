export type F1ClassifierPayload = {
  id: string;
  title: string;
  description: string;
  expected: 'security' | 'refactoring' | 'fallback';
};

export const F1_CLASSIFIER_PAYLOADS: F1ClassifierPayload[] = [
  {
    id: 'security-01',
    title: 'Adequar consentimento à LGPD',
    description: 'Revisar dados pessoais e privacidade no fluxo de cadastro.',
    expected: 'security',
  },
  {
    id: 'security-02',
    title: 'Corrigir vulnerabilidade de autenticação',
    description: 'Há risco de ataque e falha de autorização na API.',
    expected: 'security',
  },
  {
    id: 'security-03',
    title: 'Criptografia de credenciais',
    description: 'Aplicar segurança e proteção de dados às credenciais armazenadas.',
    expected: 'security',
  },
  {
    id: 'security-04',
    title: 'Privacy by design',
    description: 'Validar compliance e LGPD no tratamento de dados pessoais.',
    expected: 'security',
  },
  {
    id: 'security-05',
    title: 'Threat model do login',
    description: 'Mapear ameaça, ataque e vulnerabilidade na autenticação.',
    expected: 'security',
  },
  {
    id: 'security-06',
    title: 'Revisão de autorização',
    description: 'Auditar security e privacidade dos perfis administrativos.',
    expected: 'security',
  },
  {
    id: 'security-07',
    title: 'Incidente com dados pessoais',
    description: 'Avaliar LGPD, proteção de dados e mitigação de vulnerabilidade.',
    expected: 'security',
  },
  {
    id: 'refactoring-01',
    title: 'Refatorar módulo legado',
    description: 'Reduzir acoplamento e dívida técnica sem mudar comportamento.',
    expected: 'refactoring',
  },
  {
    id: 'refactoring-02',
    title: 'Eliminar code smell',
    description: 'Fazer refactoring e desacoplar o serviço de notificações.',
    expected: 'refactoring',
  },
  {
    id: 'refactoring-03',
    title: 'Reestruturar código de pagamentos',
    description: 'O código legado acumula débito técnico e acoplamento.',
    expected: 'refactoring',
  },
  {
    id: 'refactoring-04',
    title: 'Refatoração incremental',
    description: 'Desacoplar componentes e remover dívida técnica com regressão.',
    expected: 'refactoring',
  },
  {
    id: 'refactoring-05',
    title: 'Modernizar legacy code',
    description: 'Refatorar o módulo para reduzir acoplamento interno.',
    expected: 'refactoring',
  },
  {
    id: 'refactoring-06',
    title: 'Tratar débito técnico',
    description: 'Reestruturar código e eliminar code smell preservando APIs.',
    expected: 'refactoring',
  },
  {
    id: 'refactoring-07',
    title: 'Desacoplar domínio',
    description: 'Refactoring do código legado para reduzir dívida técnica.',
    expected: 'refactoring',
  },
  {
    id: 'ambiguous-01',
    title: 'Ajustar fluxo',
    description: 'Precisamos revisar uma parte da experiência.',
    expected: 'fallback',
  },
  {
    id: 'ambiguous-02',
    title: 'Pedido do comercial',
    description: 'Verificar se dá para atender a solicitação.',
    expected: 'fallback',
  },
  {
    id: 'ambiguous-03',
    title: 'Melhorar tela',
    description: 'Rever o comportamento conforme necessário.',
    expected: 'fallback',
  },
  {
    id: 'ambiguous-04',
    title: 'Analisar melhoria',
    description: 'Avaliar dados e performance antes de decidir.',
    expected: 'fallback',
  },
  {
    id: 'ambiguous-05',
    title: 'Cadastro inconsistente',
    description: 'Pode ser uma falha ou uma mudança de comportamento.',
    expected: 'fallback',
  },
  {
    id: 'ambiguous-06',
    title: 'Revisão geral',
    description: 'Investigar o melhor caminho para o produto.',
    expected: 'fallback',
  },
];
