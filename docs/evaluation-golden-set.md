# Golden Set de Avaliação - Prompt de Consolidação

Este documento contém o golden set oficial para a avaliação semântica do prompt de consolidação de mesa redonda (`consolidate`).

## Rubrica de Avaliação

Cada resposta de consolidação gerada pelo prompt-alvo é avaliada em relação à resposta ideal em uma escala de 0 a 5 para cada um dos critérios abaixo:

1. **Completude (0-5)**: A resposta em JSON cobre todos os campos obrigatórios e fornece detalhes suficientes para cada seção?
   - **0 (Crítico)**: Campos centrais como "problema", "objetivo", "escopo" ou "consolidacao" estão ausentes ou vazios.
   - **3 (Aceitável)**: Todos os campos estão presentes, mas 1 ou 2 seções (como "riscos" ou "criterios_de_aceite") estão superficiais ou com descrições genéricas/insuficientes.
   - **5 (Ideal)**: Todos os 8 campos estão preenchidos de forma rica, detalhada e cobrem plenamente a discussão ocorrida.

2. **Precisão/Correção (0-5)**: A consolidação reflete dados verdadeiros e evita inventar números, baselines, prazos ou ROIs fabricados?
   - **0 (Crítico)**: Inventa dados factuais, percentuais de ganho ou baselines (ex: inventa "redução de 80%" sem fonte).
   - **3 (Aceitável)**: Não inventa números, mas faz inferências qualitativas um pouco ousadas que não estavam explícitas no debate.
   - **5 (Ideal)**: Absolutamente preciso. Segue rigorosamente a Regra de Integridade Numérica. Usa "A MEDIR — sem baseline" ou "Definir após coletar baseline" quando o dado não foi fornecido.

3. **Aderência ao Contexto (0-5)**: A consolidação foca especificamente no escopo da demanda avaliada ou inclui generalidades vagas?
   - **0 (Crítico)**: Resposta genérica que poderia servir para qualquer software ou projeto de TI, ignorando a demanda específica.
   - **3 (Aceitável)**: Cita termos específicos da demanda, mas o tom do resumo ou escopo é genérico em partes importantes.
   - **5 (Ideal)**: Totalmente contextualizado, capturando os termos técnicos específicos, restrições e divergências discutidos no debate.

---

## Processo de manutenção do Golden Set

- Toda inclusão ou alteração deve passar por pull request e revisão humana.
- Casos precisam registrar demanda, contexto, resposta esperada e justificativa da curadoria.
- Bugs de qualidade corrigidos devem ganhar um caso de regressão antes do merge.
- Casos holdout não devem ser usados para ajustar diretamente o prompt avaliado.
- Mudanças de nota humana exigem justificativa no PR e revisão por pelo menos outra pessoa.
- Exemplos sintéticos devem ser identificados; não devem ser apresentados como incidentes de produção.

## Casos de Teste (Golden Set)

### Caso 1: Autenticação SSO em API Corporativa

- **Tipo**: calibracao
- **Demanda original**:
  Título: Integrar autenticação SSO via OAuth2
  Descrição: Implementar login único para funcionários usando o provedor de identidade corporativo.
- **Histórico do debate**:
  [product_owner]: Precisamos garantir que todos os colaboradores entrem usando as contas existentes no Okta.
  [tech_lead]: A integração deve usar a biblioteca oficial e expor a rota de callback em /api/auth/callback. O esforço é de cerca de 3 dias.
  [qa]: Precisamos garantir o teste de expiração de token e fluxo de login incorreto.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de login único (SSO) centralizado para os funcionários no sistema, forçando autenticação manual separada.",
  "objetivo": "Implementar a integração de autenticação única SSO via OAuth2 usando o Okta como provedor de identidade corporativo.",
  "escopo": "Desenvolvimento do fluxo de autenticação Okta OAuth2, configuração do callback na rota /api/auth/callback e uso de bibliotecas oficiais.",
  "criterios_de_aceite": [
    "Funcionários autenticam com credenciais corporativas do Okta com sucesso.",
    "Tokens de acesso e refresh são gerenciados e expiram conforme política corporativa.",
    "Tentativas de autenticação inválidas ou com falha no Okta são tratadas amigavelmente na interface do usuário."
  ],
  "riscos": [
    "Indisponibilidade do serviço do Okta impede temporariamente o acesso de novos colaboradores."
  ],
  "dependencias": [
    "Acesso às chaves e configurações da conta corporativa do Okta em ambiente de teste."
  ],
  "divergencias": [],
  "consolidacao": "A mesa redonda concluiu a especificação para integração da autenticação única corporativa via Okta. O escopo técnico abrange a configuração do protocolo OAuth2 com rota específica de callback, tendo um tempo estimado qualitativo pelo time de engenharia. Os testes cobrirão fluxos de sucesso, erros e ciclo de vida do token."
}
```

### Caso 2: Otimização de Performance em Banco de Dados

- **Tipo**: calibracao
- **Demanda original**:
  Título: Otimizar queries lentas no painel de vendas
  Descrição: Reduzir a latência do painel administrativo. Não temos a latência atual medida em produção.
- **Histórico do debate**:
  [product_owner]: O dashboard está demorando muito para carregar nos horários de pico.
  [tech_lead]: Identifiquei que as consultas de agregação de vendas estão sem índices. Vou criar índices compostos nas colunas de data e status.
  [qa]: Também precisamos verificar o caching na API para não sobrecarregar o banco de dados.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Lentidão acentuada no carregamento do painel administrativo de vendas nos horários de maior tráfego.",
  "objetivo": "Reduzir a latência das consultas lentas no dashboard de vendas por meio de otimização de banco de dados e estratégias de cache.",
  "escopo": "Criação de índices compostos em colunas críticas (data e status) e implementação de camada de caching nas rotas de agregação de vendas.",
  "criterios_de_aceite": [
    "O painel administrativo exibe os dados sem gargalos no banco de dados.",
    "Consultas agregadas utilizam os índices criados e evitam varreduras completas da tabela.",
    "A camada de cache é invalidada periodicamente para assegurar dados recentes no dashboard."
  ],
  "riscos": [
    "Indices novos aumentarem o tempo de gravação/escrita nas tabelas principais se não forem balanceados."
  ],
  "dependencias": [
    "Acesso de administrador ao banco de dados para criar e analisar planos de execução de queries lentas."
  ],
  "divergencias": [],
  "consolidacao": "A mesa definiu a estratégia para resolver o problema de latência no painel administrativo de vendas. Serão aplicadas melhorias físicas de indexação em colunas chave (data, status) aliadas à inclusão de caching para aliviar as leituras recorrentes, sem métricas quantitativas de baseline definidas de antemão."
}
```

### Caso 3: Relatório Financeiro PDF

