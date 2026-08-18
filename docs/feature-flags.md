# Governança de feature flags

As flags são validadas por Zod em `server/services/feature-flags.ts`. O arquivo `config/feature-flags.json` define o baseline versionado; `feature-flags.overrides.json` contém overrides operacionais e não deve ser versionado.

## Categorias

| Categoria    | Exemplos                                                    | Regra                                                               |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Estável      | validação, telemetria e contratos já promovidos             | Manter ligada; remover a flag quando não houver rollback necessário |
| Piloto       | streaming, response schema e personalização por subconjunto | Exigir lista de participantes e métrica de resultado                |
| Shadow       | classificador híbrido e roteamento adaptativo               | Não altera decisão; precisa de critério e prazo de promoção         |
| Experimental | paralelismo, sumarização e novos mecanismos RAG             | Desligada por padrão até eval e baseline                            |
| Operacional  | thresholds, concorrência, amostragem e budgets              | Validar limites no schema                                           |

## Ciclo de vida

1. Toda flag nova precisa de responsável, métrica, valor padrão e condição de remoção.
2. Flags experimentais ficam desligadas por padrão.
3. Promoção exige resultado de eval e observabilidade em produção.
4. Após estabilização e fim da necessidade de rollback, remover a bifurcação e a flag.
5. Flags sem leitura no runtime devem ser removidas do schema e da configuração.

Nesta rodada foram removidas `enableDistributedCache`, `enableSemanticChunking`, `enableCohereRerank`, `enableRerankABTest`, `rerankABTestPercent` e `enableAdvancedLogging`, pois não possuíam leitura no runtime. A sexta flag foi identificada durante a revisão: o toggle do A/B de rerank também não tinha consumidor.
