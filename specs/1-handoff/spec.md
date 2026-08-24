# Demanda - Sistema SaaS de Agendamento para Barbearias via IA no WhatsApp

## Contrato

| Campo       | Valor        |
| ----------- | ------------ |
| Tipo        | NOVA FEATURE |
| Refinamento | Negocio      |
| Esforco Max | 21 dias      |
| ROI Min     | 2:1          |

## Objetivo

Validar se um MVP de agendamento via WhatsApp com IA, operando em SQLite multi-tenant isolado por tenant_id, consegue atingir ≥80% de agendamentos concluídos sem fallback humano, com 3 barbearias piloto operando por 2 semanas, sem exigir que o dono instale aplicativos ou aprenda painéis complexos.

## Problema

Donos de barbearia perdem tempo gerenciando agendamentos manualmente por telefone ou WhatsApp pessoal, e clientes enfrentam fricção para marcar horários fora do expediente comercial. A demanda original propõe um SaaS multi-tenant com IA no WhatsApp para agendamento 24/7, mas o stack tecnológico solicitado (n8n, Evolution API, Supabase/PostgreSQL) conflita com o contrato de stack permitido (React, TypeScript, Express, SQLite, OpenAI).

## Escopo

MVP Fase 1 (2 semanas): agendamento via WhatsApp com IA (OpenAI Function Calling), FAQ contextualizado via System Prompt, fallback humano com contador de falhas e webhook, onboarding simplificado via formulário web + QR Code gerado por API, isolamento multi-tenant via coluna tenant_id no SQLite, proteção contra prompt injection. Fase 2 (pós-validação): lembretes automáticos, gateway de pagamento (Asaas/Stripe), dashboard do dono, migração para PostgreSQL. Excluído do MVP: cobrança, lembretes de 2h, FAQ como módulo separado.

## Criterios de Aceite

- Agente de IA interpreta intenções de agendamento e consulta disponibilidade real no calendário via Function Calling
- Sugestão de horários e registro automático da marcação no SQLite com tenant_id
- FAQ contextualizado com preços, horários e localização carregados no System Prompt
- Fallback humano: contador de falhas por conversa (≥3 erros) → botão 'Falar com atendente' → webhook notifica dono e pausa IA para aquele contato
- Isolamento total de dados entre barbearias via middleware Express que injeta tenant_id em todas as queries
- Proteção contra prompt injection no System Prompt (restrições para evitar descontos ou cortes gratuitos)
- Onboarding simplificado: formulário web (nome, preços, horários) + QR Code gerado automaticamente via Evolution API
- Verificação de status de pagamento CORTADA do MVP — será implementada na Fase 2

## Secoes Obrigatorias

O PRD deve incluir explicitamente as seguintes secoes derivadas do tipo de demanda:

- User stories
- Acceptance criteria
- Success metrics

## Riscos

- Evolution API self-hosted: se cair, sistema para. Mitigação: health check a cada 5min, retry com backoff (3 tentativas), fila de mensagens perdidas
- SQLite não escala horizontalmente e não tem Row Level Security nativa — débito técnico assumido para MVP; migração para PostgreSQL obrigatória quando ≥10 tenants
- Custo de infra: 3 containers Evolution (~500MB) + Node (~100MB) em VPS 2GB RAM (~R$120/mês) pode exigir upgrade para 4GB (R$180/mês) se uso de memória bater 80%
- Recrutamento de pilotos: se <3 barbearias aceitarem em 1 semana, risco é comercial (distribuição), não técnico — pausa dev e pivoteia proposta de valor
- Webhook debugging da Evolution API é o maior risco técnico no cronograma (buffer de 1 dia reservado)
- Prompt engineering e integração WhatsApp exigem iteração rápida — risco de alocar júniores nessas tarefas (mitigação: pleno assume, júniores focam React onboarding e testes)

## Dependencias