- **Tipo**: calibracao
- **Demanda original**:
  Título: Geração de Relatório Financeiro Mensal em PDF
  Descrição: Exportar dados de faturamento em arquivo PDF com design limpo.
- **Histórico do debate**:
  [product_owner]: O cliente precisa extrair o fechamento financeiro em formato PDF para contabilidade.
  [tech_lead]: Usaremos a biblioteca pdf-lib para gerar no backend de forma assíncrona.
  [qa]: Precisamos validar se o layout do PDF é quebrado com volumes muito grandes de transações (paginação).
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Falta de suporte para exportar o fechamento de faturamento mensal em arquivo PDF para fins de contabilidade dos clientes.",
  "objetivo": "Disponibilizar funcionalidade de geração e download de relatórios financeiros mensais no formato PDF de forma limpa e estruturada.",
  "escopo": "Implementação da rota backend para compilação de dados financeiros, geração assíncrona do PDF via biblioteca pdf-lib e layout responsivo de paginação.",
  "criterios_de_aceite": [
    "Arquivo gerado possui extensão PDF válida e layout alinhado com a identidade visual básica.",
    "O relatório paginal lida corretamente com relatórios volumosos sem truncar informações ou sobrepor cabeçalhos.",
    "Download do arquivo é iniciado após o clique no botão correspondente da UI financeira."
  ],
  "riscos": [
    "Estouro de memória no servidor ao gerar PDF com milhares de linhas caso o volume de dados seja desproporcional."
  ],
  "dependencias": [
    "Layout básico e definição dos campos financeiros obrigatórios homologados pelo time de finanças."
  ],
  "divergencias": [],
  "consolidacao": "Foi acordado o desenvolvimento da funcionalidade de exportação de relatórios financeiros em formato PDF assíncrono. O desenvolvimento técnico usará a pdf-lib com foco na paginação correta do relatório para evitar quebras estruturais quando houver alta volumetria."
}
```

### Caso 4: Refatoração do Fluxo de Cadastro de Usuário

- **Tipo**: calibracao
- **Demanda original**:
  Título: Simplificar fluxo de registro de novos usuários
  Descrição: Reduzir campos obrigatórios no formulário de cadastro. Queremos otimizar o percentual de conversão.
- **Histórico do debate**:
  [product_owner]: Nosso formulário atual pede 15 campos. A maioria dos usuários desiste antes de concluir.
  [tech_lead]: Podemos reduzir para apenas 3 campos: nome, e-mail e senha. As outras informações podem ser solicitadas pós-cadastro.
  [qa]: Com apenas 3 campos, precisamos garantir que o e-mail seja validado imediatamente contra duplicidade em background.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Alta taxa de rejeição no cadastro de novos usuários provocada por um formulário de registro excessivamente longo (15 campos).",
  "objetivo": "Reduzir o formulário de cadastro inicial para melhorar a taxa de conversão geral de novos registros.",
  "escopo": "Redução dos campos do formulário para e-mail, nome e senha, transferindo as demais informações para a etapa de onboarding pós-registro.",
  "criterios_de_aceite": [
    "Cadastro inicial solicita somente e-mail, nome e senha no fluxo principal.",
    "Validação em background impede a duplicação de e-mails em tempo real no formulário.",
    "Fluxo de onboarding pós-registro direciona o usuário para completar o perfil de forma não obstrutiva."
  ],
  "riscos": [
    "Queda no preenchimento de dados de perfil secundários se o fluxo pós-cadastro for mal desenhado."
  ],
  "dependencias": [
    "Aprovação do layout UX para os fluxos unificados de registro rápido e onboarding subsequente."
  ],
  "divergencias": [],
  "consolidacao": "Decidiu-se pela simplificação do formulário de cadastro inicial, limitando-o a 3 campos fundamentais. A coleta das informações adicionais ocorrerá de forma gradual pós-registro para evitar atrito no funil de entrada de novos usuários."
}
```

### Caso 5: Suporte a Upload de Avatar de Usuário

- **Tipo**: calibracao
- **Demanda original**:
  Título: Upload de imagem de avatar do perfil
  Descrição: Permitir que o usuário envie uma imagem de perfil e salve no bucket do Cloud Storage.
- **Histórico do debate**:
  [product_owner]: Os usuários querem personalizar a conta enviando foto.
  [tech_lead]: Implementaremos upload via Firebase/GCS com limite de tamanho de arquivo de 2MB. A imagem deve ser redimensionada no client para poupar tráfego.
  [qa]: Devemos barrar extensões não permitidas (.exe, .sh, etc.) para evitar brechas de segurança.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Falta de opção para personalização visual das contas de usuário por meio do envio de imagens de perfil.",
  "objetivo": "Disponibilizar funcionalidade de upload e armazenamento de fotos de perfil (avatar) em repositório na nuvem.",
  "escopo": "Desenvolvimento do componente de upload na interface, validação e redimensionamento no frontend e integração de salvamento no bucket Cloud Storage.",
  "criterios_de_aceite": [
    "Usuário consegue enviar fotos em formatos comuns (PNG, JPEG) de até 2MB.",
    "Arquivos maliciosos ou com extensões perigosas são rejeitados no backend.",
    "O avatar atualizado é exibido imediatamente no cabeçalho do painel após o upload."
  ],
  "riscos": [
    "Sobrecarga no bucket por uploads repetidos caso não exista invalidação ou substituição de foto antiga."
  ],
  "dependencias": [
    "Configuração de permissões de gravação de arquivos de mídia (CORS/IAM) no Cloud Storage."
  ],
  "divergencias": [],
  "consolidacao": "A mesa validou o suporte ao envio de fotos de perfil com limite máximo de 2MB por arquivo. O upload utilizará armazenamento no Cloud Storage com validações críticas de segurança aplicadas no backend e redimensionamento de imagem executado pelo frontend."
}
```

### Caso 6: Agendamento de Notificações Push (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Agendamento de envio de Push Notifications
  Descrição: Criar painel administrativo para programar mensagens push.
- **Histórico do debate**:
  [product_owner]: O time de marketing precisa programar mensagens push para disparar em datas comemorativas específicas.
  [tech_lead]: Usaremos um cron job no backend com agenda do node-cron para varrer registros agendados a cada 1 minuto.
  [qa]: Precisamos de logs detalhados para confirmar se o push foi enviado no minuto exato e o que falhou em lote.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Impossibilidade de programar o envio automatizado de notificações push para disparos em datas e horários específicos de marketing.",
  "objetivo": "Fornecer um painel administrativo para agendamento de campanhas de notificação push automatizadas.",
  "escopo": "Criação da interface de agendamento, configuração do agendador node-cron no backend e persistência das tarefas programadas no banco de dados.",
  "criterios_de_aceite": [
    "Notificações agendadas são disparadas corretamente de acordo com o agendamento.",
    "O painel administrativo lista os agendamentos pendentes, enviados e com falha.",
    "O sistema gera registros de logs detalhados do resultado de envio de cada lote de mensagens."
  ],
  "riscos": ["Atraso no disparo caso o servidor esteja sobrecarregado no minuto exato programado."],
  "dependencias": ["Credenciais ativas e cotas suficientes no serviço de gateway de push externo."],
  "divergencias": [],
  "consolidacao": "Definiu-se a implementação do painel e motor de agendamentos push utilizando cron do backend. A execução do envio varrerá as pendências minuto a minuto gerando logs ricos de auditoria para acompanhamento de eventuais problemas de comunicação."
}
```

