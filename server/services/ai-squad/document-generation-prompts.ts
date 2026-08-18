import { XIAOMI_PRO_MODEL } from '../llm-model-router';

export const PRODUCT_MANAGER_DOCUMENT_MODEL =
  process.env.PRD_GENERATION_MODEL || process.env.PRODUCT_MANAGER_MODEL || XIAOMI_PRO_MODEL;

export const SYNTHESIS_INSTRUCTION = `=== REGRA DE SÍNTESE (OBRIGATÓRIO) ===
Você está escrevendo um documento de decisão (PRD/TSD) a partir da DISCUSSÃO ESTRUTURADA da squad, NÃO a partir do documento/demanda original.

- NUNCA reproduza trechos longos do documento original ou da descrição bruta.
- NUNCA inclua blocos de diálogo completo dos agentes.
- Use APENAS o refinamento da squad (seções "REFINAMENTO DA SQUAD" e "EVIDÊNCIAS ESTRUTURADAS") para preencher Objetivo, Escopo, Critérios de Aceite e Riscos.
- Se houver conflito entre a descrição original e o refinamento da squad, SEMPRE prevalece o refinamento da squad.
- A resposta deve ser síntese, não cópia. Blocos não estruturados >200 tokens serão rejeitados.`;

export const NUMERIC_PROVENANCE_INSTRUCTION = `=== PROVENANCE NUMÉRICA (OBRIGATÓRIO) ===
Para CADA número usado no documento (percentuais, prazos, valores, ROI, métricas), declare a origem ao final, num bloco JSON:

**Numeric Provenance:**
\`\`\`json
{ "claims": [ { "value": "<número como aparece>", "source": "<trecho exato da demanda/discussão de onde veio>" } ] }
\`\`\`
Se um número não tiver fonte real, NÃO o use — prefira "A MEDIR".`;
