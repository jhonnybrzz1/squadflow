/**
 * TOOL-TIMEOUT (P2-01): executeTool must bound tool execution time so a
 * single hung external call can't stall the agent loop indefinitely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

describe('executeTool — TOOL-TIMEOUT (P2-01)', () => {
  let TOOL_TIMEOUT_MS_ORIG: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    TOOL_TIMEOUT_MS_ORIG = process.env.TOOL_TIMEOUT_MS;
  });

  afterEach(() => {
    if (TOOL_TIMEOUT_MS_ORIG === undefined) delete process.env.TOOL_TIMEOUT_MS;
    else process.env.TOOL_TIMEOUT_MS = TOOL_TIMEOUT_MS_ORIG;
  });

  it('returns a timeout error when a tool exceeds the configured timeout', async () => {
    process.env.TOOL_TIMEOUT_MS = '50';
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    vi.mocked((await import('../../server/utils/logger')).logger).warn = vi.fn();
    registerTool(
      defineTool({
        name: 'slow_tool_timeout_test',
        description: 'A tool that never resolves',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        execute: async () =>
          new Promise((resolve) => setTimeout(() => resolve({ ok: true, source: 'late' }), 500)),
      }),
    );

    const result = await executeTool('slow_tool_timeout_test', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(result.error).toContain('50ms');
  });

  it('returns the tool result when it completes within the timeout', async () => {
    process.env.TOOL_TIMEOUT_MS = '5000';
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    registerTool(
      defineTool({
        name: 'fast_tool_timeout_test',
        description: 'A tool that resolves quickly',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        execute: async () => ({ ok: true, data: { x: 1 }, source: 'fast_tool_timeout_test' }),
      }),
    );

    const result = await executeTool('fast_tool_timeout_test', {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ x: 1 });
  });

  it('P2-01: passes an AbortSignal to execute() that aborts on timeout', async () => {
    process.env.TOOL_TIMEOUT_MS = '50';
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    let signalWasAborted = false;
    let signalReceived = false;
    registerTool(
      defineTool({
        name: 'abort_signal_test',
        description: 'A tool that checks the abort signal',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        execute: async (_params, ctx) => {
          signalReceived = !!ctx?.signal;
          // Wait long enough for the timeout to fire.
          return new Promise((resolve) => {
            const sig = ctx?.signal;
            if (!sig) {
              resolve({ ok: true, source: 'abort_signal_test' });
              return;
            }
            sig.addEventListener('abort', () => {
              signalWasAborted = true;
              resolve({ ok: false, error: 'aborted', source: 'abort_signal_test' });
            });
          });
        },
      }),
    );

    const result = await executeTool('abort_signal_test', {});
    // The tool should have received a signal...
    expect(signalReceived).toBe(true);
    // ...and that signal should have been aborted by the timeout.
    expect(signalWasAborted).toBe(true);
    // The registry owns the terminal timeout result even if the tool's abort
    // handler also resolves.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('[timeout]');
  });

  it('P2-01: redacts sensitive args (token, apiKey, password) from error logs', async () => {
    process.env.TOOL_TIMEOUT_MS = '5000';
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    const { logger } = await import('../../server/utils/logger');
    const warnSpy = vi.spyOn(logger, 'warn');

    registerTool(
      defineTool({
        name: 'redact_test_tool',
        description: 'A tool that throws to trigger logging',
        agentAccess: ['*'],
        inputSchema: z.object({
          apiKey: z.string(),
          password: z.string(),
          normalField: z.string(),
        }),
        execute: async () => {
          throw new Error('intentional failure');
        },
      }),
    );

    await executeTool('redact_test_tool', {
      apiKey: 'secret-key-123',
      password: 'hunter2',
      normalField: 'visible',
    });

    expect(warnSpy).toHaveBeenCalled();
    const loggedContext = warnSpy.mock.calls[0]?.[1]?.context;
    // Sensitive fields are redacted...
    expect(loggedContext.args.apiKey).toBe('[REDACTED]');
    expect(loggedContext.args.password).toBe('[REDACTED]');
    // ...non-sensitive fields are preserved for debugging.
    expect(loggedContext.args.normalField).toBe('visible');
  });

  it('uses a valid per-tool timeout in preference to the global timeout', async () => {
    process.env.TOOL_TIMEOUT_MS = '5000';
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    registerTool(
      defineTool({
        name: 'per_tool_precedence',
        description: 'Per-tool timeout wins',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        timeoutMs: 20,
        execute: async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true, source: 'too-late' }), 100),
          ),
      }),
    );

    const result = await executeTool('per_tool_precedence', {});
    expect(result.error).toContain('20ms');
  });

  it.each([0, -1, 1.5, 300_001])('rejects invalid per-tool timeout %s', async (timeoutMs) => {
    const { defineTool } = await import('../../server/services/agent-tools-registry');
    expect(() =>
      defineTool({
        name: 'invalid_timeout',
        description: 'Invalid timeout',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        timeoutMs,
        execute: async () => ({ ok: true, source: 'invalid_timeout' }),
      }),
    ).toThrow(/timeoutMs/);
  });

  it('returns a structured error when the tool rejects before timeout', async () => {
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    registerTool(
      defineTool({
        name: 'rejecting_tool',
        description: 'Rejects',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error('expected rejection');
        },
      }),
    );
    expect(await executeTool('rejecting_tool', {})).toEqual({
      ok: false,
      error: 'expected rejection',
      source: 'rejecting_tool',
    });
  });

  it('ignores late success and emits timeout metrics only once', async () => {
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    const { toolExecutionDuration, toolExecutionTimeoutTotal } =
      await import('../../server/metrics/tool-execution');
    registerTool(
      defineTool({
        name: 'late_completion',
        description: 'Completes after timeout',
        agentAccess: ['*'],
        inputSchema: z.object({}),
        timeoutMs: 20,
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { ok: true, source: 'late_completion' };
        },
      }),
    );

    const result = await executeTool('late_completion', {});
    const durationAfterTimeout = (await toolExecutionDuration.get()).values.find(
      (value) =>
        value.metricName === 'tool_execution_duration_count' && value.labels.outcome === 'timeout',
    )?.value;
    const timeoutAfterTimeout = (await toolExecutionTimeoutTotal.get()).values.find(
      (value) => value.labels.tool_class === 'internal',
    )?.value;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(result.ok).toBe(false);
    expect(durationAfterTimeout).toBe(1);
    expect(timeoutAfterTimeout).toBe(1);
    expect(
      (await toolExecutionDuration.get()).values.find(
        (value) =>
          value.metricName === 'tool_execution_duration_count' &&
          value.labels.outcome === 'timeout',
      )?.value,
    ).toBe(1);
    expect(
      (await toolExecutionTimeoutTotal.get()).values.find(
        (value) => value.labels.tool_class === 'internal',
      )?.value,
    ).toBe(1);
  });

  it('isolates timeout controllers across parallel calls', async () => {
    const { defineTool, registerTool, executeTool } =
      await import('../../server/services/agent-tools-registry');
    registerTool(
      defineTool({
        name: 'parallel_timeout',
        description: 'Parallel timeout',
        agentAccess: ['*'],
        inputSchema: z.object({ delay: z.number() }),
        timeoutMs: 30,
        execute: async ({ delay }) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return { ok: true, data: delay, source: 'parallel_timeout' };
        },
      }),
    );

    const [fast, slow] = await Promise.all([
      executeTool('parallel_timeout', { delay: 5 }),
      executeTool('parallel_timeout', { delay: 80 }),
    ]);
    expect(fast).toMatchObject({ ok: true, data: 5 });
    expect(slow).toMatchObject({ ok: false });
  });
});