- Product Owner deve entregar CSV com dados de 3 barbearias (tenants, services, availability) antes do Dia 1 de desenvolvimento
- Product Owner deve recrutar 3 barbearias piloto em 5 dias úteis com proposta zero-atrito — se <3, gate go/no-go é acionado
- Evolution API self-hosted deve ser configurada com 3 containers dedicados (1 por barbearia) antes da integração real (Dia 3-4)
- Números de WhatsApp dedicados (chip pré-pago ~R$15/mês por barbearia) devem ser adquiridos e ativados antes do onboarding
- Contrato de piloto mínimo: permissão para usar número dedicado, compromisso de 2 semanas de operação ativa, 15min de onboarding com o dono
- Stack permitido (React, TypeScript, Express, SQLite, OpenAI) deve ser respeitado — sem introduzir n8n, Supabase ou PostgreSQL no MVP

## Divergencias

- Architect vs Tech Lead: Evolution API multi-instance — Architect corrigiu que cada instância requer container dedicado (não múltiplas instâncias no mesmo container). Tech Lead aceitou correção e ajustou estimativa de infra (3 containers, VPS 2GB RAM viável).
- Product Manager vs Anti-overengineering: onboarding manual (PO cria instâncias manualmente) vs onboarding via API (endpoint gera QR code automaticamente). Product Manager defendeu ~0.5 dia de dev para evitar débito operacional futuro; consenso: onboarding via API mantido no MVP.

## Sintese

O MVP validará a hipótese central de que barbearias adotam agendamento 24/7 via WhatsApp com IA, sem exigir apps ou painéis complexos. O escopo foi reduzido ao core: agendamento com Function Calling, FAQ via System Prompt, fallback humano com contador de falhas, e onboarding simplificado com QR Code gerado por API. Pagamento, lembretes e dashboard foram cortados para a Fase 2. O stack técnico usa Express/TypeScript, SQLite com isolamento multi-tenant via tenant_id, OpenAI, e Evolution API self-hosted com 3 containers dedicados (1 por barbearia piloto). O SQLite é débito técnico assumido para velocidade, com migração planejada para PostgreSQL quando escalar para ≥10 tenants.

O cronograma de 6 dias úteis (fluxo core 2d + fallback 1d + onboarding API 1d + integração real 2d) é viável com 1 pleno + 2 júniores, desde que o Product Owner entregue os dados das 3 barbearias em CSV antes do início. O verdadeiro gate é comercial: recrutar ≥3 pilotos em 1 semana. Se falhar, o desenvolvimento é pausado para pivotar a proposta de valor. O critério de sucesso técnico é ≥80% de agendamentos concluídos via IA sem fallback (definido como conversas onde cliente menciona serviço específico), medido em operação real por 2 semanas. A infraestrutura cabe em VPS 2GB RAM (~R$120/mês), com monitoramento de health check a cada 5min para mitigar o risco de queda da Evolution API.

---

## Prompt Para Assistente de Codigo

Copie o bloco abaixo e envie para o Claude Code ou outro assistente:

