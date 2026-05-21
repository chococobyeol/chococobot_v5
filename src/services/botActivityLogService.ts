import { ChannelType, type Client, type Guild, type TextChannel } from 'discord.js';
import type { BotActivityLogStore } from './botActivityLogStore.js';
import { logger } from '../logger.js';

type CommandLogDetails = {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  userId: string;
  userName?: string | null;
  commandName: string;
  summary: string;
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

function formatLogHeader(kind: string, details: { guildId: string; channelId?: string; userId?: string }): string {
  const lines = [`[${kind}]`, `guild=${details.guildId}`];
  if (details.channelId) lines.push(`channel=${details.channelId}`);
  if (details.userId) lines.push(`user=${details.userId}`);
  return lines.join(' | ');
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

  async ensureGuildLogChannel(sourceGuildId: string): Promise<TextChannel | undefined> {
    const guild = await this.resolveLoggingGuild();
    if (!guild) return undefined;
    const sourceGuild = await this.client.guilds.fetch(sourceGuildId).catch(() => null);
    if (!sourceGuild) return undefined;

    const existingChannelId = this.store.getLogChannelId(sourceGuildId);
    if (existingChannelId) {
      const cached = await guild.channels.fetch(existingChannelId).catch(() => null);
      if (cached?.type === ChannelType.GuildText) return cached;
    }

    const channel = await guild.channels.create({
      name: this.buildLogChannelName(sourceGuild),
      type: ChannelType.GuildText,
      topic: `Source guild: ${sourceGuild.name} (${sourceGuild.id})`
    });
    this.store.setLogChannelId(sourceGuildId, channel.id);
    return channel;
  }

  async logCommand(details: CommandLogDetails): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    await channel.send({
      content: truncate(
        [
          formatLogHeader('COMMAND', {
            guildId: details.guildId,
            channelId: details.channelId,
            userId: details.userId
          }),
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `command=${details.commandName}`,
          `summary=${details.summary}`
        ].join('\n'))
    }).catch((error) => logger.warn('Failed to send command log:', error));
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
    const errorText = details.error instanceof Error ? `${details.error.name}: ${details.error.message}` : String(details.error);
    await channel.send({
      content: truncate(
        [
          formatLogHeader('ERROR', {
            guildId: details.guildId,
            channelId: details.channelId,
            userId: details.userId
          }),
          `guildName=${details.guildName ?? 'unknown'}`,
          `userName=${details.userName ?? 'unknown'}`,
          `command=${details.commandName}`,
          `summary=${details.summary}`,
          `error=${errorText}`
        ].join('\n'))
    }).catch((error) => logger.warn('Failed to send error log:', error));
  }

  async logVoiceConnection(details: {
    guildId: string;
    guildName?: string | null;
    channelId?: string;
    message: string;
  }): Promise<void> {
    const channel = await this.ensureGuildLogChannel(details.guildId);
    if (!channel) return;
    await channel.send({
      content: truncate(
        [
          formatLogHeader('VOICE', { guildId: details.guildId, channelId: details.channelId }),
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
    const body =
      details.source === 'command'
        ? `text=${truncate(details.text ?? '')}`
        : `textLength=${details.textLength ?? 0}`;
    await channel.send({
      content: truncate(
        [
          formatLogHeader('TTS', {
            guildId: details.guildId,
            channelId: details.channelId,
            userId: details.userId
          }),
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
    return sanitizeChannelName(`서버로그-${sourceGuild.id.slice(-6)}`);
  }

  private async ensureFixedChannels(guild: Guild): Promise<void> {
    await this.ensureTextChannel(guild, '메모채널', 'Memorandum / memo channel');
    await this.ensureTextChannel(guild, '봇-채팅-테스트채널', 'Bot chat test channel');
    await this.ensureVoiceChannel(guild, '봇-음성-테스트채널');
  }

  private async ensureAllSourceGuildLogChannels(guild: Guild): Promise<void> {
    const guilds = await this.client.guilds.fetch();
    for (const sourceGuild of guilds.values()) {
      if (sourceGuild.id === guild.id) continue;
      await this.ensureGuildLogChannel(sourceGuild.id);
    }
  }

  private async ensureTextChannel(guild: Guild, name: string, topic: string): Promise<void> {
    const existing = guild.channels.cache.find(
      (channel): channel is TextChannel => channel.type === ChannelType.GuildText && channel.name === name
    );
    if (existing) return;
    await guild.channels
      .create({
        name,
        type: ChannelType.GuildText,
        topic
      })
      .catch((error) => logger.warn(`Failed to create text channel ${name}:`, error));
  }

  private async ensureVoiceChannel(guild: Guild, name: string): Promise<void> {
    const existing = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildVoice && channel.name === name
    );
    if (existing) return;
    await guild.channels
      .create({
        name,
        type: ChannelType.GuildVoice
      })
      .catch((error) => logger.warn(`Failed to create voice channel ${name}:`, error));
  }

  private async resolveLoggingGuild(): Promise<Guild | null> {
    return this.client.guilds.fetch(this.loggingGuildId).catch(() => null);
  }
}