### Caso 7: Exportação de CSV de Pedidos (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Exportação de Pedidos em formato CSV
  Descrição: Botão na listagem de pedidos para exportar em lote.
- **Histórico do debate**:
  [product_owner]: Os lojistas precisam baixar planilhas de pedidos para enviar aos sistemas de logística física.
  [tech_lead]: Vou gerar o CSV sob demanda via streams de escrita no Node.js para que não dê estouro de memória no servidor.
  [qa]: A exportação deve respeitar os filtros (busca por texto, data) aplicados na listagem de pedidos.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Lojistas sem meio de exportar dados de pedidos em formato de planilha legível para repasse logístico externo.",
  "objetivo": "Disponibilizar funcionalidade de exportação em lote de pedidos no formato CSV respeitando os filtros de pesquisa ativos na interface.",
  "escopo": "Criação do endpoint de exportação via stream assíncrona no backend e inclusão do botão 'Exportar' integrado com os filtros vigentes na listagem de pedidos.",
  "criterios_de_aceite": [
    "Arquivo CSV baixado contém as colunas essenciais de pedidos alinhadas corretamente.",
    "O CSV reflete precisamente os filtros de data e busca aplicados na interface no momento do clique.",
    "Geração de dados volumosos utiliza streams no Node.js mantendo o consumo de memória do servidor estável."
  ],
  "riscos": [
    "Lentidão no download de planilhas gigantescas se o banco de dados não possuir paginação adequada."
  ],
  "dependencias": [
    "Mapeamento exato e homologação do cabeçalho de colunas exigido pelas transportadoras físicas."
  ],
  "divergencias": [],
  "consolidacao": "Foi acordado o desenvolvimento do exportador de pedidos para planilhas CSV sob demanda. Para garantir eficiência e estabilidade, a rotina backend utilizará streams de dados, aplicando fielmente os filtros selecionados pelo usuário na tela administrativa."
}
```

### Caso 8: Integração de Gateway de Pagamento (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Integração com Gateway de Pagamento Stripe
  Descrição: Integrar checkout por cartão de crédito na tela de pagamento.
- **Histórico do debate**:
  [product_owner]: Precisamos aceitar cartões de crédito internacionais diretamente na nossa plataforma.
  [tech_lead]: A integração deve usar a biblioteca oficial do Stripe e webhook em /api/webhooks/stripe para confirmar pagamento.
  [qa]: O checkout precisa cobrir casos de transações recusadas ou sem saldo para exibir feedbacks claros de erro.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Falta de suporte para aceitar pagamentos com cartões de crédito na plataforma para fins de cobrança global.",
  "objetivo": "Integrar a plataforma ao gateway Stripe para viabilizar transações com cartão de crédito internacional de forma segura e transparente.",
  "escopo": "Configuração da biblioteca SDK Stripe, desenvolvimento do checkout seguro e implementação da rota de webhook /api/webhooks/stripe para confirmação assíncrona.",
  "criterios_de_aceite": [
    "Usuário realiza pagamentos de assinaturas ou produtos usando cartão de crédito internacional via checkout do Stripe.",
    "O sistema atualiza o status de pagamento do pedido no banco de dados via webhook corporativo do Stripe com sucesso.",
    "Erros de transação como saldo insuficiente ou cartão recusado geram alertas instrucionais claros para o usuário."
  ],
  "riscos": [
    "Falhas de conexão na rota do webhook podem causar atrasos na liberação de produtos pagos pelos clientes."
  ],
  "dependencias": [
    "Conta de desenvolvedor do Stripe ativa com chaves de API secretas e públicas cadastradas no ambiente."
  ],
  "divergencias": [],
  "consolidacao": "Definiu-se a integração oficial da cobrança via Stripe no checkout da plataforma. A confirmação de sucesso ocorrerá em tempo real por meio de rotas específicas de webhook, tendo tratamento explícito de respostas de erro na interface para transações rejeitadas."
}
```

### Caso 9: Notificações Push em App Mobile

- **Tipo**: calibracao
- **Demanda original**:
  Título: Implementar notificações push para novidades do feed
  Descrição: Enviar notificações aos usuários quando houver novos conteúdos relevantes no feed.
- **Histórico do debate**:
  [product_owner]: O engajamento caiu. Queremos notificar o usuário quando há novo conteúdo relevante.
  [tech_lead]: Vamos usar Firebase Cloud Messaging. Precisamos de um serviço de tópicos para segmentar por interesse.
  [qa]: Testar cenários de permissão negada e token expirado.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Baixo engajamento dos usuários com o feed devido à ausência de notificações proativas sobre novos conteúdos.",
  "objetivo": "Implementar notificações push via Firebase Cloud Messaging para alertar usuários sobre novidades relevantes no feed.",
  "escopo": "Integração com FCM, serviço de inscrição em tópicos por interesse, disparo de notificações em eventos de novo conteúdo e tratamento de permissões.",
  "criterios_de_aceite": [
    "Usuário recebe notificação push quando novo conteúdo relevante ao seu interesse é publicado.",
    "Usuário pode gerenciar preferências de notificação por tópico nas configurações.",
    "Cenários de permissão negada e token expirado são tratados sem erro no backend."
  ],
  "riscos": [
    "Alto volume de notificações pode gerar opt-out se a segmentação por interesse não for respeitada."
  ],
  "dependencias": ["Configuração do projeto Firebase e chaves de API no ambiente backend."],
  "divergencias": [],
  "consolidacao": "A mesa definiu a implementação de notificações push via Firebase Cloud Messaging com segmentação por tópicos de interesse. O fluxo inclui gestão de permissões e tratamento de tokens expirados, com critérios de aceite cobrindo a experiência do usuário e a robustez do backend."
}
```

### Caso 10: Cache Redis para API de Catálogo

- **Tipo**: calibracao
- **Demanda original**:
  Título: Adicionar cache Redis para reduzir latência do catálogo
  Descrição: O endpoint de catálogo tem latência alta em horários de pico.
- **Histórico do debate**:
  [product_owner]: O catálogo está lento no pico. Precisamos reduzir a latência.
  [tech_lead]: Vamos usar Redis com TTL de 5 minutos para o endpoint GET /catalog. Invalidação por evento de update.
  [qa]: Precisamos garantir que um update invalida o cache imediatamente.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Latência elevada no endpoint de catálogo durante horários de pico, degradando a experiência de navegação.",
  "objetivo": "Implementar cache Redis para o endpoint GET /catalog reduzindo a latência em horários de pico.",
  "escopo": "Integração com Redis, cache com TTL de 5 minutos no endpoint de catálogo e invalidação por evento de update de produto.",
  "criterios_de_aceite": [
    "Endpoint GET /catalog responde em menos de 100ms com cache quente.",
    "Atualizações de produto invalidam o cache imediatamente sem servir dados stale.",
    "Falha de conexão com Redis faz o backend cair gracefully para o banco sem erro 500."
  ],
  "riscos": ["Dados stale se a invalidação por evento falhar silenciosamente."],
  "dependencias": ["Instância Redis disponível e acessível pelo backend."],
  "divergencias": [],
  "consolidacao": "Acordou-se o uso de Redis com TTL de 5 minutos para o catálogo, com invalidação orientada a eventos de update. O design inclui fallback graceful para o banco em caso de indisponibilidade do Redis."
}
```

