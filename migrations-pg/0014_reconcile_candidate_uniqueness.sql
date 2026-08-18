-- Lossless successor to 0010_unique_candidate_per_alias.sql.
-- Preserve every candidate row and supersede older logical duplicates before
-- installing uniqueness for rows that still participate in promotion.
BEGIN;

WITH ranked_candidates AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY alias, candidate_model_id
      ORDER BY CASE WHEN status = 'rejected' THEN 1 ELSE 0 END, id DESC
    ) AS duplicate_rank
  FROM model_candidates
  WHERE status <> 'superseded'
)
UPDATE model_candidates AS candidate
SET status = 'superseded'
FROM ranked_candidates AS ranked
WHERE candidate.id = ranked.id
  AND ranked.duplicate_rank > 1;

DROP INDEX IF EXISTS idx_model_candidates_alias_candidate;

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_candidates_alias_candidate_current
  ON model_candidates(alias, candidate_model_id)
  WHERE status <> 'superseded';

COMMIT;
