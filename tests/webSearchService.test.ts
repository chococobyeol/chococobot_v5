import { describe, expect, it, vi } from 'vitest';
import { SearxngWebSearchProvider, WebSearchError } from '../src/services/webSearchService.js';

describe('SearxngWebSearchProvider', () => {
  it('normalizes SearXNG JSON results into short safe result records', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        {
          title: '  Example   Result  ',
          url: 'https://www.example.com/path',
          content: `snippet ${'x'.repeat(400)}`,
          publishedDate: '2026-05-23'
        },
        { title: 'Second', url: 'https://news.example.org/article', content: 'short' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new SearxngWebSearchProvider({
      enabled: true,
      baseUrl: 'https://searx.local/',
      timeoutMs: 1000,
      resultCount: 1,
      fetchImpl: fetchImpl as any
    });

    await expect(provider.search({ query: 'test query' })).resolves.toEqual({
      provider: 'searxng',
      query: 'test query',
      results: [
        expect.objectContaining({
          title: 'Example Result',
          url: 'https://www.example.com/path',
          sourceDomain: 'example.com',
          publishedAt: '2026-05-23'
        })
      ]
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining('/search?q=test+query&format=json') }),
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });

  it('reports missing config and provider failures without raw payload leakage', async () => {
    const missing = new SearxngWebSearchProvider({ enabled: true, baseUrl: '', timeoutMs: 1000, resultCount: 3 });
    expect(missing.status()).toBe('missing_config');
    await expect(missing.search({ query: 'hello' })).rejects.toMatchObject({ code: 'missing_config' });

    const rateLimited = new SearxngWebSearchProvider({
      enabled: true,
      baseUrl: 'https://searx.local',
      timeoutMs: 1000,
      resultCount: 3,
      fetchImpl: vi.fn(async () => new Response('too many requests with raw body', { status: 429 })) as any
    });
    await expect(rateLimited.search({ query: 'hello' })).rejects.toBeInstanceOf(WebSearchError);
    await expect(rateLimited.search({ query: 'hello' })).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });
});