### Caso 11: Exportação de Relatório em PDF

- **Tipo**: calibracao
- **Demanda original**:
  Título: Gerar relatório mensal de vendas em PDF
  Descrição: O time comercial precisa de um PDF com o resumo mensal de vendas.
- **Histórico do debate**:
  [product_owner]: O time comercial quer um PDF mensal automático.
  [tech_lead]: Vamos usar Puppeteer para gerar o PDF a partir de um template HTML. Agendamento via cron no último dia do mês.
  [qa]: Validar formatação com dados reais e dados vazios (mês sem vendas).
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de um relatório mensal automatizado em PDF para o time comercial acompanhar o resumo de vendas.",
  "objetivo": "Gerar automaticamente um relatório PDF mensal de vendas e disponibilizá-lo para o time comercial.",
  "escopo": "Geração de PDF via Puppeteer a partir de template HTML, agendamento cron no último dia do mês e envio por email ou download no painel.",
  "criterios_de_aceite": [
    "Relatório PDF é gerado automaticamente no último dia de cada mês.",
    "PDF contém tabelas de vendas com formatação legível mesmo para meses sem vendas.",
    "Time comercial recebe o PDF por email ou consegue baixá-lo no painel administrativo."
  ],
  "riscos": [
    "Geração do PDF via Puppeteer pode consumir memória significativa em meses com alto volume de dados."
  ],
  "dependencias": ["Servidor com Puppeteer e Chromium instalados."],
  "divergencias": [],
  "consolidacao": "Definiu-se a geração automatizada do relatório mensal de vendas em PDF usando Puppeteer com agendamento cron. O fluxo prevê tratamento de meses sem vendas e entrega por email ou painel."
}
```

### Caso 12: Webhook de Status de Pedido

- **Tipo**: calibracao
- **Demanda original**:
  Título: Receber webhook de status de pedido do parceiro logístico
  Descrição: Integrar webhook do parceiro para atualizar status de pedido em tempo real.
- **Histórico do debate**:
  [product_owner]: O cliente quer ver o status do pedido em tempo real.
  [tech_lead]: Vamos expor POST /api/webhooks/logistics com assinatura HMAC. Idempotência por event_id.
  [qa]: Testar replay de webhook e assinatura inválida.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Status dos pedidos não é atualizado em tempo real por falta de integração com o webhook do parceiro logístico.",
  "objetivo": "Receber webhooks do parceiro logístico e atualizar o status dos pedidos em tempo real no sistema.",
  "escopo": "Endpoint POST /api/webhooks/logistics com validação de assinatura HMAC, idempotência por event_id e atualização do status do pedido.",
  "criterios_de_aceite": [
    "Webhook com assinatura HMAC válida atualiza o status do pedido em até 2 segundos.",
    "Replay de webhook com mesmo event_id não duplica a atualização (idempotência).",
    "Webhook com assinatura inválida retorna 401 e não altera o pedido."
  ],
  "riscos": [
    "Parceiro envia webhooks fora de ordem, gerando status inconsistente se não houver versão/sequence."
  ],
  "dependencias": ["Chave secreta compartilhada com o parceiro logístico para HMAC."],
  "divergencias": [],
  "consolidacao": "A mesa definiu o endpoint de webhook logístico com validação HMAC e idempotência por event_id. O design prevê tratamento de replay e assinatura inválida, com atualização em tempo real do status do pedido."
}
```

### Caso 13: Busca Full-Text no Catálogo

- **Tipo**: calibracao
- **Demanda original**:
  Título: Implementar busca full-text no catálogo de produtos
  Descrição: Usuários não encontram produtos por termos parciais ou typos.
- **Histórico do debate**:
  [product_owner]: Busca atual só funciona com match exato. Usuários reclamam.
  [tech_lead]: Vamos usar pgvector + trigram para tolerância a typos. Reindexar via job noturno.
  [qa]: Testar busca com typos, acentos e termos parciais.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Busca atual do catálogo só funciona com correspondência exata, impedindo usuários de encontrar produtos por termos parciais ou typos.",
  "objetivo": "Implementar busca full-text com tolerância a typos e acentos no catálogo de produtos.",
  "escopo": "Uso de pgvector e trigram no Postgres, reindexação via job noturno e ajuste do endpoint de busca para suportar termos parciais.",
  "criterios_de_aceite": [
    "Busca por termo com typo retorna o produto correto nos top 5 resultados.",
    "Busca com acento retorna o mesmo resultado que busca sem acento.",
    "Reindexação noturna não degrada a latência das buscas em produção."
  ],
  "riscos": [
    "Reindexação noturna pode consumir recursos significativos se o catálogo for muito grande."
  ],
  "dependencias": ["Extensão pg_trgm e pgvector habilitadas no Postgres."],
  "divergencias": [],
  "consolidacao": "Acordou-se a implementação de busca full-text com pgvector e trigram para tolerância a typos e acentos, com reindexação noturna. O design prevê critérios de aceite cobrindo typos, acentos e impacto de performance da reindexação."
}
```

### Caso 14: Rate Limiting por Usuário

- **Tipo**: calibracao
- **Demanda original**:
  Título: Adicionar rate limiting por usuário na API pública
  Descrição: Alguns clientes abusam da API com requisições em rajada.
- **Histórico do debate**:
  [product_owner]: Alguns clientes fazem rajadas e degradam o serviço para outros.
  [tech_lead]: Vamos usar token bucket por API key com limite de 100 req/min. Resposta 429 com Retry-After.
  [qa]: Testar rajada de 200 req e confirmar 429 após o limite.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de rate limiting por usuário na API pública permite que clientes em rajada degraduem o serviço para os demais.",
  "objetivo": "Implementar rate limiting por API key na API pública para proteger o serviço de rajadas abusivas.",
  "escopo": "Algoritmo token bucket por API key com limite de 100 requisições por minuto, resposta 429 com header Retry-After e logs de throttling.",
  "criterios_de_aceite": [
    "Cliente que excede 100 req/min recebe 429 com header Retry-After correto.",
    "Cliente dentro do limite não é afetado em sua taxa de sucesso.",
    "Eventos de throttling são logados com a API key para auditoria."
  ],
  "riscos": ["Limite de 100 req/min pode ser baixo para clientes legítimos com alto volume."],
  "dependencias": [
    "Camada de armazenamento compartilhado (Redis) para contagem de tokens em múltiplas instâncias."
  ],
  "divergencias": [],
  "consolidacao": "A mesa definiu rate limiting via token bucket por API key com limite de 100 req/min e resposta 429 com Retry-After. O design inclui logs de auditoria e dependência de Redis para contagem distribuída."
}
```

