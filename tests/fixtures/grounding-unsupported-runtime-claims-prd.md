# PRD sintético — diagnóstico de persistência

## Contexto

Uma execução apresentou divergência entre o volume esperado e o volume observado. O documento abaixo reproduz alegações de runtime que não podem ser aceitas sem evidência verificável.

## Diagnóstico alegado

Confirmação de Causa Raiz: a tabela `agent_jobs` perdeu 669 registros durante a execução.

Cadeia de Import Confirmada: `server/db.ts` exporta `resolveDatabaseUrl` e apaga todos os registros ao iniciar.

## Resultado proposto

O refinamento deve ser bloqueado para revisão humana porque o pacote de evidências não contém símbolo nem medição que sustente essas conclusões.

## Critério de aceite

- O gate factual reprova as afirmações de runtime não sustentadas.
- O resultado exige revisão humana.
