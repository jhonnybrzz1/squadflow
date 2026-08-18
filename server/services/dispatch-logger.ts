import crypto from 'crypto';

export interface DispatchLogEntry {
  timestamp: string;
  spec_hash: string;
  routing_output: string;
  model_selected: string;
}

/**
 * M4 — Logger de dispatch para o experimento de roteamento por plugin.
 * Emite log síncrono via console.log estruturado (JSONL) para coleta passiva.
 */
export class DispatchLogger {
  private enabled = process.env.M4_DISPATCH_LOG_ENABLED !== 'false';

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /**
   * Gera SHA-256 dos primeiros 200 caracteres do conteúdo da spec.
   */
  computeSpecHash(spec: string): string {
    const prefix = spec.slice(0, 200);
    return crypto.createHash('sha256').update(prefix).digest('hex');
  }

  /**
   * Emite log estruturado de dispatch.
   */
  log(entry: Omit<DispatchLogEntry, 'timestamp'>): void {
    if (!this.enabled) return;

    const line: DispatchLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }

  /**
   * LOG 1: ponto de retorno da classificação/roteamento.
   */
  logDispatch(spec: string, routingOutput: string, modelSelected: string): void {
    this.log({
      spec_hash: this.computeSpecHash(spec),
      routing_output: routingOutput,
      model_selected: modelSelected,
    });
  }
}

export const dispatchLogger = new DispatchLogger();