### Caso 15: Migração de Dados de Legacy

- **Tipo**: calibracao
- **Demanda original**:
  Título: Migrar dados de clientes do sistema legacy
  Descrição: Migrar 50k clientes do sistema antigo para o novo, com validação.
- **Histórico do debate**:
  [product_owner]: Precisamos migrar os 50k clientes do sistema legacy sem downtime.
  [tech_lead]: Vamos fazer migração em batches de 1000 com validação por checksum. Janela de manutenção de 2h.
  [qa]: Validar 100% dos registros migrados com diff de checksum.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Necessidade de migrar 50.000 clientes do sistema legacy para o novo sistema sem downtime e com garantia de integridade.",
  "objetivo": "Migrar todos os 50.000 clientes do sistema legacy para o novo sistema com validação de integridade e janela de manutenção mínima.",
  "escopo": "Migração em batches de 1000 registros, validação por checksum por batch, janela de manutenção de 2 horas e rollback plan.",
  "criterios_de_aceite": [
    "100% dos 50.000 clientes são migrados com checksum coincidente entre origem e destino.",
    "Migração completa dentro da janela de manutenção de 2 horas.",
    "Procedimento de rollback é validado e restaura o estado anterior em caso de falha crítica."
  ],
  "riscos": ["Validação por checksum pode não detectar corrupção semântica em campos livres."],
  "dependencias": [
    "Acesso de leitura ao banco legacy e de escrita ao novo banco durante a janela."
  ],
  "divergencias": [],
  "consolidacao": "Acordou-se a migração em batches de 1000 com validação por checksum e janela de manutenção de 2 horas. O plano inclui rollback validado e critérios de aceite cobrindo integridade, tempo e segurança."
}
```

### Caso 16: Auditoria de Acesso a Dados Sensíveis

- **Tipo**: calibracao
- **Demanda original**:
  Título: Implementar trilha de auditoria para acesso a dados sensíveis
  Descrição: Registrar quem acessou dados de clientes e quando, para conformidade LGPD.
- **Histórico do debate**:
  [product_owner]: Precisamos auditar acesso a dados pessoais para LGPD.
  [tech_lead]: Vamos criar tabela audit_logs com userId, recurso, timestamp e ação. Middleware intercepta reads.
  [qa]: Validar que todo read de dados sensíveis gera log.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de trilha de auditoria para acesso a dados sensíveis de clientes, impedindo conformidade com LGPD.",
  "objetivo": "Implementar trilha de auditoria registrando todo acesso a dados sensíveis para conformidade LGPD.",
  "escopo": "Tabela audit_logs com campos userId, recurso, timestamp e ação, middleware de interceptação de reads e API de consulta de logs para o DPO.",
  "criterios_de_aceite": [
    "Todo read de dados sensíveis gera um registro na tabela audit_logs.",
    "Logs contêm userId, recurso acessado, timestamp e tipo de ação.",
    "DPO consegue filtrar logs por usuário e período via API dedicada."
  ],
  "riscos": [
    "Volume de logs pode crescer rapidamente exigindo política de retenção e particionamento."
  ],
  "dependencias": ["Definição formal de quais entidades são consideradas dados sensíveis."],
  "divergencias": [],
  "consolidacao": "A mesa definiu a trilha de auditoria via tabela audit_logs e middleware de interceptação de reads, com API de consulta para o DPO. O design prevê política de retenção como risco e dependência de definição formal de dados sensíveis."
}
```

### Caso 17: Internacionalização i18n

- **Tipo**: calibracao
- **Demanda original**:
  Título: Adicionar suporte a i18n (pt-BR, en-US, es-ES)
  Descrição: O app precisa suportar três idiomas para expansão internacional.
- **Histórico do debate**:
  [product_owner]: Precisamos de 3 idiomas para a expansão.
  [tech_lead]: Vamos usar react-i18next com namespaces por feature. Bundles separados por idioma.
  [qa]: Testar fallback quando a chave de tradução não existe.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Aplicação suporta apenas português, impedindo a expansão internacional para mercados de língua inglesa e espanhola.",
  "objetivo": "Adicionar suporte a internacionalização com os idiomas pt-BR, en-US e es-ES.",
  "escopo": "Integração com react-i18next, namespaces por feature, bundles separados por idioma e mecanismo de fallback para pt-BR.",
  "criterios_de_aceite": [
    "Usuário pode alternar entre pt-BR, en-US e es-ES em todo o app.",
    "Chave de tradução ausente cai em fallback para pt-BR sem erro visível.",
    "Bundles por idioma são carregados sob demanda sem aumentar o bundle inicial."
  ],
  "riscos": ["Traduções desatualizadas podem gerar inconsistência entre idiomas."],
  "dependencias": ["Traduções revisadas por falantes nativos de en-US e es-ES."],
  "divergencias": [],
  "consolidacao": "Acordou-se o uso de react-i18next com namespaces por feature e bundles separados por idioma, com fallback para pt-BR. O design prevê carregamento sob demanda e risco de inconsistência entre traduções."
}
```

### Caso 18: Observabilidade com OpenTelemetry

- **Tipo**: calibracao
- **Demanda original**:
  Título: Instrumentar a API com OpenTelemetry
  Descrição: Adicionar traces distribuídos para diagnosticar latência ponta-a-ponta.
- **Histórico do debate**:
  [product_owner]: Não conseguimos diagnosticar onde a latência aparece.
  [tech_lead]: Vamos usar @opentelemetry/sdk-node com auto-instrumentação de express. Export OTLP para Tempo.
  [qa]: Validar que o trace contém spans de HTTP, DB e chamadas externas.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de traces distribuídos impede o diagnóstico de onde a latência aparece ponta-a-ponta na API.",
  "objetivo": "Instrumentar a API com OpenTelemetry para gerar traces distribuídos exportados para Tempo.",
  "escopo": "Integração com @opentelemetry/sdk-node, auto-instrumentação de express e export OTLP para Tempo com correlação por requestId.",
  "criterios_de_aceite": [
    "Trace de uma requisição contém spans de HTTP, DB e chamadas externas.",
    "requestId é propagado como atributo em todos os spans para correlação com audit logs.",
    "Exportação OTLP não degrada a latência da API em mais de 5%."
  ],
  "riscos": [
    "Auto-instrumentação pode gerar ruído se bibliotecas internas também forem instrumentadas."
  ],
  "dependencias": ["Coletor OTLP (Tempo) disponível e acessível pela API."],
  "divergencias": [],
  "consolidacao": "A mesa definiu a instrumentação com @opentelemetry/sdk-node e auto-instrumentação de express, com export OTLP para Tempo. O design prevê correlação por requestId e risco de ruído de instrumentação."
}
```