```
Implemente: Sistema SaaS de Agendamento para Barbearias via IA no WhatsApp

ESCOPO:
MVP Fase 1 (2 semanas): agendamento via WhatsApp com IA (OpenAI Function Calling), FAQ contextualizado via System Prompt, fallback humano com contador de falhas e webhook, onboarding simplificado via formulário web + QR Code gerado por API, isolamento multi-tenant via coluna tenant_id no SQLite, proteção contra prompt injection. Fase 2 (pós-validação): lembretes automáticos, gateway de pagamento (Asaas/Stripe), dashboard do dono, migração para PostgreSQL. Excluído do MVP: cobrança, lembretes de 2h, FAQ como módulo separado.

CRITERIOS DE ACEITE:
Agente de IA interpreta intenções de agendamento e consulta disponibilidade real no calendário via Function Calling; Sugestão de horários e registro automático da marcação no SQLite com tenant_id; FAQ contextualizado com preços, horários e localização carregados no System Prompt; Fallback humano: contador de falhas por conversa (≥3 erros) → botão 'Falar com atendente' → webhook notifica dono e pausa IA para aquele contato; Isolamento total de dados entre barbearias via middleware Express que injeta tenant_id em todas as queries; Proteção contra prompt injection no System Prompt (restrições para evitar descontos ou cortes gratuitos); Onboarding simplificado: formulário web (nome, preços, horários) + QR Code gerado automaticamente via Evolution API; Verificação de status de pagamento CORTADA do MVP — será implementada na Fase 2

CUIDADOS:
Evolution API self-hosted: se cair, sistema para. Mitigação: health check a cada 5min, retry com backoff (3 tentativas), fila de mensagens perdidas; SQLite não escala horizontalmente e não tem Row Level Security nativa — débito técnico assumido para MVP; migração para PostgreSQL obrigatória quando ≥10 tenants; Custo de infra: 3 containers Evolution (~500MB) + Node (~100MB) em VPS 2GB RAM (~R$120/mês) pode exigir upgrade para 4GB (R$180/mês) se uso de memória bater 80%
DEPENDENCIAS:
Product Owner deve entregar CSV com dados de 3 barbearias (tenants, services, availability) antes do Dia 1 de desenvolvimento; Product Owner deve recrutar 3 barbearias piloto em 5 dias úteis com proposta zero-atrito — se <3, gate go/no-go é acionado; Evolution API self-hosted deve ser configurada com 3 containers dedicados (1 por barbearia) antes da integração real (Dia 3-4); Números de WhatsApp dedicados (chip pré-pago ~R$15/mês por barbearia) devem ser adquiridos e ativados antes do onboarding; Contrato de piloto mínimo: permissão para usar número dedicado, compromisso de 2 semanas de operação ativa, 15min de onboarding com o dono; Stack permitido (React, TypeScript, Express, SQLite, OpenAI) deve ser respeitado — sem introduzir n8n, Supabase ou PostgreSQL no MVP

INSTRUCOES:
1. Analise o codigo existente antes de modificar
2. Faca alteracoes incrementais e testáveis
3. Mantenha compatibilidade com o stack atual
4. Documente decisoes tecnicas relevantes
5. REGRA DE INTEGRIDADE NUMÉRICA (obrigatória):
   - NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
   - Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
   - É PROIBIDO preencher a tabela de métricas com números só para completá-la. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
   - ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.
```

---

<details>
<summary>Evidencias da Mesa Redonda (clique para expandir)</summary>

**Rodada 1**

- **product_owner**: **Abertura — Demand Reframed:** Construir SaaS multi-tenant de agendamento para barbearias onde clientes agendam via WhatsApp conversando com IA 24/7, sem que o dono precise de app ou painel complexo. **Tensão crítica a
- **architect**: Como architect, reforço que o stack proposto (n8n, Evolution API, Supabase/PostgreSQL) conflita diretamente com o contrato permitido (React, TypeScript, Express, SQLite, OpenAI). SQLite não suporta isolamento multi-tenan
- **tech_lead**: Viabilidade técnica com stack permitido — posição prática: **SQLite é viável para MVP.** O architect exagerou o risco. SQLite com WAL mode suporta leituras concorrentes e writes serializados. Para 5-50 barbearias no MVP,
- **product_manager**: Tech Lead, sua análise técnica é sólida e concordo que SQLite é viável para MVP com 5-50 barbearias. Porém, questiono o fatiamento: [A MEDIR] com core + pagamento + lembretes + onboarding + hardening ainda é ambicioso pa

**Rodada 2**

