import type { Collection, GuildTextBasedChannel, Message, Snowflake } from 'discord.js';
import type { AiChatMessage } from './aiService.js';

export const DEFAULT_HISTORY_MESSAGE_LIMIT = 100;
export const DEFAULT_HISTORY_LOOKBACK_HOURS = 24;
export const MAX_HISTORY_MESSAGE_LIMIT = 500;
export const MAX_HISTORY_LOOKBACK_HOURS = 24 * 7;
const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DISCORD_SEARCH_PAGE_LIMIT = 25;

export type ChannelHistoryFetchChannel = Pick<GuildTextBasedChannel, 'id' | 'messages'>;

export type ChannelHistoryAssessment = {
  status: 'ready' | 'needs-narrowing' | 'refused';
  limit: number;
  lookbackHours: number;
  prompt: string;
};

export type ChannelHistoryEntry = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdTimestamp: number;
  isBot: boolean;
};

export type ChannelHistoryFetchOptions = {
  limit?: number;
  lookbackHours?: number;
};

export type GuildMessageSearchOptions = {
  guildId: string;
  botToken: string;
  query: string;
  channelIds?: string[];
  limit?: number;
};

type DiscordSearchMessage = {
  id: string;
  channel_id: string;
  content?: string;
  timestamp: string;
  author?: {
    id?: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
  };
};

type DiscordSearchResponse = {
  messages?: DiscordSearchMessage[][];
  total_results?: number;
};

export function assessChannelHistoryQuery(query: string): ChannelHistoryAssessment {
  const normalized = query.trim();
  const explicitLimit = findExplicitCount(normalized);
  const explicitLookbackHours = findExplicitLookbackHours(normalized);
  const hasBroadScope = /\b(all|everything|entire|whole)\b|전체|전부|모두|다\s*읽어|전부\s*요약/.test(normalized);

  const limit = explicitLimit ?? DEFAULT_HISTORY_MESSAGE_LIMIT;
  const lookbackHours = explicitLookbackHours ?? DEFAULT_HISTORY_LOOKBACK_HOURS;

  if (limit > MAX_HISTORY_MESSAGE_LIMIT || lookbackHours > MAX_HISTORY_LOOKBACK_HOURS) {
    return {
      status: 'refused',
      limit: Math.min(limit, MAX_HISTORY_MESSAGE_LIMIT),
      lookbackHours: Math.min(lookbackHours, MAX_HISTORY_LOOKBACK_HOURS),
      prompt: `한 번에 ${MAX_HISTORY_MESSAGE_LIMIT}개 또는 ${MAX_HISTORY_LOOKBACK_HOURS / 24}일을 넘는 요청은 처리할 수 없어요... 더 좁게 다시 물어봐 주세요...`
    };
  }

  if (
    hasBroadScope ||
    (explicitLimit !== undefined && explicitLimit > DEFAULT_HISTORY_MESSAGE_LIMIT) ||
    (explicitLookbackHours !== undefined && explicitLookbackHours > DEFAULT_HISTORY_LOOKBACK_HOURS)
  ) {
    return {
      status: 'needs-narrowing',
      limit,
      lookbackHours,
      prompt: `최근 ${DEFAULT_HISTORY_MESSAGE_LIMIT}개 또는 ${DEFAULT_HISTORY_LOOKBACK_HOURS}시간 이내처럼 범위를 더 좁혀서 물어봐 주세요...`
    };
  }

  return {
    status: 'ready',
    limit,
    lookbackHours,
    prompt: ''
  };
}

export async function fetchChannelHistory(
  channel: ChannelHistoryFetchChannel,
  options: ChannelHistoryFetchOptions = {}
): Promise<ChannelHistoryEntry[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_MESSAGE_LIMIT)), MAX_HISTORY_MESSAGE_LIMIT);
  const lookbackHours = Math.min(
    Math.max(1, Math.floor(options.lookbackHours ?? DEFAULT_HISTORY_LOOKBACK_HOURS)),
    MAX_HISTORY_LOOKBACK_HOURS
  );
  const cutoffTimestamp = Date.now() - lookbackHours * 60 * 60 * 1000;

  const collected: ChannelHistoryEntry[] = [];
  let before: Snowflake | undefined;
  let exhausted = false;

  while (collected.length < limit && !exhausted) {
    const fetched = collectionToArray(await channel.messages.fetch({ limit: Math.min(100, limit - collected.length), before }));
    if (fetched.length === 0) break;

    const filtered = fetched
      .filter((message) => message.createdTimestamp >= cutoffTimestamp)
      .map((message) => toHistoryEntry(message));

    collected.push(...filtered);
    before = fetched[fetched.length - 1]?.id;
    exhausted = fetched.length < 100 || before === undefined || fetched[fetched.length - 1]!.createdTimestamp < cutoffTimestamp;
  }

  return collected.slice(0, limit).sort((left, right) => left.createdTimestamp - right.createdTimestamp);
}

