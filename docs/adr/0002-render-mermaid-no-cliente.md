---
title: 'Renderizar fluxogramas Mermaid no cliente, não no servidor'
status: accepted
date: 2026-07-20
---

# 0002 — Renderizar fluxogramas Mermaid no cliente, não no servidor

## Status

`accepted`

## Contexto

A demanda 10037 (Geração de Artefatos Pós-Refinamento) especificava geração de
fluxogramas SVG renderizados no servidor com `@mermaid-js/mermaid-cli`, com
pipeline assíncrono (`document_jobs`) e notificação por WebSocket. A própria
spec listava o custo como risco: _"`@mermaid-js/mermaid-cli` aumenta imagem
Docker em ~200MB"_.

Antes de implementar, três alternativas foram medidas:

| Alternativa                         | Resultado da medição (2026-07-20)                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mermaid` + `jsdom`                 | **Inviável.** Falha em `text.getBBox is not a function` — jsdom não tem engine de layout, e o Mermaid precisa medir texto para dimensionar os nós.                                                 |
| `mermaid` + `playwright-core`       | Funciona: 869 ms por diagrama, SVG válido. Exige promover `playwright-core` a dependência de produção e instalar Chromium na imagem.                                                               |
| `@mermaid-js/mermaid-cli` (da spec) | `puppeteer` é **peerDependency** (`^23 \|\| ^24 \|\| ^25`), então entra explícito: seria um **segundo** engine de browser, ao lado do Playwright já usado nos testes e2e (`playwright.config.ts`). |

O fato decisivo não estava na spec: o projeto **já tem Playwright** como
devDependency. A opção da spec adicionaria um segundo Chromium ao repositório
para renderizar um diagrama de ~1 KB de texto.

## Decisão

O servidor extrai os processos do refinamento, mascara PII e persiste o
**texto-fonte Mermaid** (~1 KB). A renderização para SVG acontece **no browser
do usuário**, com o `mermaid` já disponível no bundle web.

Alternativas descartadas:

- **`mermaid-cli` + Puppeteer** — rejeitada por adicionar um segundo engine de
  browser (~180 MB de Chromium) ao servidor para produzir um artefato que o
  cliente consegue renderizar em menos de 1 s.
- **`mermaid` + Playwright no servidor** — tecnicamente viável e foi a segunda
  colocada, mas ainda exige Chromium na imagem de produção e mantém um pipeline
  assíncrono cuja única razão de existir era a lentidão da renderização.
- **`mermaid` + jsdom** — inviável por falta de engine de layout.

## Consequências

**Melhor:**

- Nenhuma dependência nova no servidor; nenhum browser headless em produção.
- A geração deixa de ser assíncrona: o endpoint responde direto, sem job
  durável nem notificação por WebSocket. Elimina toda a User Story 3 da spec
  original e a superfície de falha que vem junto (job órfão, conexão caída,
  polling de fallback).
- O artefato persistido é texto versionável e diffável (~1 KB), não binário
  (~14 KB de SVG). Fica legível em code review e no banco.
- Não há segundo engine de browser divergindo do Playwright dos testes.

**Pior ou mais arriscado (trade-off honesto):**

- O SVG deixa de existir no servidor. Qualquer consumidor server-side futuro
  (anexar em e-mail, embutir em PDF, mandar para o Slack) precisará de
  renderização — e aí o custo evitado aqui volta.
- A saída visual passa a depender do browser do usuário. Diferenças de fonte
  entre máquinas mudam a largura dos nós; o SVG não é byte-idêntico entre
  clientes.
- Um erro de sintaxe Mermaid só aparece na renderização, no cliente. Mitigado
  por validação de sintaxe no servidor antes de persistir, mas a validação e a
  renderização passam a ser executadas por engines diferentes.

**Critério de reabertura:** se surgir um consumidor server-side do SVG (PDF,
e-mail, integração externa), reavaliar a opção Playwright — ela já está medida
e não exige um segundo engine.

## Test Strategy

- **Gate automatizado:** teste unitário do extrator de processos + validador de
  sintaxe Mermaid, cobrindo entrada com PII (assertando o mascaramento antes da
  persistência) e entrada malformada (assertando rejeição com 400).
- **Gate automatizado:** teste que asserta que nenhuma dependência de browser
  headless (`puppeteer`, `@mermaid-js/mermaid-cli`) entrou em
  `package.json.dependencies` — é o sinal de que a decisão foi violada.
- **Validação manual:** renderizar um fluxograma real no browser e baixar o
  SVG, conferindo que os processos do refinamento aparecem e que nenhum dado
  sensível sobreviveu ao mascaramento.
- **Sinal de regressão:** se o tempo de build ou o tamanho da imagem saltar,
  provavelmente um browser headless voltou para as dependências de produção.
