import type { Collection, GuildTextBasedChannel, Message, Snowflake } from 'discord.js';
import type { AiChatMessage } from './aiService.js';

export const DEFAULT_HISTORY_MESSAGE_LIMIT = 100;
export const DEFAULT_HISTORY_LOOKBACK_HOURS = 24;
export const MAX_HISTORY_MESSAGE_LIMIT = 500;
export const MAX_HISTORY_LOOKBACK_HOURS = 24 * 7;

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

export function formatChannelHistoryMessages(
  messages: ChannelHistoryEntry[],
  targetChannelId: string
): AiChatMessage[] {
  return messages.map((message) => ({
    role: message.isBot ? 'assistant' : 'user',
    content: [
      `작성자: ${message.authorName} (${message.authorId})`,
      `채널: <#${targetChannelId}>`,
      `시각: ${new Date(message.createdTimestamp).toISOString()}`,
      message.content
    ].join('\n')
  }));
}

function collectionToArray(messages: Collection<Snowflake, Message> | Message[]): Message[] {
  return Array.isArray(messages) ? messages : Array.from(messages.values());
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