### Caso 19: Feature Flags para Rollout Progressivo

- **Tipo**: calibracao
- **Demanda original**:
  Título: Adicionar feature flags para rollout progressivo
  Descrição: Habilitar features gradualmente por percentual de usuários.
- **Histórico do debate**:
  [product_owner]: Queremos ligar features para 10% dos usuários antes de 100%.
  [tech_lead]: Vamos usar LaunchDarkly SDK com flag por feature. Avaliação no middleware.
  [qa]: Testar que usuário fora do rollout não vê a feature.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de feature flags impede rollout progressivo de features, forçando deploy binário e aumentando risco.",
  "objetivo": "Implementar feature flags para habilitar features gradualmente por percentual de usuários.",
  "escopo": "Integração com LaunchDarkly SDK, avaliação de flags no middleware e dashboard de gestão de flags para o time de produto.",
  "criterios_de_aceite": [
    "Feature pode ser habilitada para 10% dos usuários e escalada até 100% sem redeploy.",
    "Usuário fora do rollout não vê a feature nem recebe erros.",
    "Dashboard permite ao time de produto ligar/desligar flags em tempo real."
  ],
  "riscos": [
    "Dependência de serviço externo (LaunchDarkly) pode indisponibilizar a avaliação de flags."
  ],
  "dependencias": ["Conta LaunchDarkly configurada com chaves de API no ambiente."],
  "divergencias": [],
  "consolidacao": "Acordou-se o uso de LaunchDarkly SDK com avaliação no middleware e dashboard de gestão. O design prevê rollout por percentual, fallback em caso de indisponibilidade e dependência de conta configurada."
}
```

### Caso 20: Backup Automatizado do Banco

- **Tipo**: calibracao
- **Demanda original**:
  Título: Configurar backup automatizado do Postgres
  Descrição: Garantir backups diários com retenção de 30 dias e restore testado.
- **Histórico do debate**:
  [product_owner]: Precisamos garantir que conseguimos restaurar o banco em caso de desastre.
  [tech_lead]: Vamos usar pg_dump diário com upload para S3. Retenção de 30 dias. Restore testado mensalmente.
  [qa]: Validar que o restore de um backup de 7 dias atrás sobe sem erro.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de backup automatizado do Postgres expõe o sistema a perda de dados em caso de desastre sem capacidade de restauração.",
  "objetivo": "Configurar backup automatizado diário do Postgres com retenção de 30 dias e restore testado mensalmente.",
  "escopo": "pg_dump diário agendado, upload para S3 com retenção de 30 dias e rotina mensal de teste de restore em ambiente isolado.",
  "criterios_de_aceite": [
    "Backup diário é gerado e enviado ao S3 sem intervenção manual.",
    "Backups com mais de 30 dias são expirados automaticamente do S3.",
    "Restore de um backup de 7 dias atrás é validado mensalmente em ambiente isolado."
  ],
  "riscos": ["Backup de banco muito grande pode exceder a janela noturna de pg_dump."],
  "dependencias": ["Bucket S3 configurado com lifecycle policy de 30 dias."],
  "divergencias": [],
  "consolidacao": "A mesa definiu backup diário via pg_dump com upload ao S3 e retenção de 30 dias, com teste de restore mensal em ambiente isolado. O design prevê risco de janela noturna para bancos grandes."
}
```

### Caso 21: Log Estruturado em JSON

- **Tipo**: calibracao
- **Demanda original**:
  Título: Migrar logs para formato JSON estruturado
  Descrição: Logs em texto livre dificultam busca e correlação em produção.
- **Histórico do debate**:
  [product_owner]: Logs são difíceis de buscar em incidentes.
  [tech_lead]: Vamos usar pino com log JSON em stdout. Correlação por requestId em todos os logs.
  [qa]: Validar que todo log contém requestId e level.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Logs em texto livre dificultam busca e correlação durante incidentes em produção.",
  "objetivo": "Migrar logs para formato JSON estruturado com correlação por requestId.",
  "escopo": "Substituição do logger atual por pino, logs JSON em stdout e propagação de requestId em todos os logs da requisição.",
  "criterios_de_aceite": [
    "Todo log emitido está em JSON válido com campos level, time, msg e requestId.",
    "requestId é o mesmo ponta-a-ponta em uma requisição, permitindo correlação.",
    "Logs em stdout são coletados pelo agente de observabilidade sem parse adicional."
  ],
  "riscos": [
    "Logs verbosos em JSON podem aumentar o volume ingerido pelo agente de observabilidade."
  ],
  "dependencias": ["Agente de observabilidade configurado para coletar stdout do container."],
  "divergencias": [],
  "consolidacao": "Acordou-se a migração para pino com logs JSON em stdout e correlação por requestId. O design prevê coleta pelo agente de observabilidade e risco de volume ingerido."
}
```

### Caso 22: Health Check e Readiness Probe

- **Tipo**: calibracao
- **Demanda original**:
  Título: Adicionar endpoints de health e readiness
  Descrição: Orquestrador precisa distinguir processo vivo de pronto para receber tráfego.
- **Histórico do debate**:
  [product_owner]: Deploy causa erros 502 porque o orquestrador manda tráfego antes do app estar pronto.
  [tech_lead]: Vamos expor /healthz (liveness) e /readyz (readiness). Readiness checa DB e Redis.
  [qa]: Testar que readiness retorna 503 quando DB está indisponível.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de endpoints de health e readiness faz o orquestrador mandar tráfego antes do app estar pronto, gerando erros 502 em deploy.",
  "objetivo": "Adicionar endpoints /healthz e /readyz para o orquestrador distinguir processo vivo de pronto para tráfego.",
  "escopo": "Endpoint /healthz verificando apenas o processo, /readyz checando DB e Redis, e configuração do orquestrador para usar ambos.",
  "criterios_de_aceite": [
    "/healthz retorna 200 enquanto o processo está vivo.",
    "/readyz retorna 503 quando DB ou Redis está indisponível.",
    "Orquestrador só roteia tráfego para pods com /readyz retornando 200."
  ],
  "riscos": [
    "Readiness checando DB sincronamente pode gerar latência se o DB responder lentamente."
  ],
  "dependencias": ["Orquestrador (Kubernetes) configurado para usar os endpoints."],
  "divergencias": [],
  "consolidacao": "A mesa definiu /healthz para liveness e /readyz para readiness checando DB e Redis, com configuração do orquestrador. O design prevê risco de latência na checagem síncrona do DB."
}
```

