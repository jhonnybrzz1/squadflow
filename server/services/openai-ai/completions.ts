/**
 * Demanda 10209 — Fase 4: tipos unificados de completion.
 */
import type { GenerateOptions } from './types';

export type GuardrailProfile = 'strict' | 'relaxed';

export interface CompletionOptions extends GenerateOptions {
  stream?: boolean;
  cacheKey?: string;
  guardrailProfile?: GuardrailProfile;
}

export interface NonStreamingCompletionOptions extends GenerateOptions {
  stream: false;
  cacheKey?: string;
  guardrailProfile?: GuardrailProfile;
}

export interface StreamingCompletionOptions extends GenerateOptions {
  stream: true;
  cacheKey?: string;
  guardrailProfile?: GuardrailProfile;
}

export type StrictCompletionOptions = NonStreamingCompletionOptions | StreamingCompletionOptions;

export function getDefaultGuardrailProfile(): GuardrailProfile {
  const env = process.env.DEFAULT_GUARDRAIL_PROFILE?.trim().toLowerCase();
  if (env === 'strict' || env === 'relaxed') return env;
  return 'relaxed';
}

export function resolveGuardrailProfile(
  options?: Pick<CompletionOptions, 'stream' | 'guardrailProfile'>,
): GuardrailProfile {
  if (!options) return getDefaultGuardrailProfile();

  const profile = options.guardrailProfile;
  if (profile === 'strict' || profile === 'relaxed') {
    if (options.stream && profile === 'strict') {
      throw new Error('stream: true cannot be combined with guardrailProfile: strict');
    }
    return profile;
  }

  return getDefaultGuardrailProfile();
}
