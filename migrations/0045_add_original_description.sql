-- CRIT-16: preservar a descrição original do usuário.
--
-- Contexto:
-- Na criação da demanda, `description` é enriquecida com contexto do repo
-- GitHub, demand start contract e conteúdo da skill do skill.sh, formando
-- um blob composto que os agentes consomem no refinamento. O input exato
-- do usuário era perdido — impossível auditar o que ele realmente escreveu
-- vs. o que foi injetado pelo backend.
--
-- A coluna `original_description` guarda o texto original imutável;
-- `description` continua sendo a versão enriquecida/mutável.

ALTER TABLE demands ADD COLUMN original_description TEXT;
