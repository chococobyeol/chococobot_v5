import { ChannelType, type CategoryChannel, type Client, type Guild, type TextChannel } from 'discord.js';
import type { BotActivityLogStore } from './botActivityLogStore.js';
import { logger } from '../logger.js';


export type AiDiagnosticLogDetails = {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  userId: string;
  userName?: string | null;
  stage: 'planner' | 'chat' | 'summary' | 'agent' | 'tool';
  event: 'request' | 'response' | 'parse_error' | 'retry' | 'decision' | 'error' | 'rate_limit' | 'tool_call' | 'observation' | 'blocked' | 'final' | 'loop_limit';
  model?: string;
  usageScope?: string;
  decisionKind?: string;
  commandSafety?: string;
  runId?: string;
  iteration?: number;
  toolCallId?: string;
  toolName?: string;
  policy?: string;
  observationSummary?: string;
  retryCount?: number;
  validationErrors?: readonly string[];
  promptSnippet?: string;
  responseSnippet?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  rateLimitHeaders?: Readonly<Record<string, string>>;
  status?: number;
  errorName?: string;
  errorMessage?: string;
};

type CommandLogDetails = {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  userId: string;
  userName?: string | null;
  commandName: string;
  summary: string;
};

type CleanupLogDetails = {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  userId: string;
  userName?: string | null;
  commandName: string;
  scope: 'own' | 'purge';
  requested: number;
  deleted: number;
  matched: number;
  skippedOld: number;
  exhausted: boolean;
};

type ChannelHistoryLogDetails = {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  userId: string;
  userName?: string | null;
  mode: 'summary' | 'qa';
  query: string;
  scannedChannels: number;
  matchedMessages: number;
  usedMessages: number;
  topic?: string | null;
  targetChannelId?: string | null;
  searchSource?: string;
  searchError?: string | null;
};

function truncate(value: string, limit = 1500): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function sanitizeChannelName(value: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^0-9A-Za-z가-힣_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'channel';
}

const TEST_CHANNEL_CATEGORY_NAME = '봇 테스트 채널';
const LOG_CHANNEL_CATEGORY_NAME = '서버별 로그';
const DISCORD_CATEGORY_CHANNEL_LIMIT = 50;
const AI_RATE_LIMIT_HEADER_WHITELIST = new Set([
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens'
]);

const WEB_SEARCH_QUERY_REDACTION = '[redacted-web-search-query]';

