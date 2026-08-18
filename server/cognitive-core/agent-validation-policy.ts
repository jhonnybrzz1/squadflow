export interface DeterministicAgentValidation {
  agentName: string;
  isValid?: boolean;
  score?: number;
  issues?: unknown[];
}

export interface DeterministicCrossValidationResult {
  validationPassed: boolean;
  validationNotes: string[];
  confidenceScore: number;
}

export function aggregateDeterministicAgentValidations(
  validationAgents: string[],
  validations: DeterministicAgentValidation[],
): DeterministicCrossValidationResult {
  const validationNotes: string[] = [];
  let confidenceScore = 100;

  for (const agentName of validationAgents) {
    const validation = validations.find((candidate) => candidate.agentName === agentName);
    if (!validation) {
      validationNotes.push(`No deterministic validation available for ${agentName}`);
      confidenceScore -= 20;
      continue;
    }

    const score = Number.isFinite(validation.score) ? Number(validation.score) : 0;
    confidenceScore = Math.min(confidenceScore, score);

    if (validation.isValid === false) {
      validationNotes.push(
        `${agentName} output failed deterministic validation (${score}%): ${
          validation.issues?.map(String).join('; ') || 'no issue details'
        }`,
      );
    }
  }

  const validationPassed = confidenceScore >= 70;
  validationNotes.push(
    validationPassed
      ? `✅ Cross-validation passed with confidence: ${confidenceScore}%`
      : `⚠️ Cross-validation confidence (${confidenceScore}%) below threshold (70%)`,
  );

  return { validationPassed, validationNotes, confidenceScore };
}
