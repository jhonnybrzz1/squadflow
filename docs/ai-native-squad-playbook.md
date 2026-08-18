# Playbook de Transformação para Squad AI-Native

**Demanda #10232** — Análise Exploratória  
**Status:** Rascunho para validação da squad  
**Público:** 1 dev pleno + 2 juniores + Head

---

## 1. Diagnóstico

### O que mudou

| Onda                                     | Gargalo principal                       | Ritmo         |
| ---------------------------------------- | --------------------------------------- | ------------- |
| Wave 1 (Manual)                          | Escrita de código, sintaxe, boilerplate | Semanas       |
| Wave 2 (Handoff + Assistentes de Código) | Validação, especificação, testes        | Minutos/horas |

A escrita de código deixou de ser o gargalo. O gargalo migrou para **especificação, validação e integração**.

### Sintomas observados

- Estimativas em Story Points ainda refletem mentalidade de digitação manual.
- Code review linha a linha de código gerado por IA.
- PRs grandes demais para iterar rapidamente.
- Falta de baseline numérico (lead time, cycle time, throughput): **A MEDIR**.

---

## 2. Os 4 Pilares

### Pilar 1 — Mudar a unidade de estimativa e foco do dev

- **De:** "Quanto tempo leva para escrever?"
- **Para:** "Quanto tempo leva para validar, testar e integrar?"
- **Ações:**
  - Itens pequenos: entram e saem no mesmo dia quando possível.
  - Planning: estimar por complexidade de validação, não por linhas de código.
  - O dev gasta energia em arquitetura, edge cases e segurança.

### Pilar 2 — Atualizar o processo de code review e testes

- **Problema:** Revisar código de IA linha a linha é desperdício.
- **Ações:**
  - Shift-left: lint, SAST e testes automatizados devem rodar antes do review humano.
  - Review humano foca em arquitetura, contrato de API e regra de negócio.
  - PRs menores (< 200 linhas quando viável).

### Pilar 3 — O novo papel do desenvolvedor (Dev Pilot)

- O dev não é pedreiro de software.
- O dev é **piloto de orquestração**:
  - Especifica intenção com clareza.
  - Valida o que a IA gerou.
  - Testa cenários limite.
  - Garante conformidade arquitetural.

### Pilar 4 — PRDs e handoffs atômicos

- Especificações claras aceleram a geração e reduzem alucinações.
- Ações:
  - PRDs pequenos, com critérios de aceite em Given/When/Then.
  - Contexto mínimo suficiente para o assistente entender.
  - Handoff de um passo por vez, não monolitos.

---

## 3. Working Agreement (rascunho)

1. **Estimativa por validação:** não por digitação.
2. **PRs pequenos:** preferencialmente < 200 linhas; máximo A MEDIR após baseline.
3. **DoD mínimo:**
   - lint passando;
   - testes cobrindo o caminho feliz e edge cases críticos;
   - review humano aprovado em arquitetura/contrato.
4. **Cultura de iteração:** código gerado é ponto de partida, não entrega final.

---

## 4. Definition of Done para era AI-Native

- [ ] Especificação clara validada com PO/Stakeholder.
- [ ] Código gerado revisado pelo dev (sintaxe/semântica básica).
- [ ] CI passando (lint + testes) antes de pedir review humano.
- [ ] Review humano focado em arquitetura, segurança e regra de negócio.
- [ ] Métrica de lead time registrada (data de início, code complete, merged): **A MEDIR até coleta inicial**.

---

## 5. Roadmap 30-60-90 Dias

### Primeiros 30 dias (Conscientização e benchmark)

- [ ] Workshop com gráficos Wave 1 vs Wave 2 (se disponíveis).
- [ ] Definir e assinar Working Agreement.
- [ ] Iniciar coleta manual de lead time/cycle time em planilha (10 PRs mínimo).

### 60 dias (Reestruturação de rituais)

- [ ] Atualizar planning para estimativa por validação.
- [ ] Criar PR template com checklist arquitetural.
- [ ] CI mínimo (lint + testes) em módulos críticos.

### 90 dias (Consolidação)

- [ ] Revisar baseline de lead time.
- [ ] Ajustar capacidade da squad.
- [ ] Decidir escala das regras para outros times.

---

## 6. Notas e Riscos

- Baseline numérico: **A MEDIR**.
- Métricas de sucesso: lead time (Spec -> Prod), taxa de CI passando antes de review, tamanho médio de PR.
- Risco: curva de aprendizado dos juniores com prompting padronizado.
- Risco: sem CI/CD sólido, o review humano vira gargalo novamente.

---

_Playbook gerado a partir da demanda #10232. Revisar e adaptar com a squad antes de adoção._
