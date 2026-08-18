# Protocolo de Coordenação Multi-Agente

**Origem**: R-2 do diagnóstico [spec 025](../specs/025-checklist-exec-lacunas/diagnostic-report.md) (OP-2). Este repositório é editado ao vivo por **vários agentes** sob a mesma identidade git (`example-org`): Claude Code, Devin (`devin-ai-integration[bot]`), Manus (pasta `__manus__/` em repos destino) e Antigravity. Sem protocolo, eles colidem — nesta origem já houve dois `specs/025-*` e um `git stash` que quase engoliu trabalho não-commitado de outro agente.

## Divisão de papéis (combinada em 2026-07-18)

- **AiChatFlow (o produto)** refina a demanda e exporta o **handoff em padrão spec-kit** (`GET /api/demands/:id/export/bundle`, spec 018).
- **Devin** consome o handoff e produz `spec.md`/`plan.md` (papel residual — o handoff já é spec-kit).
- **Claude** **desenvolve/implementa** a partir da spec-kit; não cria specs novas.

## Regras (obrigatórias antes de qualquer edição/commit)

1. **Fetch antes de agir**: `git fetch origin` + `git log origin/main` + checar o disco. Outro agente pode já ter feito/commitado/pushado o alvo.
2. **Numeração de spec sem colisão**: antes de criar `specs/NNN-*`, listar `ls -d specs/*/` (rastreados **e** untracked). Se o número estiver tomado por outro agente, ceder e usar o próximo livre.
3. **Stage cirúrgico**: nunca `git add -A`. Adicionar só os arquivos que são seus (`git add <arquivo>`). Arquivos de outros agentes no working tree (ex.: `skills-lock.json`, `.agents/skills/swarm/`, `__manus__/`, `handoffs/`) não entram nos seus commits.
4. **Sem `git stash` cego**: `git stash` recolhe mudanças não-commitadas de QUALQUER agente. Se precisar, verifique `git stash show` e devolva (`stash pop`) o que não é seu.
5. **Push só fast-forward**: `git fetch` antes; se `origin` andou, integrar (rebase/merge) sem `--force`. Nunca force-push sobre trabalho de outro agente.
6. **Ownership de spec**: quem começa uma spec a "possui"; os demais checam o disco antes de tocar nela.

## Sinais de que outro agente está ativo

- `git status` mostra arquivos untracked que você não criou.
- `origin/main` andou desde seu último push (novos commits com co-autor `Devin`/bot).
- Pastas `__manus__/`, `handoffs/`, `.agents/skills/` aparecem/mudam sozinhas.

Ao ver qualquer um, pare, `fetch`, e reavalie antes de commitar/pushar.