function sanitizeAiDiagnosticText(value: string | undefined, details: AiDiagnosticLogDetails): string | undefined {
  if (!value) return value;
  const isWebSearchDiagnostic = details.toolName === 'web.search' || details.decisionKind === 'web_search' || details.decisionKind === 'web_search_unavailable' || value.includes('web.search');
  if (!isWebSearchDiagnostic) return value;
  return value
    .replace(/("query"\s*:\s*")[^"]*(")/giu, `$1${WEB_SEARCH_QUERY_REDACTION}$2`)
    .replace(/(query=)[^\n,}]*/giu, `$1${WEB_SEARCH_QUERY_REDACTION}`)
    .replace(/(q=)[^\n&\s]*/giu, `$1${WEB_SEARCH_QUERY_REDACTION}`)
    .replace(/도구 관찰 JSON:[\s\S]*/u, '도구 관찰 JSON: [redacted-for-diagnostics]')
    .replace(/이전 agent 문맥 JSON:[\s\S]*/u, '이전 agent 문맥 JSON: [redacted-for-diagnostics]');
}

export class BotActivityLogService {
  constructor(
    private readonly client: Client,
    private readonly store: BotActivityLogStore,
    private readonly loggingGuildId: string
  ) {}

  async resetLoggingGuildLayout(): Promise<void> {
    const guild = await this.resolveLoggingGuild();
    if (!guild) return;

    const channels = await guild.channels.fetch();
    const fetchedChannels = [...channels.values()].filter((channel): channel is NonNullable<typeof channel> => Boolean(channel));

    for (const channel of fetchedChannels) {
      if (channel.type === ChannelType.GuildCategory) continue;
      await channel.delete('Reset log server layout').catch((error) => logger.warn('Failed to delete logging channel:', error));
    }
    for (const channel of fetchedChannels) {
      if (channel.type !== ChannelType.GuildCategory) continue;
      await channel.delete('Reset log server layout').catch((error) => logger.warn('Failed to delete logging category:', error));
    }

    await this.ensureFixedChannels(guild);
    await this.ensureAllSourceGuildLogChannels(guild);
  }

  async ensureLayoutForCurrentGuilds(): Promise<void> {
    const guild = await this.resolveLoggingGuild();
    if (!guild) return;
    await this.ensureFixedChannels(guild);
    await this.ensureAllSourceGuildLogChannels(guild);
  }

  async deleteManagedLogChannels(): Promise<{ deleted: number; failed: number }> {
    const guild = await this.resolveLoggingGuild();
    if (!guild) return { deleted: 0, failed: 0 };

    const channels = await guild.channels.fetch();
    const logChannels = [...channels.values()].filter(
      (channel): channel is TextChannel => {
        if (!channel || channel.type !== ChannelType.GuildText) return false;
        return channel.name.startsWith('LOG-') || Boolean(channel.topic?.startsWith('Source guild: '));
      }
    );

    let deleted = 0;
    let failed = 0;
    for (const channel of logChannels) {
      const removed = await channel.delete('Delete managed ChococoBot log channel').then(
        () => true,
        (error) => {
          logger.warn(`Failed to delete log channel ${channel.id}:`, error);
          return false;
        }
      );
      if (removed) deleted += 1;
      else failed += 1;
    }
    this.store.clearLogChannels?.();
    return { deleted, failed };
  }

  async ensureGuildLogChannel(sourceGuildId: string, parent?: CategoryChannel): Promise<TextChannel | undefined> {
    const guild = await this.resolveLoggingGuild();
    if (!guild) return undefined;
    const sourceGuild = await this.client.guilds.fetch(sourceGuildId).catch(() => null);
    if (!sourceGuild) return undefined;
    const desiredName = this.buildLogChannelName(sourceGuild);
    const desiredTopic = `Source guild: ${sourceGuild.name} (${sourceGuild.id})`;

    const existingChannelId = this.store.getLogChannelId(sourceGuildId);
    if (existingChannelId) {
      const cached = await guild.channels.fetch(existingChannelId).catch(() => null);
      if (cached?.type === ChannelType.GuildText) {
        if (cached.name !== desiredName || cached.topic !== desiredTopic) {
          await cached.edit({ name: desiredName, topic: desiredTopic, parent: parent?.id }).catch((error) => logger.warn('Failed to rename logging channel:', error));
        } else if (parent && cached.parentId !== parent.id) {
          await cached.edit({ parent: parent.id }).catch((error) => logger.warn('Failed to move logging channel:', error));
        }
        return cached;
      }
    }

    const existingByMetadata = this.findExistingLogChannel(guild, desiredName, desiredTopic);
    if (existingByMetadata) {
      this.store.setLogChannelId(sourceGuildId, existingByMetadata.id);
      if (parent && existingByMetadata.parentId !== parent.id && this.hasCategoryCapacity(guild, parent)) {
        await existingByMetadata.edit({ parent: parent.id }).catch((error) => logger.warn('Failed to move existing logging channel:', error));
      }
      return existingByMetadata;
    }

    const targetParent = parent && this.hasCategoryCapacity(guild, parent) ? parent : await this.findAvailableLogCategory(guild);
    const channel = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildText,
      topic: desiredTopic,
      parent: targetParent?.id
    }).catch((error) => {
      logger.warn(`Failed to create logging channel for source guild ${sourceGuildId}:`, error);
      return null;
    });
    if (!channel || channel.type !== ChannelType.GuildText) return undefined;
    this.store.setLogChannelId(sourceGuildId, channel.id);
    return channel;
  }

  async logCommand(details: CommandLogDetails): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = await this.resolveSourceChannelLabel(details.guildId, details.channelId);
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-COMMAND`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `command=${details.commandName}`,
          `summary=${details.summary}`
        ].join('\n'))
    }).catch((error) => logger.warn('Failed to send command log:', error));
  }

  async logCleanupResult(details: CleanupLogDetails): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = await this.resolveSourceChannelLabel(details.guildId, details.channelId);
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-CLEANUP`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `command=${details.commandName}`,
          `scope=${details.scope}`,
          `requested=${details.requested}`,
          `matched=${details.matched}`,
          `deleted=${details.deleted}`,
          `skippedOld=${details.skippedOld}`,
          `exhausted=${details.exhausted}`
        ].join('\n'))
    }).catch((error) => logger.warn('Failed to send cleanup log:', error));
  }

  async logChannelHistory(details: ChannelHistoryLogDetails): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = await this.resolveSourceChannelLabel(details.guildId, details.channelId);
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-HISTORY`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `mode=${details.mode}`,
          details.topic ? `topic=${details.topic}` : undefined,
          details.targetChannelId ? `targetChannel=${await this.resolveSourceChannelLabel(details.guildId, details.targetChannelId)}` : undefined,
          `query=${truncate(details.query, 500)}`,
          details.searchSource ? `searchSource=${details.searchSource}` : undefined,
          details.searchError ? `searchError=${truncate(details.searchError, 500)}` : undefined,
          `scannedChannels=${details.scannedChannels}`,
          `matchedMessages=${details.matchedMessages}`,
          `usedMessages=${details.usedMessages}`
        ].filter(Boolean).join('\n'))
    }).catch((error) => logger.warn('Failed to send channel-history log:', error));
  }

  async logError(details: {
    guildId: string;
    guildName?: string | null;
    channelId: string;
    userId: string;
    userName?: string | null;
    commandName: string;
    summary: string;
    error: unknown;
  }): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = await this.resolveSourceChannelLabel(details.guildId, details.channelId);
    const errorText = details.error instanceof Error ? `${details.error.name}: ${details.error.message}` : String(details.error);
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-ERROR`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `command=${details.commandName}`,
          `summary=${details.summary}`,
          `error=${errorText}`
        ].join('\n'))
    }).catch((error) => logger.warn('Failed to send error log:', error));
  }


  async logAiDiagnostic(details: AiDiagnosticLogDetails): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = await this.resolveSourceChannelLabel(details.guildId, details.channelId);
    const observationSummary = sanitizeAiDiagnosticText(details.observationSummary, details);
    const promptSnippet = sanitizeAiDiagnosticText(details.promptSnippet, details);
    const responseSnippet = sanitizeAiDiagnosticText(details.responseSnippet, details);
    const headers = details.rateLimitHeaders && Object.keys(details.rateLimitHeaders).length
      ? Object.entries(details.rateLimitHeaders)
          .filter(([key]) => AI_RATE_LIMIT_HEADER_WHITELIST.has(key.toLowerCase()))
          .map(([key, value]) => `${key}=${value}`).join(',')
      : undefined;
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-AI`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `stage=${details.stage}`,
          `event=${details.event}`,
          details.model ? `model=${details.model}` : undefined,
          details.usageScope ? `usageScope=${details.usageScope}` : undefined,
          details.decisionKind ? `decision=${details.decisionKind}` : undefined,
          details.commandSafety ? `commandSafety=${details.commandSafety}` : undefined,
          details.runId ? `runId=${details.runId}` : undefined,
          typeof details.iteration === 'number' ? `iteration=${details.iteration}` : undefined,
          details.toolCallId ? `toolCallId=${details.toolCallId}` : undefined,
          details.toolName ? `toolName=${details.toolName}` : undefined,
          details.policy ? `policy=${details.policy}` : undefined,
          observationSummary ? `observationSummary=${truncate(observationSummary, 500)}` : undefined,
          typeof details.retryCount === 'number' ? `retryCount=${details.retryCount}` : undefined,
          details.validationErrors?.length ? `validationErrors=${truncate(details.validationErrors.join('; '), 500)}` : undefined,
          promptSnippet ? `prompt=${truncate(promptSnippet, 500)}` : undefined,
          responseSnippet ? `response=${truncate(responseSnippet, 500)}` : undefined,
          typeof details.promptTokens === 'number' ? `promptTokens=${details.promptTokens}` : undefined,
          typeof details.completionTokens === 'number' ? `completionTokens=${details.completionTokens}` : undefined,
          typeof details.totalTokens === 'number' ? `totalTokens=${details.totalTokens}` : undefined,
          headers ? `rateLimitHeaders=${truncate(headers, 500)}` : undefined,
          typeof details.status === 'number' ? `status=${details.status}` : undefined,
          details.errorName ? `errorName=${details.errorName}` : undefined,
          details.errorMessage ? `errorMessage=${truncate(details.errorMessage, 500)}` : undefined
        ].filter(Boolean).join('\n'))
    }).catch((error) => logger.warn('Failed to send AI diagnostic log:', error));
  }

  async logVoiceConnection(details: {
    guildId: string;
    guildName?: string | null;
    channelId?: string;
    message: string;
  }): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = details.channelId
      ? await this.resolveSourceChannelLabel(details.guildId, details.channelId)
      : `guild-${details.guildId}`;
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-VOICE`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `message=${details.message}`
        ].join('\n'))
    }).catch((error) => logger.warn('Failed to send voice log:', error));
  }

  async logTtsRequest(details: {
    guildId: string;
    guildName?: string | null;
    channelId: string;
    userId: string;
    userName?: string | null;
    source: 'command' | 'watched-channel';
    engine: string;
    voice?: string;
    text?: string;
    textLength?: number;
  }): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    const sourceLabel = await this.resolveSourceChannelLabel(details.guildId, details.channelId);
    const body =
      details.source === 'command'
        ? `text=${truncate(details.text ?? '')}`
        : `textLength=${details.textLength ?? 0}`;
    await channel.send({
      content: truncate(
        [
          `${sourceLabel}-TTS`,
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `source=${details.source}`,
          `engine=${details.engine}`,
          details.voice ? `voice=${details.voice}` : undefined,
          body
        ]
          .filter(Boolean)
          .join('\n'))
    }).catch((error) => logger.warn('Failed to send TTS log:', error));
  }

  private buildLogChannelName(sourceGuild: Guild): string {
    const name = sanitizeChannelName(`LOG-${sourceGuild.name}-${sourceGuild.id}`);
    return name.length <= 100 ? name : name.slice(0, 100).replace(/-+$/g, '');
  }

  private async ensureFixedChannels(guild: Guild): Promise<void> {
    const testCategory = await this.ensureCategory(guild, TEST_CHANNEL_CATEGORY_NAME);
    await this.ensureTextChannel(guild, '메모채널', 'Memorandum / memo channel', testCategory);
    await this.ensureTextChannel(guild, '봇-채팅-테스트채널', 'Bot chat test channel', testCategory);
    await this.ensureVoiceChannel(guild, '봇-음성-테스트채널', testCategory);
  }

  private async ensureAllSourceGuildLogChannels(guild: Guild): Promise<void> {
    const guilds = await this.client.guilds.fetch();
    for (const sourceGuild of guilds.values()) {
      if (sourceGuild.id === guild.id) continue;
      await this.ensureGuildLogChannel(sourceGuild.id);
    }
  }

  private async ensureTextChannel(guild: Guild, name: string, topic: string, parent?: CategoryChannel): Promise<void> {
    const existing = guild.channels.cache.find(
      (channel): channel is TextChannel => channel.type === ChannelType.GuildText && channel.name === name
    );
    if (existing) {
      if (parent && existing.parentId !== parent.id) {
        await existing.edit({ parent: parent.id }).catch((error) => logger.warn(`Failed to move text channel ${name}:`, error));
      }
      return;
    }
    await guild.channels
      .create({
        name,
        type: ChannelType.GuildText,
        topic,
        parent: parent?.id
      })
      .catch((error) => logger.warn(`Failed to create text channel ${name}:`, error));
  }

  private async ensureVoiceChannel(guild: Guild, name: string, parent?: CategoryChannel): Promise<void> {
    const existing = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildVoice && channel.name === name
    );
    if (existing) {
      if (parent && existing.parentId !== parent.id) {
        await existing.edit({ parent: parent.id }).catch((error) => logger.warn(`Failed to move voice channel ${name}:`, error));
      }
      return;
    }
    await guild.channels
      .create({
        name,
        type: ChannelType.GuildVoice,
        parent: parent?.id
      })
      .catch((error) => logger.warn(`Failed to create voice channel ${name}:`, error));
  }

  private async ensureCategory(guild: Guild, name: string): Promise<CategoryChannel> {
    const existing = guild.channels.cache.find(
      (channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory && channel.name === name
    );
    if (existing) return existing;
    const created = await guild.channels
      .create({
        name,
        type: ChannelType.GuildCategory
      })
      .catch((error) => {
        logger.warn(`Failed to create category ${name}:`, error);
        return null;
      });
    if (!created || created.type !== ChannelType.GuildCategory) {
      throw new Error(`Unable to create required category: ${name}`);
    }
    return created;
  }

  private hasCategoryCapacity(guild: Guild, category: CategoryChannel): boolean {
    const childCount = Array.from(guild.channels.cache.values()).filter((channel) => channel.parentId === category.id).length;
    return childCount < DISCORD_CATEGORY_CHANNEL_LIMIT;
  }

  private findExistingLogChannel(guild: Guild, desiredName: string, desiredTopic: string): TextChannel | undefined {
    return Array.from(guild.channels.cache.values()).find(
      (channel): channel is TextChannel =>
        channel.type === ChannelType.GuildText &&
        (channel.topic === desiredTopic || channel.name === desiredName)
    );
  }

  private async findAvailableLogCategory(guild: Guild): Promise<CategoryChannel | undefined> {
    const existingCategories = Array.from(guild.channels.cache.values())
      .filter((channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory && channel.name.startsWith(LOG_CHANNEL_CATEGORY_NAME))
      .sort((left, right) => left.name.localeCompare(right.name));

    const available = existingCategories.find((category) => this.hasCategoryCapacity(guild, category));
    if (available) return available;

    const nextIndex = existingCategories.length + 1;
    const name = nextIndex === 1 ? LOG_CHANNEL_CATEGORY_NAME : `${LOG_CHANNEL_CATEGORY_NAME}-${nextIndex}`;
    return this.ensureCategory(guild, name).catch((error) => {
      logger.warn(`Failed to create available log category ${name}:`, error);
      return undefined;
    });
  }

  private async resolveSourceChannelLabel(guildId: string, channelId: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return `unknown-${channelId}`;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const channelName = channel?.name ?? 'unknown';
    return `${sanitizeChannelName(channelName)}-${channelId}`;
  }

  private async resolveLoggingGuild(): Promise<Guild | null> {
    return this.client.guilds.fetch(this.loggingGuildId).catch(() => null);
  }
}