### Caso 23: Single Sign-On com Azure AD (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Integrar SSO com Azure Active Directory
  Descrição: Funcionários corporativos devem entrar usando Azure AD.
- **Histórico do debate**:
  [product_owner]: A empresa usa Azure AD. Queremos SSO com a conta corporativa.
  [tech_lead]: Vamos usar MSAL com fluxo authorization code. Rota de callback em /api/auth/azure/callback.
  [qa]: Testar fluxo de login, logout e expiração de sessão.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de SSO com Azure AD força funcionários a gerenciar credenciais separadas, aumentando atrito e risco de segurança.",
  "objetivo": "Implementar SSO com Azure Active Directory usando fluxo authorization code via MSAL.",
  "escopo": "Integração com MSAL, fluxo authorization code, rota de callback em /api/auth/azure/callback e gestão de sessão com logout.",
  "criterios_de_aceite": [
    "Funcionário autentica com credenciais do Azure AD sem senha adicional.",
    "Sessão expira conforme política corporativa e logout redireciona ao Azure.",
    "Tentativas de autenticação inválidas são tratadas com mensagem amigável."
  ],
  "riscos": ["Indisponibilidade do Azure AD impede acesso de novos colaboradores."],
  "dependencias": ["Registro de aplicação no Azure AD com redirect URI configurada."],
  "divergencias": [],
  "consolidacao": "Definiu-se a integração SSO com Azure AD via MSAL e fluxo authorization code, com rota de callback e gestão de sessão. O design prevê tratamento de expiração, logout e risco de indisponibilidade do provedor."
}
```

### Caso 24: Fila Assíncrona com BullMQ (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Processar exportação de relatórios em fila assíncrona
  Descrição: Exportações pesadas estão bloqueando o event loop.
- **Histórico do debate**:
  [product_owner]: Exportações grandes dão timeout na API.
  [tech_lead]: Vamos usar BullMQ com Redis. Job de exportação, worker separado, status via polling.
  [qa]: Testar fila com 100 jobs e falha de worker no meio.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Exportações pesadas bloqueiam o event loop da API causando timeout e degradando outras requisições.",
  "objetivo": "Processar exportações de relatórios em fila assíncrona com BullMQ para desacoplar geração da API.",
  "escopo": "Integração com BullMQ e Redis, job de exportação em worker separado, endpoint de status via polling e tratamento de retry.",
  "criterios_de_aceite": [
    "Exportação grande é enfileirada e a API retorna 202 com job_id imediatamente.",
    "Worker processa o job e atualiza status para o cliente via polling.",
    "Falha de worker no meio do job aciona retry com backoff exponencial."
  ],
  "riscos": ["Jobs órfãos se o worker morrer antes de finalizar, exigindo mecanismo de reclaimer."],
  "dependencias": ["Instância Redis dedicada para a fila."],
  "divergencias": [],
  "consolidacao": "Acordou-se o uso de BullMQ com Redis para processamento assíncrono de exportações, com worker separado e status via polling. O design prevê retry com backoff e risco de jobs órfãos."
}
```

### Caso 25: Criptografia de Dados em Repouso (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Criptografar dados sensíveis em repouso no banco
  Descrição: Campos como CPF e cartão devem ser criptografados no Postgres.
- **Histórico do debate**:
  [product_owner]: Auditoria exigiu criptografia de dados sensíveis em repouso.
  [tech_lead]: Vamos usar pgcrypto com chave gerenciada por KMS. Campos CPF e card_number criptografados.
  [qa]: Validar que dump do banco não expõe dados sensíveis em texto claro.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Dados sensíveis como CPF e número de cartão estão em texto claro no banco, não atendendo requisito de auditoria de criptografia em repouso.",
  "objetivo": "Criptografar campos sensíveis (CPF, card_number) no Postgres usando pgcrypto com chave gerenciada por KMS.",
  "escopo": "Integração com pgcrypto, chave gerenciada por KMS, criptografia dos campos CPF e card_number e rotação de chave documentada.",
  "criterios_de_aceite": [
    "Dump do banco não expõe CPF nem card_number em texto claro.",
    "Aplicação descriptografa em runtime com chave do KMS sem expor a chave em log.",
    "Rotação de chave é documentada e testada sem downtime."
  ],
  "riscos": ["Perda da chave do KMS torna os dados indecifráveis, exigindo plano de recuperação."],
  "dependencias": ["KMS configurado com política de acesso restrita ao backend."],
  "divergencias": [],
  "consolidacao": "A mesa definiu criptografia em repouso via pgcrypto com chave do KMS para CPF e card_number, com rotação documentada. O design prevê risco de perda de chave exigindo plano de recuperação."
}
```

### Caso 26: API GraphQL sobre Postgres (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Expor API GraphQL para o catálogo
  Descrição: Clientes querem flexibilidade de query sobre o catálogo de produtos.
- **Histórico do debate**:
  [product_owner]: Clientes querem escolher quais campos retornar.
  [tech_lead]: Vamos usar Apollo Server com schema-stitching sobre o Postgres. Rate limiting por query complexity.
  [qa]: Testar query com depth alto e complexidade acima do limite.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "API REST do catálogo não permite flexibilidade de campos retornados, gerando over-fetching para clientes diversos.",
  "objetivo": "Expor API GraphQL sobre o catálogo de produtos para permitir queries flexíveis com rate limiting por complexidade.",
  "escopo": "Apollo Server com schema sobre o Postgres, cálculo de query complexity e rejeição de queries acima do limite.",
  "criterios_de_aceite": [
    "Cliente pode selecionar campos específicos do produto na query GraphQL.",
    "Query com complexidade acima do limite é rejeitada com erro explícito.",
    "Schema GraphQL é versionado e documentado para clientes externos."
  ],
  "riscos": [
    "Queries recursivas ou muito profundas podem sobrecarregar o Postgres se o limite de complexidade for mal calibrado."
  ],
  "dependencias": ["Apollo Server configurado com datasource Postgres."],
  "divergencias": [],
  "consolidacao": "Definiu-se a exposição de API GraphQL via Apollo Server sobre o Postgres, com rate limiting por complexidade de query. O design prevê schema versionado e risco de queries profundas sobrecarregando o banco."
}
```

