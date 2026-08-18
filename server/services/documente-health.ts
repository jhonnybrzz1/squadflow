const DEFAULT_DOCUMENTE_URLS = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://localhost:5174',
];

export interface DocuMenteHealthResult {
  online: boolean;
  url: string | null;
}

function configuredUrls(): string[] {
  const configured = process.env.DOCUMENTE_URLS || process.env.DOCUMENTE_URL;
  if (!configured) return DEFAULT_DOCUMENTE_URLS;

  return configured
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export async function probeDocuMente(
  fetchFn: typeof fetch = fetch,
  urls: string[] = configuredUrls(),
): Promise<DocuMenteHealthResult> {
  for (const url of urls) {
    try {
      const response = await fetchFn(`${url}/api/documents`, {
        signal: AbortSignal.timeout(1_500),
        headers: { Accept: 'application/json' },
      });

      // A status alone only proves that something owns the port. DocuMente's
      // public document listing returns a JSON array.
      if (response.ok) {
        const documents = await response.json();
        if (Array.isArray(documents)) {
          return { online: true, url };
        }
      }
    } catch (_) {
      // Try the next configured local endpoint.
    }
  }

  return { online: false, url: null };
}
