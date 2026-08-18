export interface RetentionJobLogDto {
  id: number;
  status: 'running' | 'completed' | 'failed';
  dataTypesProcessed: string[];
  totalRowsDeleted: number;
  executionTimeMs: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}
