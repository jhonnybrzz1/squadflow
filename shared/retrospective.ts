export interface RetrospectiveMessageDto {
  agent: string;
  content: string;
  createdAt: string;
}

export interface RetrospectiveSessionDto {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  summary: string | null;
  insights: string[];
  demandsAnalyzed: number[];
  agentParticipants: string[];
  messages: RetrospectiveMessageDto[];
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

// Demanda 10195: snapshot de evidência + plano de ações mensuráveis.
export interface RetroSnapshotDto {
  periodStart: string;
  periodEnd: string;
  demands: number;
  completed: number;
  failed: number;
  tokens: number;
  cost: number;
}

export interface RetroActionDto {
  id: string;
  retroId: string;
  description: string;
  owner: string | null;
  metricKey: string;
  metricBefore: number | null;
  metricAfter: number | null;
  successCriteria: string | null;
  diffPercent: number | null;
  successMet: boolean | null;
  createdAt: string;
}

export interface CreateRetroActionDto {
  description: string;
  metricKey: string;
  owner?: string;
  successCriteria?: string;
}

export interface UpdateRetroActionDto {
  metricAfter: number;
}
