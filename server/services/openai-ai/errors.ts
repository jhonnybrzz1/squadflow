/**
 * Demanda 10209 — erros públicos do módulo openai-ai.
 */
export class GuardrailBlockError extends Error {
  public readonly reason: string;
  public readonly detections: string[];
  public readonly isGuardrailBlock = true;

  constructor(userMessage: string, reason: string, detections: string[] = []) {
    super(userMessage);
    this.name = 'GuardrailBlockError';
    this.reason = reason;
    this.detections = detections;

    Object.setPrototypeOf(this, GuardrailBlockError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Auditoria 2026-08-03: o provider devolveu `finish_reason: 'length'` — a
 * resposta foi cortada no teto de `maxTokens`, não terminou. Lançado apenas
 * quando o chamador pede `failOnTruncation`, porque para chat um corte é
 * tolerável, mas para um documento significa entregar artefato incompleto.
 */
export class ResponseTruncatedError extends Error {
  public readonly operation: string;
  public readonly maxTokens: number;
  public readonly isResponseTruncated = true;

  constructor(operation: string, maxTokens: number) {
    super(
      `Resposta truncada no limite de ${maxTokens} tokens (operation=${operation}). ` +
        'O conteúdo está incompleto e não deve ser persistido como documento final.',
    );
    this.name = 'ResponseTruncatedError';
    this.operation = operation;
    this.maxTokens = maxTokens;

    Object.setPrototypeOf(this, ResponseTruncatedError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}
