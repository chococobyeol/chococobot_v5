import { ChannelType, type CategoryChannel, type Client, type Guild, type TextChannel } from 'discord.js';
import type { BotActivityLogStore } from './botActivityLogStore.js';
import { logger } from '../logger.js';


export type AiDiagnosticLogDetails = {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  userId: string;
  userName?: string | null;
  stage: 'planner' | 'chat' | 'summary';
  event: 'request' | 'response' | 'parse_error' | 'retry' | 'decision' | 'error' | 'rate_limit';
  model?: string;
  usageScope?: string;
  decisionKind?: string;
  commandSafety?: string;
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
const AI_RATE_LIMIT_HEADER_WHITELIST = new Set([
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens'
]);

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

    const channel = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildText,
      topic: desiredTopic,
      parent: parent?.id
    });
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
          typeof details.retryCount === 'number' ? `retryCount=${details.retryCount}` : undefined,
          details.validationErrors?.length ? `validationErrors=${truncate(details.validationErrors.join('; '), 500)}` : undefined,
          details.promptSnippet ? `prompt=${truncate(details.promptSnippet, 500)}` : undefined,
          details.responseSnippet ? `response=${truncate(details.responseSnippet, 500)}` : undefined,
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
    const logCategory = await this.ensureCategory(guild, LOG_CHANNEL_CATEGORY_NAME);
    const guilds = await this.client.guilds.fetch();
    for (const sourceGuild of guilds.values()) {
      if (sourceGuild.id === guild.id) continue;
      await this.ensureGuildLogChannel(sourceGuild.id, logCategory);
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