- **product_owner**: Escopo fechado e aprovado pelo Tech Lead e Product Manager — ponto de vista de negócio adicionado: **Gap que ninguém cobriu: distribuição.** Ter o produto pronto não garante 3 barbearias piloto. Precisamos de um canal de
- **product_manager**: Concordo com o escopo e decomposição do Tech Lead. Acrescento 3 pontos que faltam para começar: **1. Critério de 'tentativa' — definição operacional:** Conta como tentativa toda conversa onde o cliente menciona serviço e
- **tech_lead**: **Schema SQLite + endpoints gerados abaixo.** **Número dedicado por barbearia:** Tecnicamente é a decisão correta. Cada instância Evolution API recebe `WEBHOOK_URL` único por tenant. Mapeamento fica no schema: `tenants.e
- **architect**: A premissa 'Evolution API permite múltiplas instâncias no mesmo host Docker' é INCORRETA. A Evolution API self-hosted cria instâncias isoladas via container separados (cada instância = container dedicado com sua própria

_Divergências R2:_ [architect] A premissa 'Evolution API permite múltiplas instâncias no mesmo host Docker' é INCORRETA. A Evolution API self-hosted cria instâncias isoladas via container separados (cada instância = container dedicado com sua própria DB e webhook). Isso é documentado no README oficial: 'Each instance runs in its own container'. Portanto, para 3 barbearias no MVP, serão 3 containers ativos — o custo de infraestrutura é ~3x de um único container, mas a arquitetura de isolamento (tenant_id via instance_id no middleware) continua válida. Risco: custo de hosting pode superar R$ 300/mês para 3 containers (Docker + VPS simples). Mitigação: usar VPS com 2GB RAM (R$ 120/mês) e otimizar containers (sem DB dedicada por instância — reutilizar schema com tenant_id).

**Rodada 3**

- **architect**: Concordo plenamente com o Product Manager: o contrato inteligente precisa ser preenchido HOJE antes de iniciar o dev. Como Architect, reforço que: 1. **Hipótese** deve refletir o teste real de distribuição: 'Barbearias a
- **product_owner**: Consenso total com Architect. Fecho o contrato inteligente HOJE com base no que a mesa definiu: **Contrato inteligente final:** - Hipótese: Barbearias adotarão agendamento 24/7 via WhatsApp se provar valor sem exigir app
- **scrum_master**: Consenso técnico e de negócio alcançado. Como Scrum Master, meu foco é a execução: o verdadeiro gate é o recrutamento dos 3 pilotos em 1 semana. Proponho fatiamento em 4 incrementos: (1) fluxo core agendamento IA (2d), (
- **tech_lead**: Contrato técnico validado. Três pontos de confirmação antes do Dia 1: 1. **Schema SQLite → PostgreSQL portável:** Confirmado. O padrão `tenant_id` em todas as tabelas funciona em ambos. A única diferença real é `RETURNIN
- **anti_overengineering**: A squad já cortou pagamento e aceitou SQLite, mas ainda há gordura. O MVP é validar se barbearias adotam agendamento via WhatsApp. O core é: IA interpreta intenção, consulta disponibilidade e agenda. O resto é distração.
- **product_manager**: Concordo com 70% dos cortes do anti_overengineering. Lembretes de 2h: cortado, não é core do teste. FAQ via módulo separado: cortado, mas o System Prompt JÁ carrega preços e horários — isso é zero custo, não precisa cort

_Divergências R3:_ [product_manager] Concordo com 70% dos cortes do anti_overengineering. Lembretes de 2h: cortado, não é core do teste. FAQ via módulo separado: cortado, mas o System Prompt JÁ carrega preços e horários — isso é zero custo, não precisa cortar. Onde DISCORDO: onboarding manual. Se o PO vira operador técnico criando instâncias Evolution à mão para cada barbearia, criamos díbito operacional no dia 1. Gerar QR code via chamada à Evolution API é ~meia dia de dev (um endpoint que cria instância + retorna QR em base64). Com 3 pilotos o PO até aguenta manual, mas se validar e chegar 10 barbearias na Fase 2, o PO não escapa — e aí refatoramos com pressa. Melhor construir simples agora que remédio depois. Esforço ajustado: fluxo core (2d) + fallback (1d) + onboarding básico via API (1d) + integração real (2d) = 6 dias. Mantém a proposta 'zero atrito' que é o diferencial competitivo.

**Saude:** 3 ciclos, 2 divergencias
</details>
