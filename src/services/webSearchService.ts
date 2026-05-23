import type { Settings } from '../config.js';

export type WebSearchMode = 'disabled' | 'explicit_only' | 'automatic' | 'search_first_factual';
export type WebSearchProviderName = 'searxng';
export type WebSearchProviderStatus = 'ready' | 'disabled' | 'missing_config' | 'unavailable';

export type WebSearchInput = {
  query: string;
  count?: number;
  language?: string;
  freshness?: string;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  sourceDomain?: string;
  publishedAt?: string;
};

export type WebSearchOutput = {
  provider: WebSearchProviderName;
  query: string;
  results: WebSearchResult[];
};

export type WebSearchErrorCode =
  | 'disabled'
  | 'missing_config'
  | 'timeout'
  | 'rate_limited'
  | 'http_error'
  | 'network_error'
  | 'malformed_response'
  | 'no_results';

export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'WebSearchError';
  }
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  status(): WebSearchProviderStatus;
  search(input: WebSearchInput): Promise<WebSearchOutput>;
}

type FetchLike = typeof fetch;

type SearxngResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
};

type SearxngResponse = {
  results?: unknown;
};

export class SearxngWebSearchProvider implements WebSearchProvider {
  readonly name = 'searxng' as const;
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly resultCount: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    options: {
      enabled: boolean;
      baseUrl: string;
      timeoutMs: number;
      resultCount: number;
      fetchImpl?: FetchLike;
    }
  ) {
    this.enabled = options.enabled;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs;
    this.resultCount = options.resultCount;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromSettings(settings: Settings, fetchImpl?: FetchLike): SearxngWebSearchProvider {
    return new SearxngWebSearchProvider({
      enabled: settings.webSearchEnabled,
      baseUrl: settings.webSearchBaseUrl,
      timeoutMs: settings.webSearchTimeoutMs,
      resultCount: settings.webSearchResultCount,
      fetchImpl
    });
  }

  status(): WebSearchProviderStatus {
    if (!this.enabled) return 'disabled';
    if (!this.baseUrl) return 'missing_config';
    return 'ready';
  }

  async search(input: WebSearchInput): Promise<WebSearchOutput> {
    const query = input.query.trim();
    if (!this.enabled) throw new WebSearchError('disabled', 'web search is disabled');
    if (!this.baseUrl) throw new WebSearchError('missing_config', 'WEB_SEARCH_BASE_URL is required for SearXNG web search');
    if (!query) throw new WebSearchError('malformed_response', 'query must not be empty');

    const count = clampCount(input.count ?? this.resultCount, this.resultCount);
    const url = new URL('/search', `${this.baseUrl}/`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    if (input.language) url.searchParams.set('language', input.language);
    if (input.freshness) url.searchParams.set('time_range', input.freshness);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw new WebSearchError('timeout', 'web search timed out');
      throw new WebSearchError('network_error', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) throw new WebSearchError('rate_limited', 'web search provider rate limited the request', response.status);
    if (!response.ok) throw new WebSearchError('http_error', `web search provider returned HTTP ${response.status}`, response.status);

    let payload: SearxngResponse;
    try {
      payload = await response.json() as SearxngResponse;
    } catch {
      throw new WebSearchError('malformed_response', 'web search provider returned invalid JSON');
    }

    const results = normalizeSearxngResults(payload, count);
    if (!results.length) throw new WebSearchError('no_results', 'web search returned no results');
    return { provider: this.name, query, results };
  }
}

export function createWebSearchProvider(settings: Settings): WebSearchProvider {
  return SearxngWebSearchProvider.fromSettings(settings);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function clampCount(value: number, fallback: number): number {
  if (!Number.isInteger(value) || value < 1) return Math.max(1, Math.min(fallback, 10));
  return Math.max(1, Math.min(value, 10));
}

function normalizeSearxngResults(payload: SearxngResponse, count: number): WebSearchResult[] {
  if (!Array.isArray(payload.results)) throw new WebSearchError('malformed_response', 'web search response missing results array');
  return payload.results
    .filter(isRecord)
    .map((raw): WebSearchResult | null => normalizeSearxngResult(raw as SearxngResult))
    .filter((result): result is WebSearchResult => Boolean(result))
    .slice(0, count);
}

function normalizeSearxngResult(raw: SearxngResult): WebSearchResult | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!title || !url) return null;
  const snippet = typeof raw.content === 'string' ? truncate(cleanText(raw.content), 240) : undefined;
  const publishedAt = typeof raw.publishedDate === 'string'
    ? raw.publishedDate
    : (typeof raw.published_date === 'string' ? raw.published_date : undefined);
  const sourceDomain = domainFromUrl(url);
  return {
    title: truncate(cleanText(title), 140),
    url,
    ...(snippet ? { snippet } : {}),
    ...(sourceDomain ? { sourceDomain } : {}),
    ...(publishedAt ? { publishedAt } : {})
  };
}

function domainFromUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
