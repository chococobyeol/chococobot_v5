import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessChannelHistoryQuery, fetchChannelHistory, searchGuildMessages } from '../src/services/channelHistoryService.js';

function makeHistoryMessage(id: string, createdTimestamp: number, content: string, bot = false) {
  return {
    id,
    channelId: 'channel-1',
    createdTimestamp,
    content,
    author: {
      id: bot ? 'bot-1' : `user-${id}`,
      username: bot ? 'HelperBot' : `user-${id}`,
      bot
    },
    member: {
      displayName: bot ? 'HelperBot' : `User ${id}`
    }
  } as any;
}

describe('assessChannelHistoryQuery', () => {
  it('defaults to the narrow ready window for ordinary requests', () => {
    const assessment = assessChannelHistoryQuery('요약해줘');
    expect(assessment).toEqual(
      expect.objectContaining({
        status: 'ready',
        limit: 100,
        lookbackHours: 24
      })
    );
  });

  it('asks for narrowing on broad but acceptable requests and refuses hard ceiling overruns', () => {
    expect(assessChannelHistoryQuery('최근 300개 요약해줘')).toEqual(
      expect.objectContaining({
        status: 'needs-narrowing',
        limit: 300
      })
    );

    expect(assessChannelHistoryQuery('최근 600개 요약해줘')).toEqual(
      expect.objectContaining({
        status: 'refused',
        prompt: expect.stringContaining('500개')
      })
    );
  });
});

describe('fetchChannelHistory', () => {
  it('fetches direct channel history in chronological order within the lookback window', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const channel = {
      id: 'channel-1',
      messages: {
        fetch: vi.fn(async () => [
          makeHistoryMessage('3', now - 2 * 60 * 60 * 1000, 'oldest kept'),
          makeHistoryMessage('2', now - 10 * 60 * 60 * 1000, 'still kept', true),
          makeHistoryMessage('1', now - 26 * 60 * 60 * 1000, 'too old')
        ])
      }
    } as any;

    const history = await fetchChannelHistory(channel, { limit: 10, lookbackHours: 24 });

    expect(channel.messages.fetch).toHaveBeenCalled();
    expect(history).toEqual([
      expect.objectContaining({ id: '2', content: 'still kept', isBot: true }),
      expect.objectContaining({ id: '3', content: 'oldest kept', isBot: false })
    ]);
  });
});

describe('searchGuildMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Discord indexed guild search and returns chronological history entries', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_results: 2,
        messages: [
          [
            {
              id: 'newer',
              channel_id: 'channel-2',
              content: '짬뽕지존 얘기',
              timestamp: '2026-05-22T18:00:00.000Z',
              author: { id: 'user-2', username: 'writer', bot: false },
              member: { nick: '작성자' }
            }
          ],
          [
            {
              id: 'older',
              channel_id: 'channel-1',
              content: '예전 짬뽕지존 얘기',
              timestamp: '2026-05-22T17:00:00.000Z',
              author: { id: 'user-1', username: 'tester', bot: false }
            }
          ]
        ]
      })
    }));
    vi.stubGlobal('fetch', fetchMock);

    const history = await searchGuildMessages({
      guildId: 'guild-1',
      botToken: 'token',
      query: '짬뽕지존',
      channelIds: ['channel-2'],
      limit: 2
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining('/guilds/guild-1/messages/search')
      }),
      expect.objectContaining({
        headers: { Authorization: 'Bot token' }
      })
    );
    const [[requestedUrl]] = fetchMock.mock.calls as unknown as Array<[URL, RequestInit?]>;
    expect(requestedUrl.searchParams.get('content')).toBe('짬뽕지존');
    expect(requestedUrl.searchParams.get('channel_id')).toBe('channel-2');
    expect(history).toEqual([
      expect.objectContaining({ id: 'older', channelId: 'channel-1', content: '예전 짬뽕지존 얘기' }),
      expect.objectContaining({ id: 'newer', channelId: 'channel-2', authorName: '작성자' })
    ]);
  });
});
