/**
 * Helpers to resolve and normalize the repository identity attached to a
 * demand. The canonical key used across persistence (demands.repoFullName,
 * refinement_rag_documents.repo_full_name) and runtime filters is the
 * GitHub-style "owner/name" string.
 *
 * The legacy storage path encodes the repo as a free-text marker inside
 * `demands.description` ("Repositório: owner/name") — these helpers are the
 * single point that knows how to parse that fallback, so the rest of the
 * codebase can treat `repoFullName` as the source of truth.
 */

import type { Demand } from '@shared/schema';

// Matches "owner/name" where neither component ends with a dot or hyphen,
// preventing punctuation at the end of a sentence from being captured.
const DESCRIPTION_REPO_REGEX =
  /Reposit[oó]rio:\s*([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]\/[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]|[A-Za-z0-9]\/[A-Za-z0-9])/i;
const REPO_FULL_NAME_SHAPE =
  /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]|[A-Za-z0-9])\/(?:[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]|[A-Za-z0-9])$/;

/**
 * Build a canonical "owner/name" string. Returns null when either component
 * is missing or contains characters incompatible with the GitHub repo naming
 * grammar — callers should always treat the absence of a repo as "global".
 */
export function buildRepoFullName(
  owner: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!owner || !name) return null;
  const candidate = `${owner.trim()}/${name.trim()}`;
  return REPO_FULL_NAME_SHAPE.test(candidate) ? candidate : null;
}

/**
 * Best-effort extraction of an "owner/name" pair from a free-text description.
 * Used both as a backfill source for legacy demands and as a runtime fallback
 * while not every code path has been migrated to set repoFullName explicitly.
 */
export function extractRepoFullNameFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(DESCRIPTION_REPO_REGEX);
  if (!match || !match[1]) return null;
  return REPO_FULL_NAME_SHAPE.test(match[1]) ? match[1] : null;
}

/**
 * Resolve the repository identity for a demand. Prefers the explicit column
 * (post-migration source of truth) and falls back to scanning the description
 * for the legacy "Repositório: owner/name" marker — guaranteeing forward
 * compatibility with rows that haven't been backfilled yet.
 */
/**
 * Parseia o campo `additionalRepos` enviado pelo form multi-repo do frontend
 * (JSON stringificado de string[]) e filtra entradas que não têm a forma
 * "owner/name". Nunca lança — entrada inválida/ausente vira lista vazia.
 *
 * O contexto de repos adicionais é só texto livre anexado à descrição (não
 * há suporte a filtro estruturado por múltiplos repos no RAG hoje —
 * `repoFullName` continua sendo uma coluna única); isso evita que o form do
 * frontend prometa multi-repo e o backend descarte silenciosamente tudo além
 * do primeiro repo.
 */
export function parseAdditionalRepos(raw: unknown): string[] {
  if (!raw) return [];
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return [];
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is string => typeof entry === 'string' && REPO_FULL_NAME_SHAPE.test(entry),
  );
}

/** Bloco de texto para anexar à descrição quando há repos além do primário. */
export function formatAdditionalReposBlock(additionalRepos: string[]): string {
  if (additionalRepos.length === 0) return '';
  return `Repositórios adicionais:\n${additionalRepos.map((r) => `  - ${r}`).join('\n')}\n`;
}

export function resolveDemandRepoFullName(
  demand: Pick<Demand, 'description'> & {
    repoFullName?: string | null;
  },
): string | null {
  const explicit = demand.repoFullName?.trim();
  if (explicit && REPO_FULL_NAME_SHAPE.test(explicit)) {
    return explicit;
  }
  return extractRepoFullNameFromText(demand.description);
}
