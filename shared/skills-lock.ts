export interface SkillView {
  id: string;
  source: string;
  sourceType: string;
  skillPath: string;
  computedHash: string;
  targetAgents: string[];
  rawUrl: string;
}

export interface SkillsLockfileResponse {
  version: number;
  skills: SkillView[];
}
