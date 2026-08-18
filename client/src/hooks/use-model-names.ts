import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

interface ModelNameEntry {
  alias: string;
  family: string;
  provider: string;
  activeModelId: string;
}

interface ModelNamesResponse {
  models: ModelNameEntry[];
}

export type ModelNameMap = Record<string, string>;

// Keep only a minimal emergency label. All configured registry names come from
// the backend; unknown models are formatted generically instead of expanding a
// second catalog in the client.
const MINIMAL_FALLBACK: ModelNameMap = { 'openrouter/auto': 'Auto Router' };

export function formatModelName(modelName: string, names: ModelNameMap = MINIMAL_FALLBACK): string {
  if (!modelName) return 'Modelo não informado';
  if (names[modelName]) return names[modelName];

  const withoutProvider = modelName.split('/').pop() || modelName;
  const withoutSuffix = withoutProvider.split(':')[0];
  const formatted = withoutSuffix
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
  return formatted || modelName;
}

export function useModelNames(): {
  modelNames: ModelNameMap;
  isLoading: boolean;
  isFallback: boolean;
} {
  const query = useQuery<ModelNamesResponse>({
    queryKey: ['/model-names'],
    queryFn: async () => {
      const response = await fetch('/model-names');
      if (!response.ok) throw new Error(`model-names request failed: ${response.status}`);
      return response.json() as Promise<ModelNamesResponse>;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const modelNames = useMemo<ModelNameMap>(() => {
    if (!query.data?.models?.length) return MINIMAL_FALLBACK;
    const fromBackend: ModelNameMap = { ...MINIMAL_FALLBACK };
    for (const model of query.data.models) {
      const label = formatModelName(model.alias, {});
      fromBackend[model.alias] = label;
      fromBackend[model.activeModelId] = label;
    }
    return fromBackend;
  }, [query.data]);

  return {
    modelNames,
    isLoading: query.isLoading,
    isFallback: query.isError || !query.data?.models?.length,
  };
}
