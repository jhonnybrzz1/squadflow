import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../server/services/tech-lead-tools', () => ({
  registerTechLeadTools: vi.fn(),
}));

vi.mock('../server/services/product-manager-tools', () => ({
  registerProductManagerTools: vi.fn(),
}));

vi.mock('../server/services/qa-tools', () => ({
  registerQATools: vi.fn(),
}));

vi.mock('../server/services/scrum-master-tools', () => ({
  registerScrumMasterTools: vi.fn(),
}));

vi.mock('../server/services/form-tools', () => ({
  registerFormTools: vi.fn(),
}));

vi.mock('../server/services/devops-tools', () => ({
  registerDevOpsTools: vi.fn(),
}));

vi.mock('../server/services/agent-tools-registry', () => ({
  registerTool: vi.fn(),
  getAllRegisteredTools: vi.fn(() => [
    {
      name: 'mock_tool_1',
      description: 'Mock tool 1',
      agentAccess: ['tech_lead', 'product_manager'],
      inputSchema: {},
      parameters: {},
      execute: vi.fn(),
    },
    {
      name: 'mock_tool_2',
      description: 'Mock tool 2',
      agentAccess: ['qa', 'scrum_master'],
      inputSchema: {},
      parameters: {},
      execute: vi.fn(),
    },
  ]),
}));

// ============================================================
// Imports (após os mocks)
// ============================================================

import {
  initializeAgentTools,
  areAgentToolsInitialized,
  resetAgentToolsInit,
} from '../server/services/agent-tools-init';
import { registerTechLeadTools } from '../server/services/tech-lead-tools';
import { registerProductManagerTools } from '../server/services/product-manager-tools';
import { registerQATools } from '../server/services/qa-tools';
import { registerScrumMasterTools } from '../server/services/scrum-master-tools';
import { registerFormTools } from '../server/services/form-tools';
import { registerDevOpsTools } from '../server/services/devops-tools';

const mockedRegisterTechLead = vi.mocked(registerTechLeadTools);
const mockedRegisterProductManager = vi.mocked(registerProductManagerTools);
const mockedRegisterQA = vi.mocked(registerQATools);
const mockedRegisterScrumMaster = vi.mocked(registerScrumMasterTools);
const mockedRegisterForm = vi.mocked(registerFormTools);
const mockedRegisterDevOps = vi.mocked(registerDevOpsTools);

// ============================================================
// Suite
// ============================================================

describe('agent-tools-init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentToolsInit();
  });

  it('areAgentToolsInitialized() retorna false antes de chamar initializeAgentTools()', () => {
    expect(areAgentToolsInitialized()).toBe(false);
  });

  it('initializeAgentTools() chama as 6 funções register*', () => {
    initializeAgentTools();

    expect(mockedRegisterTechLead).toHaveBeenCalledTimes(1);
    expect(mockedRegisterProductManager).toHaveBeenCalledTimes(1);
    expect(mockedRegisterQA).toHaveBeenCalledTimes(1);
    expect(mockedRegisterScrumMaster).toHaveBeenCalledTimes(1);
    expect(mockedRegisterForm).toHaveBeenCalledTimes(1);
    expect(mockedRegisterDevOps).toHaveBeenCalledTimes(1);
  });

  it('areAgentToolsInitialized() retorna true após initializeAgentTools()', () => {
    initializeAgentTools();

    expect(areAgentToolsInitialized()).toBe(true);
  });

  it('segunda chamada a initializeAgentTools() é idempotente (register* chamadas apenas 1x no total)', () => {
    initializeAgentTools();
    initializeAgentTools();

    expect(mockedRegisterTechLead).toHaveBeenCalledTimes(1);
    expect(mockedRegisterProductManager).toHaveBeenCalledTimes(1);
    expect(mockedRegisterQA).toHaveBeenCalledTimes(1);
    expect(mockedRegisterScrumMaster).toHaveBeenCalledTimes(1);
    expect(mockedRegisterForm).toHaveBeenCalledTimes(1);
    expect(mockedRegisterDevOps).toHaveBeenCalledTimes(1);
  });

  it('resetAgentToolsInit() reseta o flag para false', () => {
    initializeAgentTools();
    expect(areAgentToolsInitialized()).toBe(true);

    resetAgentToolsInit();

    expect(areAgentToolsInitialized()).toBe(false);
  });
});
