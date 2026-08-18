---
title: 'Desconstruir "Melhorias AiChatFlow" em entregas independentes (D1/D2/D3)'
status: accepted
date: 2026-07-20
---

# 0001 — Desconstruir "Melhorias AiChatFlow" em entregas independentes (D1/D2/D3)

## Status

`accepted`

## Contexto

A demanda 10032 ("Melhorias aichatflow") agrupava 5 iniciativas desconexas sob
o pretexto de "elevação de score": protocolo A2A, embeddings WebGPU/Wasm,
tracing distribuído OTLP, tags de descoberta do GitHub e ADRs, e integração
com Jira. Nenhuma delas tinha usuário, problema, job story, métrica de
sucesso ou plano de rollout definidos — o formato clássico de _checkbox
engineering_: adicionar capacidades para parecer mais completo, não para
resolver uma dor real. O time de execução é pequeno (1 pleno + 2 juniores) e
não havia baseline de custo (OpenRouter), latência ou dependências externas
para nenhuma das 5 iniciativas — risco real de paralisia por escopo
indefinido.

## Decisão

Desconstruir a demanda em três entregas independentes, priorizadas por
bloqueio:

- **D1 — Tags GitHub + ADRs + Baseline OpenRouter**: sem bloqueios externos,
  aceite binário, entregue nesta mesma sessão.
- **D2 — OTLP Distributed Tracing**: bloqueado por provisionamento de
  collector remoto (conta Grafana Cloud); fica em backlog documentado.
- **D3 — Jira REST Adapter**: bloqueado por credencial Atlassian
  (`JIRA_API_TOKEN`); fica em backlog documentado.

**A2A e WebGPU/Wasm embeddings ficam fora de escopo** — sem contrato de
mensagem definido, sem baseline de custo e, no caso do WebGPU, inconsistente
com a arquitetura server-side atual. Reavaliação prevista 30 dias após D1+D2
concluídos, com dados reais de custo/latência em mãos.

## Consequências

- D1 entrega valor imediato (discoverability do repo, rastreabilidade de
  decisões arquiteturais) sem risco técnico.
- D2 e D3 não bloqueiam o time: o trabalho de design (contratos Zod,
  arquitetura) já está registrado em `specs/10032-handoff/contracts/`, pronto
  para implementação assim que os bloqueios externos forem resolvidos pelo
  responsável do produto.
- **Achado relevante para D2**: ao investigar o bloqueio, `server/services/trace-exporter.ts`
  já implementa exportação OTLP real (HTTP, dry-run seguro sem endpoint
  configurado) — o gap real de D2 não é "criar exportador do zero", é ligar
  esse exportador a um middleware HTTP de request (hoje só cobre spans de
  LLM) e expor a métrica `traces_exported_total`. Isso reduz o esforço de D2
  quando for desbloqueado.
- Risco aceito: A2A/WebGPU podem representar oportunidade perdida se a
  reavaliação em 30 dias não acontecer — mitigado por T14 (`docs/reavaliacao-a2a-webgpu.md`)
  ficar registrado como tarefa explícita de backlog, não como intenção vaga.

## Test Strategy

- D1: aceite binário verificável sem testes automatizados — tags visíveis na
  sidebar do GitHub (`gh repo view --json repositoryTopics`), `docs/adr/`
  populado, índice do README renderiza links válidos. Step de CI idempotente
  (`gh repo edit --add-topic`) garante que a aplicação das tags sobrevive a
  qualquer reset manual das configurações do repositório.
- D2/D3: sem testes nesta entrega (não implementados). Quando desbloqueados,
  os contratos já definidos (`otlp-sampling-config.md`, `jira-v3-api-contract.md`)
  exigem testes de contrato Zod + mocks (D3) e validação local contra o Tempo
  do `docker-compose.observability.yml` antes de qualquer corte para
  produção (Grafana Cloud).
