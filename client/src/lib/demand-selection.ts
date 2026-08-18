import { isActiveDemandStatus } from '@shared/demand-status';

export type DemandSelectionIntent = 'auto' | 'manual-active' | 'manual-history';

interface DemandSelectionCandidate {
  id: number;
  status: string;
  createdAt?: Date | string | number | null;
  updatedAt?: Date | string | number | null;
}

function timestamp(value: DemandSelectionCandidate['updatedAt']): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestProcessingDemand<T extends DemandSelectionCandidate>(demands: T[]): T | null {
  return (
    demands
      // Spec 014 S4 (M-04): 'routed' também é demanda ativa.
      .filter((demand) => isActiveDemandStatus(demand.status))
      .sort((left, right) => {
        const timeDifference =
          timestamp(right.updatedAt ?? right.createdAt) -
          timestamp(left.updatedAt ?? left.createdAt);
        return timeDifference || right.id - left.id;
      })[0] ?? null
  );
}

/**
 * Chooses what the ChatArea should display.
 *
 * - An active refinement is selected automatically when nothing was chosen.
 * - Manual history inspection is preserved until the user changes selection.
 * - With multiple active refinements, the selected active one is preserved.
 * - When an active refinement ends and another remains active, focus advances.
 */
export function resolveChatDemand<T extends DemandSelectionCandidate>(
  demands: T[],
  current: T | null,
  intent: DemandSelectionIntent,
): T | null {
  const currentFromList = current
    ? (demands.find((demand) => demand.id === current.id) ?? current)
    : null;
  const active = newestProcessingDemand(demands);

  if (intent === 'manual-history' && !isActiveDemandStatus(currentFromList?.status)) {
    return currentFromList;
  }

  if (isActiveDemandStatus(currentFromList?.status)) {
    return currentFromList;
  }

  return active ?? currentFromList;
}