### Caso 27: Webhook de Eventos para Parceiros (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Disparar webhooks de eventos para parceiros integrados
  Descrição: Parceiros querem ser notificados quando um pedido muda de status.
- **Histórico do debate**:
  [product_owner]: Parceiros querem ser notificados em tempo real de mudanças de status.
  [tech_lead]: Vamos disparar webhooks assinados com HMAC. Retry exponencial em fila. Dead letter após 5 tentativas.
  [qa]: Testar endpoint do parceiro retornando 500 e confirmar retry.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Parceiros integrados não recebem notificações em tempo real de mudanças de status de pedido, exigindo polling ineficiente.",
  "objetivo": "Disparar webhooks assinados com HMAC para parceiros em mudanças de status, com retry exponencial e dead letter.",
  "escopo": "Fila de disparo de webhooks, assinatura HMAC por parceiro, retry exponencial e dead letter após 5 tentativas falhas.",
  "criterios_de_aceite": [
    "Mudança de status dispara webhook assinado para o parceiro em até 5 segundos.",
    "Endpoint do parceiro retornando 5xx aciona retry exponencial até 5 tentativas.",
    "Webhook que falha após 5 tentativas vai para dead letter e é auditável."
  ],
  "riscos": [
    "Parceiro com endpoint instável pode acumular webhooks na fila e atrasar notificações a outros."
  ],
  "dependencias": ["Chave secreta HMAC por parceiro cadastrada no sistema."],
  "divergencias": [],
  "consolidacao": "Acordou-se o disparo de webhooks assinados com HMAC, retry exponencial e dead letter após 5 tentativas. O design prevê fila de disparo, auditoria de falhas e risco de parceiro instável acumulando webhooks."
}
```

### Caso 28: Telemetria de Custo por Requisição (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Medir custo de IA por requisição
  Descrição: Precisamos saber quanto cada chamada de IA custa por demanda.
- **Histórico do debate**:
  [product_owner]: Precisamos atribuir custo de IA por demanda para reporting.
  [tech_lead]: Vamos registrar tokens em uma tabela ai_requests com PK request_id. Custo calculado por pricing table.
  [qa]: Validar que toda chamada de IA gera um registro com tokens e custo.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de telemetria de custo por requisição impede atribuir gasto de IA por demanda para reporting.",
  "objetivo": "Medir custo de IA por requisição registrando tokens e calculando custo via pricing table.",
  "escopo": "Tabela ai_requests com PK request_id, registro de tokens prompt/completion por chamada e cálculo de custo via pricing table versionada.",
  "criterios_de_aceite": [
    "Toda chamada de IA gera um registro em ai_requests com tokens e custo.",
    "Custo é calculado via pricing table versionada e auditável.",
    "Dashboard de custo por demanda está disponível para o time de produto."
  ],
  "riscos": ["Pricing table desatualizada gera cálculo de custo incorreto se não for versionada."],
  "dependencias": ["Pricing table dos modelos de IA mantida e versionada."],
  "divergencias": [],
  "consolidacao": "A mesa definiu a telemetria de custo via tabela ai_requests com PK request_id e pricing table versionada. O design prevê dashboard de custo por demanda e risco de pricing desatualizada."
}
```

### Caso 29: Smoke Test de Deploy (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Adicionar smoke test automatizado pós-deploy
  Descrição: Deploys às vezes quebram features que não cobrimos com testes unitários.
- **Histórico do debate**:
  [product_owner]: Deploys quebraram features em produção sem detecção imediata.
  [tech_lead]: Vamos rodar smoke test de 5 endpoints críticos pós-deploy via GitHub Actions. Falha aciona rollback.
  [qa]: Validar que smoke test falha quando endpoint retorna 500.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de smoke test pós-deploy permite que deploys quebrem features em produção sem detecção imediata.",
  "objetivo": "Adicionar smoke test automatizado de 5 endpoints críticos pós-deploy com rollback automático em caso de falha.",
  "escopo": "GitHub Action rodando smoke test de 5 endpoints críticos após deploy, com gatilho de rollback automático em caso de falha.",
  "criterios_de_aceite": [
    "Smoke test roda automaticamente após todo deploy em produção.",
    "Falha em qualquer endpoint crítico aciona rollback automático em até 2 minutos.",
    "Resultado do smoke test é notificado ao time no canal de incidentes."
  ],
  "riscos": [
    "Rollback automático pode ser acionado por flakiness transitório se os endpoints não forem estáveis."
  ],
  "dependencias": ["Mecanismo de rollback automatizado configurado no orquestrador."],
  "divergencias": [],
  "consolidacao": "Definiu-se o smoke test pós-deploy via GitHub Action cobrindo 5 endpoints críticos, com rollback automático em caso de falha. O design prevê notificação ao time e risco de flakiness acionando rollback indevido."
}
```

### Caso 30: Conformidade LGPD — Direito ao Esquecimento (Hold-Out)

- **Tipo**: holdout
- **Demanda original**:
  Título: Implementar direito ao esquecimento (LGPD)
  Descrição: Usuário pode solicitar apagamento de todos os seus dados.
- **Histórico do debate**:
  [product_owner]: LGPD exige que o usuário possa solicitar apagamento dos dados.
  [tech_lead]: Vamos criar endpoint POST /api/users/:id/forget que anonimiza dados em todas as tabelas. Job assíncrono para logs.
  [qa]: Validar que após forget, nenhum dado pessoal do usuário é recuperável.
- **Divergências identificadas**:
  Nenhuma

**Resposta Ideal Esperada**:

```json
{
  "problema": "Ausência de mecanismo de direito ao esquecimento impede conformidade com LGPD, expondo a empresa a sanções.",
  "objetivo": "Implementar endpoint de direito ao esquecimento que anonimiza todos os dados pessoais do usuário em todas as tabelas.",
  "escopo": "Endpoint POST /api/users/:id/forget com anonimização em cascata, job assíncrono para logs e registro de auditoria da solicitação.",
  "criterios_de_aceite": [
    "Após forget, nenhum dado pessoal do usuário é recuperável via API ou banco.",
    "Logs contendo dados pessoais são anonimizados em job assíncrono em até 24 horas.",
    "Solicitação de esquecimento é registrada em auditoria com timestamp e responsável."
  ],
  "riscos": ["Anonimização em cascata pode quebrar integridade referencial se não for cuidadosa."],
  "dependencias": ["Mapeamento completo de todas as tabelas que contêm dados pessoais."],
  "divergencias": [],
  "consolidacao": "A mesa definiu o endpoint de direito ao esquecimento com anonimização em cascata e job assíncrono para logs, com registro em auditoria. O design prevê risco de integridade referencial e dependência de mapeamento completo de dados pessoais."
}
```
