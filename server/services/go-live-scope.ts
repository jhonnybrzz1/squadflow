/**
 * Spec 10015 US2/US4 — escopo Go-Live por demanda (sem AsyncLocalStorage).
 *
 * Registro em memória `demandId → goLive`, setado no início do processamento da
 * demanda e limpo no fim (`finally`). Permite que camadas fundas (ex.: os
 * guardrails de LLM) leiam o modo pelo `demandId` que JÁ carregam no contexto,
 * sem propagar a flag por ~25 assinaturas de chamada de LLM e sem introduzir uma
 * primitiva de concorrência (`AsyncLocalStorage`) no hot path — decisão registrada
 * no evidence da spec.
 *
 * Fail-safe (US4): `demandId` ausente do registro ⇒ modo COMPLETO. Se o contexto
 * for perdido (worker fora do escopo, chat interativo, etc.), o pipeline roda
 * inteiro — go-live é opt-in explícito, nunca o default.
 *
 * IMPORTANTE (segurança): este escopo governa APENAS o skip de etapas NÃO
 * críticas. A detecção de prompt-injection (regex + enforce semântico) e o
 * mascaramento de PII NUNCA consultam nem respeitam este registro.
 */

const goLiveScopes = new Map<number, boolean>();

/** Marca (ou desmarca) uma demanda como go-live enquanto ela é processada. */
export function beginGoLiveScope(demandId: number, goLive: boolean): void {
  if (goLive) {
    goLiveScopes.set(demandId, true);
  } else {
    goLiveScopes.delete(demandId);
  }
}

/** Encerra o escopo — chamar SEMPRE em `finally` para não vazar estado. */
export function endGoLiveScope(demandId: number): void {
  goLiveScopes.delete(demandId);
}

/** `true` só quando a demanda está registrada como go-live. Ausente ⇒ `false`. */
export function isDemandGoLive(demandId: number | null | undefined): boolean {
  if (demandId == null) return false;
  return goLiveScopes.get(demandId) === true;
}

/** Reset interno (testes). */
export function resetGoLiveScopes(): void {
  goLiveScopes.clear();
}
