PRAGMA foreign_keys = OFF;

-- Some local databases predate migration 0016. Materialize the legacy shape
-- first so the data-preserving rebuild below is safe in both upgrade paths.
CREATE TABLE IF NOT EXISTS `feedback_refinamento` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `refinement_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `nota` integer NOT NULL,
  `texto` text,
  `modelo` text,
  `qtd_iteracoes_ate_feedback` integer,
  `criado_em` integer NOT NULL DEFAULT (unixepoch())
);

DROP TABLE IF EXISTS `feedback_refinamento_next`;
CREATE TABLE `feedback_refinamento_next` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `refinement_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `nota` integer,
  `texto` text,
  `modelo` text,
  `qtd_iteracoes_ate_feedback` integer,
  `item_index` integer,
  `item_key` text,
  `version_hash` text,
  `status` text,
  `criado_em` integer NOT NULL DEFAULT (unixepoch()),
  `atualizado_em` integer NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT `feedback_refinamento_nota_check`
    CHECK (`nota` IS NULL OR (`nota` >= 1 AND `nota` <= 5)),
  CONSTRAINT `feedback_refinamento_status_check`
    CHECK (`status` IS NULL OR `status` IN ('feito', 'não_feito', 'desatualizado'))
);

INSERT INTO `feedback_refinamento_next` (
  `id`, `refinement_id`, `agent_id`, `nota`, `texto`, `modelo`,
  `qtd_iteracoes_ate_feedback`, `criado_em`, `atualizado_em`
)
SELECT
  `id`, `refinement_id`, `agent_id`, `nota`, `texto`, `modelo`,
  `qtd_iteracoes_ate_feedback`, `criado_em`, `criado_em`
FROM `feedback_refinamento`;

DROP TABLE `feedback_refinamento`;
ALTER TABLE `feedback_refinamento_next` RENAME TO `feedback_refinamento`;

CREATE INDEX `idx_feedback_refinamento_agent_id`
  ON `feedback_refinamento` (`agent_id`);
CREATE INDEX `idx_feedback_refinamento_refinement_id`
  ON `feedback_refinamento` (`refinement_id`);
CREATE UNIQUE INDEX `idx_feedback_refinamento_item_version`
  ON `feedback_refinamento` (`refinement_id`, `version_hash`, `item_key`);

PRAGMA foreign_keys = ON;
