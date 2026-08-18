/**
 * Testa exemplars no endpoint /metrics (item #3 do roadmap de observabilidade).
 *
 * Verifica que:
 * 1. O registry está em modo OpenMetrics (necessário para exemplars)
 * 2. Ao observar aiCallDuration com exemplarLabels (trace_id, request_id),
 *    o output de /metrics contém o exemplar no formato OpenMetrics
 * 3. Ao observar sem exemplarLabels (tracing desabilitado), o histograma
 *    ainda é observado corretamente (sem exemplar, mas com o bucket atualizado)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { register, aiCallDuration, aiFirstTokenDuration } from '../server/metrics';

describe('Exemplars no /metrics (OpenMetrics)', () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it('registry está em modo OpenMetrics', () => {
    expect(register.contentType).toContain('openmetrics-text');
  });

  it('aiCallDuration tem exemplarLabels configurados', () => {
    // O fato de observe() aceitar o formato { labels, value, exemplarLabels }
    // já valida que exemplarLabels está configurado no runtime.
    // Se não estivesse, observe() esperaria (labels, value) como args separados.
    expect(() => {
      aiCallDuration.observe({
        labels: {
          model: 'test-model',
          provider: 'test',
          status: 'success',
          agent_name: 'test-agent',
          agent_version: '1.0.0',
          fallback_level: 'primary',
        },
        value: 0.5,
        exemplarLabels: { trace_id: 'abc123', request_id: 'req-001' },
      });
    }).not.toThrow();
  });

  it('observar com exemplarLabels renderiza o exemplar no output OpenMetrics', async () => {
    aiCallDuration.observe({
      labels: {
        model: 'test-model',
        provider: 'test',
        status: 'success',
        agent_name: 'test-agent',
        agent_version: '1.0.0',
        fallback_level: 'primary',
      },
      value: 0.5,
      exemplarLabels: { trace_id: 'trace-abc123def456', request_id: 'req-exemplar-001' },
    });

    const output = await register.metrics();
    expect(output).toContain('ai_api_call_duration_seconds');
    // OpenMetrics exemplar format: # {trace_id="...", request_id="..."} value timestamp
    expect(output).toContain('trace_id="trace-abc123def456"');
    expect(output).toContain('request_id="req-exemplar-001"');
  });

  it('observar com exemplarLabels vazio (tracing desabilitado) não inclui exemplar', async () => {
    aiCallDuration.observe({
      labels: {
        model: 'test-model-2',
        provider: 'test',
        status: 'success',
        agent_name: 'test-agent',
        agent_version: '1.0.0',
        fallback_level: 'primary',
      },
      value: 1.2,
      exemplarLabels: {},
    });

    const output = await register.metrics();
    // O bucket deve ter sido atualizado (o valor 1.2 cai no bucket le="2")
    expect(output).toContain('ai_api_call_duration_seconds_bucket');
    // Mas sem exemplar para este modelo (não deve conter trace_id para test-model-2)
    // Como exemplarLabels é vazio, updateExemplar retorna early — nenhum exemplar anexado.
    // Verificamos que o output não contém um exemplar com trace_id vazio.
    const lines = output.split('\n');
    const model2Lines = lines.filter((l) => l.includes('test-model-2') && l.includes('# {'));
    expect(model2Lines).toHaveLength(0);
  });

  it('aiFirstTokenDuration também suporta exemplars', async () => {
    aiFirstTokenDuration.observe({
      labels: {
        model: 'ttft-model',
        provider: 'test',
        agent_name: 'agent-x',
        agent_version: '1.0.0',
        mode: 'non_streaming',
      },
      value: 0.3,
      exemplarLabels: { trace_id: 'ttft-trace-001', request_id: 'ttft-req-001' },
    });

    const output = await register.metrics();
    expect(output).toContain('ai_first_token_duration_seconds');
    expect(output).toContain('trace_id="ttft-trace-001"');
    expect(output).toContain('request_id="ttft-req-001"');
  });

  it('múltiplas observações no mesmo bucket atualizam o exemplar mais recente', async () => {
    // Primeira observação — valor 0.12 cai no bucket le="0.5"
    aiCallDuration.observe({
      labels: {
        model: 'multi-model',
        provider: 'test',
        status: 'success',
        agent_name: 'a',
        agent_version: '1.0.0',
        fallback_level: 'primary',
      },
      value: 0.12,
      exemplarLabels: { trace_id: 'trace-old', request_id: 'req-old' },
    });

    // Segunda observação no mesmo bucket (0.15 também cai em le="0.5") — sobrescreve o exemplar
    aiCallDuration.observe({
      labels: {
        model: 'multi-model',
        provider: 'test',
        status: 'success',
        agent_name: 'a',
        agent_version: '1.0.0',
        fallback_level: 'primary',
      },
      value: 0.15,
      exemplarLabels: { trace_id: 'trace-new', request_id: 'req-new' },
    });

    const output = await register.metrics();
    // O exemplar mais recente deve estar presente
    expect(output).toContain('trace_id="trace-new"');
    expect(output).toContain('request_id="req-new"');
    // O exemplar antigo do mesmo bucket deve ter sido sobrescrito
    expect(output).not.toContain('trace_id="trace-old"');
  });
});