export async function searchGuildMessages(options: GuildMessageSearchOptions): Promise<ChannelHistoryEntry[]> {
  const query = options.query.trim().slice(0, 1024);
  if (!query) return [];

  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DISCORD_SEARCH_PAGE_LIMIT)), MAX_HISTORY_MESSAGE_LIMIT);
  const collected: ChannelHistoryEntry[] = [];
  let offset = 0;

  while (collected.length < limit) {
    const pageLimit = Math.min(DISCORD_SEARCH_PAGE_LIMIT, limit - collected.length);
    const page = await searchGuildMessagesPage({ ...options, query, limit: pageLimit, offset });
    collected.push(...page.messages.flatMap((thread) => thread).map(toSearchHistoryEntry));

    if (collected.length >= limit || page.messages.length < pageLimit || collected.length >= (page.total_results ?? Number.POSITIVE_INFINITY)) {
      break;
    }
    offset += pageLimit;
  }

  return dedupeHistoryEntries(collected)
    .slice(0, limit)
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp);
}

export function formatChannelHistoryMessages(
  messages: ChannelHistoryEntry[],
  targetChannelId: string
): AiChatMessage[] {
  return messages.map((message) => ({
    role: message.isBot ? 'assistant' : 'user',
    content: [
      `작성자: ${message.authorName} (${message.authorId})`,
      `채널: <#${message.channelId || targetChannelId}>`,
      `시각: ${new Date(message.createdTimestamp).toISOString()}`,
      message.content
    ].join('\n')
  }));
}

function collectionToArray(messages: Collection<Snowflake, Message> | Message[]): Message[] {
  return Array.isArray(messages) ? messages : Array.from(messages.values());
}

async function searchGuildMessagesPage(
  options: GuildMessageSearchOptions & { offset: number; limit: number }
): Promise<Required<Pick<DiscordSearchResponse, 'messages'>> & Pick<DiscordSearchResponse, 'total_results'>> {
  const url = new URL(`${DISCORD_API_BASE_URL}/guilds/${options.guildId}/messages/search`);
  url.searchParams.set('content', options.query);
  url.searchParams.set('limit', String(Math.min(DISCORD_SEARCH_PAGE_LIMIT, options.limit)));
  url.searchParams.set('offset', String(options.offset));
  url.searchParams.set('sort_by', 'timestamp');
  url.searchParams.set('sort_order', 'desc');
  for (const channelId of options.channelIds ?? []) url.searchParams.append('channel_id', channelId);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${options.botToken}`
    }
  });

  if (response.status === 202) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Discord search index is not ready${typeof body?.retry_after === 'number' ? `; retry_after=${body.retry_after}` : ''}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord search failed: ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
  }

  const body = (await response.json()) as DiscordSearchResponse;
  return { messages: body.messages ?? [], total_results: body.total_results };
}

function dedupeHistoryEntries(entries: ChannelHistoryEntry[]): ChannelHistoryEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function toSearchHistoryEntry(message: DiscordSearchMessage): ChannelHistoryEntry {
  return {
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author?.id ?? 'unknown',
    authorName: message.member?.nick ?? message.author?.username ?? '알 수 없음',
    content: message.content ?? '',
    createdTimestamp: Date.parse(message.timestamp),
    isBot: Boolean(message.author?.bot)
  };
}

function toHistoryEntry(message: Message): ChannelHistoryEntry {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content: message.content,
    createdTimestamp: message.createdTimestamp,
    isBot: message.author.bot
  };
}

function findExplicitCount(text: string): number | undefined {
  const countMatch = text.match(/(\d{1,4})\s*(?:개|messages?|msgs?|메시지|개\s*정도|개\s*만|건)/i);
  if (countMatch) return Number.parseInt(countMatch[1]!, 10);

  const allMatch = text.match(/(?:최근|last)\s*(\d{1,4})/i);
  if (allMatch) return Number.parseInt(allMatch[1]!, 10);

  return undefined;
}

function findExplicitLookbackHours(text: string): number | undefined {
  const hourMatch = text.match(/(\d{1,3})\s*(?:시간|hours?|hrs?|h)\b/i);
  if (hourMatch) return Number.parseInt(hourMatch[1]!, 10);

  const dayMatch = text.match(/(\d{1,3})\s*(?:일|days?|d)\b/i);
  if (dayMatch) return Number.parseInt(dayMatch[1]!, 10) * 24;

  return undefined;
}
