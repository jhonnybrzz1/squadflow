-- Skill externa do skill.sh
--
-- Contexto:
-- Permite ao usuário associar uma skill do skill.sh a uma demanda antes do
-- refinamento. O conteúdo da skill é buscado em runtime e injetado como
-- contexto adicional no prompt dos agentes, enriquecendo o refinamento com
-- especialização técnica ou de domínio definida externamente.

ALTER TABLE demands ADD COLUMN skill_sh_url TEXT;
