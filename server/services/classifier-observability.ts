import { classifyDemandTypeF1 } from '@shared/demand-start-contract';
import type { DemandType } from '@shared/demand-types';
import { logger } from '../utils/logger';

export type ClassifierSubmissionEvents = {
  primary: 'classifierAccepted' | 'classifierFallback';
  userReclassified: boolean;
  selectedType: DemandType;
  suggestedType: DemandType;
  confidence: number;
};

export function getClassifierSubmissionEvents(input: {
  title: string;
  description: string;
  selectedType: DemandType;
}): ClassifierSubmissionEvents {
  const classification = classifyDemandTypeF1(input);
  return {
    primary: classification.fallback ? 'classifierFallback' : 'classifierAccepted',
    userReclassified: input.selectedType !== classification.suggestedType,
    selectedType: input.selectedType,
    suggestedType: classification.suggestedType,
    confidence: classification.confidence,
  };
}

/** Registra exatamente um resultado primário por submissão e, quando aplicável, a intervenção humana. */
export function recordClassifierSubmission(input: {
  title: string;
  description: string;
  selectedType: DemandType;
  requestId?: string;
}): ClassifierSubmissionEvents {
  const events = getClassifierSubmissionEvents(input);
  const context = {
    requestId: input.requestId,
    selectedType: events.selectedType,
    suggestedType: events.suggestedType,
    confidence: events.confidence,
  };

  if (events.primary === 'classifierFallback') {
    logger.warn('classifierFallback', { context });
  } else {
    logger.info('classifierAccepted', { context });
  }

  if (events.userReclassified) {
    logger.info('userReclassified', { context });
  }

  return events;
}
