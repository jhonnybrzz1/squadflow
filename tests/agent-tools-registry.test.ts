import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Registry keeps global state — we need a fresh module per test block.
// Use resetAgentToolsRegistry via direct manipulation of the exported Map
// by re-importing with unstable_module reloading, but simpler: just
// rely on the fact that TOOLS_REGISTRY is module-level and manage it
// carefully.  We clear state via getAllRegisteredTools + manual unregister
// is not possible, so we use vi.resetModules() before each test group.

describe('agent-tools-registry', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // -------------------------------------------------------
  // defineTool + registerTool
  // -------------------------------------------------------
  describe('defineTool', () => {
    it('cria ToolDefinition com parâmetros corretos', async () => {
      const { defineTool } = await import('../server/services/agent-tools-registry');
      const schema = z.object({ name: z.string() });
      const execute = vi.fn(async () => ({ ok: true, source: 'test' as const, data: {} }));

      const tool = defineTool({
        name: 'test_tool',
        description: 'Uma tool de teste',
        agentAccess: ['tech_lead'],
        inputSchema: schema,
        execute,
      });

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('Uma tool de teste');
      expect(tool.agentAccess).toEqual(['tech_lead']);
      expect(tool.parameters).toHaveProperty('type', 'object');
      expect((tool.parameters as Record<string, unknown>).properties).toHaveProperty('name');
    });

    it('gera JSON Schema correto para campo opcional', async () => {
      const { defineTool } = await import('../server/services/agent-tools-registry');
      const schema = z.object({
        required_field: z.string(),
        optional_field: z.string().optional(),
        num_field: z.number(),
        bool_field: z.boolean(),
      });

      const tool = defineTool({
        name: 'schema_test',
        description: 'Schema test',
        agentAccess: ['*'],
        inputSchema: schema,
        execute: async () => ({ ok: true, source: 'test' }),
      });

      const params = tool.parameters as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(params.properties).toHaveProperty('required_field');
      expect(params.properties).toHaveProperty('optional_field');
      expect(params.properties).toHaveProperty('num_field');
      expect(params.properties).toHaveProperty('bool_field');
      // optional field não deve estar em required
      expect(params.required).toContain('required_field');
      expect(params.required).not.toContain('optional_field');
    });
  });

  // -------------------------------------------------------
  // registerTool + getToolsForAgent
  // -------------------------------------------------------
  describe('registerTool / getToolsForAgent', () => {
    it('getToolsForAgent retorna apenas tools do agente', async () => {
      vi.resetModules();
      const { defineTool, registerTool, getToolsForAgent } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({});
      const toolA = defineTool({
        name: 'tool_for_a',
        description: 'd',
        agentAccess: ['agent_a'],
        inputSchema: schema,
        execute: async () => ({ ok: true, source: 'tool_for_a' }),
      });
      const toolB = defineTool({
        name: 'tool_for_b',
        description: 'd',
        agentAccess: ['agent_b'],
        inputSchema: schema,
        execute: async () => ({ ok: true, source: 'tool_for_b' }),
      });

      registerTool(toolA);
      registerTool(toolB);

      const forA = getToolsForAgent('agent_a');
      const forB = getToolsForAgent('agent_b');

      expect(forA.some((t) => t.name === 'tool_for_a')).toBe(true);
      expect(forA.some((t) => t.name === 'tool_for_b')).toBe(false);
      expect(forB.some((t) => t.name === 'tool_for_b')).toBe(true);
    });

    it('tool com agentAccess ["*"] é retornada para qualquer agente', async () => {
      vi.resetModules();
      const { defineTool, registerTool, getToolsForAgent } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({});
      const globalTool = defineTool({
        name: 'global_tool',
        description: 'd',
        agentAccess: ['*'],
        inputSchema: schema,
        execute: async () => ({ ok: true, source: 'global_tool' }),
      });
      registerTool(globalTool);

      expect(getToolsForAgent('any_agent').some((t) => t.name === 'global_tool')).toBe(true);
      expect(getToolsForAgent('other_agent').some((t) => t.name === 'global_tool')).toBe(true);
    });

    it('getToolsForAgent normaliza nome do agente (hífen → underscore)', async () => {
      vi.resetModules();
      const { defineTool, registerTool, getToolsForAgent } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({});
      const tool = defineTool({
        name: 'normalized_tool',
        description: 'd',
        agentAccess: ['custom_domain_agent'],
        inputSchema: schema,
        execute: async () => ({ ok: true, source: 'normalized_tool' }),
      });
      registerTool(tool);

      // Normaliza para underscore mesmo passando hífen
      expect(
        getToolsForAgent('custom-domain-agent').some((t) => t.name === 'normalized_tool'),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------
  // getToolsForOpenAI
  // -------------------------------------------------------
  describe('getToolsForOpenAI', () => {
    it('retorna formato ChatCompletionTool com type "function"', async () => {
      vi.resetModules();
      const { defineTool, registerTool, getToolsForOpenAI } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({ q: z.string() });
      registerTool(
        defineTool({
          name: 'openai_format_tool',
          description: 'test',
          agentAccess: ['test_agent'],
          inputSchema: schema,
          execute: async () => ({ ok: true, source: 'openai_format_tool' }),
        }),
      );

      const tools = getToolsForOpenAI('test_agent');
      expect(tools.length).toBeGreaterThan(0);
      const t = tools.find((x) => x.function.name === 'openai_format_tool');
      expect(t).toBeDefined();
      expect(t!.type).toBe('function');
      expect(t!.function.description).toBe('test');
      expect(t!.function.parameters).toHaveProperty('type', 'object');
    });
  });

  // -------------------------------------------------------
  // executeTool
  // -------------------------------------------------------
  describe('executeTool', () => {
    it('executa tool registrada e retorna ToolResult', async () => {
      vi.resetModules();
      const { defineTool, registerTool, executeTool } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({ value: z.string() });
      registerTool(
        defineTool({
          name: 'exec_test_tool',
          description: 'd',
          agentAccess: ['agent_exec'],
          inputSchema: schema,
          execute: async ({ value }: { value: string }) => ({
            ok: true,
            data: { echo: value },
            source: 'exec_test_tool',
          }),
        }),
      );

      const result = await executeTool('exec_test_tool', { value: 'hello' });
      expect(result.ok).toBe(true);
      expect((result.data as Record<string, unknown>).echo).toBe('hello');
      expect(result.source).toBe('exec_test_tool');
    });

    it('retorna erro para tool desconhecida', async () => {
      vi.resetModules();
      const { executeTool } = await import('../server/services/agent-tools-registry');
      const result = await executeTool('tool_nao_existe', {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Tool desconhecida');
    });

    it('retorna erro de validação para args inválidos', async () => {
      vi.resetModules();
      const { defineTool, registerTool, executeTool } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({ code: z.string().min(3) });
      registerTool(
        defineTool({
          name: 'validation_test_tool',
          description: 'd',
          agentAccess: ['agent_v'],
          inputSchema: schema,
          execute: async () => ({ ok: true, source: 'validation_test_tool' }),
        }),
      );

      // code tem menos de 3 chars
      const result = await executeTool('validation_test_tool', { code: 'ab' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('[validation]');
    });

    it('captura exceção da execute e retorna ok:false', async () => {
      vi.resetModules();
      const { defineTool, registerTool, executeTool } =
        await import('../server/services/agent-tools-registry');

      const schema = z.object({});
      registerTool(
        defineTool({
          name: 'throwing_tool',
          description: 'd',
          agentAccess: ['agent_throw'],
          inputSchema: schema,
          execute: async () => {
            throw new Error('falha simulada');
          },
        }),
      );

      const result = await executeTool('throwing_tool', {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('falha simulada');
    });

    it('aborta o signal entregue à implementação quando a tool expira', async () => {
      vi.resetModules();
      const { defineTool, registerTool, executeTool } =
        await import('../server/services/agent-tools-registry');
      let observedSignal: AbortSignal | undefined;
      registerTool(
        defineTool({
          name: 'abort_observer_tool',
          description: 'd',
          agentAccess: ['agent_abort'],
          inputSchema: z.object({}),
          timeoutMs: 10,
          execute: async (_params, ctx) => {
            observedSignal = ctx.signal;
            await new Promise<void>((resolve) =>
              ctx.signal?.addEventListener('abort', () => resolve()),
            );
            return { ok: true, source: 'abort_observer_tool' };
          },
        }),
      );

      const result = await executeTool('abort_observer_tool', {});

      expect(result.ok).toBe(false);
      expect(result.error).toContain('[timeout]');
      expect(observedSignal?.aborted).toBe(true);
    });

    it('bloqueia execução de tool registrada para outro agente', async () => {
      vi.resetModules();
      const { defineTool, registerTool, executeToolForAgent } =
        await import('../server/services/agent-tools-registry');
      const execute = vi.fn(async () => ({ ok: true, source: 'private_tool' }));
      registerTool(
        defineTool({
          name: 'private_tool',
          description: 'd',
          agentAccess: ['tech_lead'],
          inputSchema: z.object({}),
          execute,
        }),
      );

      const result = await executeToolForAgent('product_manager', 'private_tool', {});

      expect(result.ok).toBe(false);
      expect(result.error).toContain('não autorizada');
      expect(execute).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // isAgentToolsEnabled
  // -------------------------------------------------------
  describe('isAgentToolsEnabled', () => {
    it('retorna false quando AGENT_TOOLS_ENABLED=false (global)', async () => {
      vi.resetModules();
      process.env.AGENT_TOOLS_ENABLED = 'false';
      const { isAgentToolsEnabled } = await import('../server/services/agent-tools-registry');
      expect(isAgentToolsEnabled('any_agent')).toBe(false);
    });

    it('retorna false quando {AGENT}_TOOLS_ENABLED=false', async () => {
      vi.resetModules();
      delete process.env.AGENT_TOOLS_ENABLED;
      process.env.TECH_LEAD_TOOLS_ENABLED = 'false';
      const { isAgentToolsEnabled } = await import('../server/services/agent-tools-registry');
      expect(isAgentToolsEnabled('tech_lead')).toBe(false);
    });

    it('retorna true quando {AGENT}_TOOLS_ENABLED=true', async () => {
      vi.resetModules();
      delete process.env.AGENT_TOOLS_ENABLED;
      process.env.TECH_LEAD_TOOLS_ENABLED = 'true';
      const { isAgentToolsEnabled } = await import('../server/services/agent-tools-registry');
      expect(isAgentToolsEnabled('tech_lead')).toBe(true);
    });

    it('padrão: retorna true apenas se há tools registradas para o agente', async () => {
      vi.resetModules();
      delete process.env.AGENT_TOOLS_ENABLED;
      delete process.env.UNKNOWN_AGENT_TOOLS_ENABLED;
      const { isAgentToolsEnabled } = await import('../server/services/agent-tools-registry');
      // Agente sem tools registradas → false
      expect(isAgentToolsEnabled('unknown_agent_xyz')).toBe(false);
    });
  });
});
