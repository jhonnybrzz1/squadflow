-- Demanda 10089 (itens 4 e 5): campos para checklist QA e classificação P/M/G.
--
-- `size` = P/M/G, nullable, sem default — preenchido na entrada do refinamento.
-- `qa_evidence` = texto livre com evidência de 1 cenário negativo, usado no
-- fechamento quando a flag `enforceQaChecklistOnComplete` estiver ON.
--
-- Sem esforço retroativo: colunas nullable não afetam demandas antigas.

ALTER TABLE demands ADD COLUMN size TEXT CHECK(size IN ('P', 'M', 'G'));
ALTER TABLE demands ADD COLUMN qa_evidence TEXT;
