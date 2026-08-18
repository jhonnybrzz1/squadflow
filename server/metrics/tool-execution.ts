import client from 'prom-client';

// These metrics are deliberately not registered in prom-client's global registry.
// server/metrics.ts owns the application's OpenMetrics registry, while tool code can
// import and record these collectors without pulling in every application metric.
// This also keeps module-isolated tests from registering the full metric set twice.
export const toolExecutionDuration = new client.Histogram({
  name: 'tool_execution_duration',
  help: 'Tool execution duration in milliseconds by bounded class and outcome',
  labelNames: ['tool_class', 'outcome'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000],
  registers: [],
});

export const toolExecutionTimeoutTotal = new client.Counter({
  name: 'tool_execution_timeout_total',
  help: 'Tool executions terminated by timeout',
  labelNames: ['tool_class'],
  registers: [],
});
