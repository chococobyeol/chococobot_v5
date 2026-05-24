import type { GuildTextBasedChannel, Message } from 'discord.js';
import type { Settings } from '../config.js';
import { AiLimitError, extractErrorDetails, type AiChatMessage, type AiDetailedResponse, type AiService } from './aiService.js';
import type { AiMemoryStore, AiMemoryTurn } from './aiMemoryStore.js';
import type { BotActivityLogService } from './botActivityLogService.js';
import type { VoiceSettingsStore } from './voiceSettingsStore.js';
import { logger } from '../logger.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_SAFE_CHUNK_LIMIT = 1900;
const MEMORY_CONTEXT_MAX_CHARS = 1200;
const MEMORY_CONTEXT_TURN_MAX_CHARS = 240;
const MEMORY_CONTEXT_SUMMARY_MAX_CHARS = 500;

export function parseAiChatTrigger(content: string, prefix: string): string | null {
  const trigger = `${prefix}?`;
  if (!content.startsWith(trigger)) return null;
  const remainder = content.slice(trigger.length);
  if (!/^\s+\S[\s\S]*$/.test(remainder)) return null;
  const prompt = remainder.trim();
  return prompt ? prompt : null;
}

function chunkDiscordMessage(content: string, limit = DISCORD_SAFE_CHUNK_LIMIT): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let sliceIndex = remaining.lastIndexOf('\n', limit);
    if (sliceIndex < Math.floor(limit * 0.5)) sliceIndex = limit;
    chunks.push(remaining.slice(0, sliceIndex).trim());
    remaining = remaining.slice(sliceIndex).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean).map((chunk) => (chunk.length > DISCORD_MESSAGE_LIMIT ? chunk.slice(0, DISCORD_SAFE_CHUNK_LIMIT) : chunk));
}


function prepareAiChatReply(content: string): string {
  const trimmed = content.trim();
  return trimmed || '응답이 비어 있어요...';
}

function truncateMemoryText(content: string, limit: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatMemoryContextTurn(turn: AiMemoryTurn): string {
  const text = truncateMemoryText(turn.content, MEMORY_CONTEXT_TURN_MAX_CHARS);
  if (turn.role === 'assistant') return `assistant: ${text}`;
  return `user(${turn.userName}, <#${turn.channelId}>): ${text}`;
}

function formatUserTurn(turn: AiMemoryTurn): AiChatMessage {
  if (turn.role === 'assistant') {
    return { role: 'assistant', content: turn.content };
  }
  return {
    role: 'user',
    content: [
      `작성자: ${turn.userName} (${turn.userId})`,
      `채널: <#${turn.channelId}>`,
      turn.content
    ].join('\n')
  };
}

function formatCurrentUserTurn(message: Message, prompt: string): AiChatMessage {
  const userName = message.member?.displayName ?? message.author.username;
  return {
    role: 'user',
    content: [
      `작성자: ${userName} (${message.author.id})`,
      `채널: <#${message.channelId}>`,
      prompt
    ].join('\n')
  };
}

function buildMemorySummaryPrompt(summary: string, turns: AiMemoryTurn[]): string {
  const existing = summary ? `기존 요약:\n${summary}` : '기존 요약: (없음)';
  const turnText = turns
    .map((turn) => {
      const roleLabel = turn.role === 'assistant' ? 'assistant' : 'user';
      return [
        `- id=${turn.id}`,
        `role=${roleLabel}`,
        `author=${turn.userName} (${turn.userId})`,
        `channel=${turn.channelId}`,
        `text=${turn.content}`
      ].join('\n');
    })
    .join('\n\n');

  return [
    '당신은 Discord 서버 대화 메모리를 압축하는 요약기예요.',
    '다음 대화에서 중요한 사실, 결정, 선호, 진행 중인 작업만 한국어로 간결하게 정리해요.',
    '민감한 개인정보는 불필요하게 확장하지 말고, 대화 맥락을 유지하는 데 필요한 내용만 남겨요.',
    existing,
    '새로 반영할 턴:',
    turnText || '(없음)',
    `출력 길이는 ${DISCORD_SAFE_CHUNK_LIMIT}자보다 훨씬 짧게 유지해요.`
  ].join('\n\n');
}

async function sendChunkedReply(message: Message, content: string): Promise<void> {
  const chunks = chunkDiscordMessage(content);
  if (!chunks.length) {
    await message.reply({ content: '응답이 비어 있어요...', allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser: false } });
  const channel = message.channel as GuildTextBasedChannel;
  for (const chunk of chunks.slice(1)) {
    await channel.send({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
  }
}

export class AiChatService {
  private readonly channelQueues = new Map<string, Promise<unknown>>();
  private readonly guildLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly settings: Settings,
    private readonly ai: AiService,
    private readonly memory: AiMemoryStore,
    private readonly activityLog: BotActivityLogService,
    private readonly userSettings?: Pick<VoiceSettingsStore, 'getUserTimeZone'>
  ) {}

  handlePrompt(message: Message, prompt: string): Promise<boolean> {
    if (!message.guildId || message.author.bot) return Promise.resolve(false);
    const key = message.channelId;
    const task = async (): Promise<boolean> => {
      try {
        await this.activityLog
          .logCommand({
            guildId: message.guildId!,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: message.member?.displayName ?? message.author.username,
            commandName: 'ai-chat',
            summary: `prompt=${prompt.slice(0, 500)}`
          })
          .catch((error) => logger.warn('Failed to log AI command:', error));

        const snapshot = this.memory.getGuildSnapshot(message.guildId!, this.settings.aiMemoryRecentTurns);
        const messages: AiChatMessage[] = [{ role: 'system', content: this.settings.aiSystemPrompt }];
        if (snapshot.summary) {
          messages.push({
            role: 'system',
            content: `서버 대화 요약:\n${snapshot.summary}`
          });
        }
        for (const turn of snapshot.recentTurns) {
          messages.push(formatUserTurn(turn));
        }
        messages.push({
          role: 'system',
          content: [
            `현재 사용자 메시지 작성 시각 timestamp: <t:${Math.floor(message.createdTimestamp / 1000)}:t>`,
            '현재 시간이나 상대 시간 질문에는 시간을 추측하지 말고 이 Discord timestamp 기준으로 답해요.',
            '보는 사람의 로컬 시간이 필요한 경우 <t:...:t> 형식을 그대로 사용해요.'
          ].join('\n')
        });
        messages.push(formatCurrentUserTurn(message, prompt));

        const detailed = await this.askDetailedOrText({
          guildId: message.guildId!,
          userId: message.author.id,
          messages
        });
        const rawAnswer = typeof detailed === 'string' ? detailed : detailed.content;
        const answer = prepareAiChatReply(rawAnswer);
        if (typeof detailed !== 'string') {
          await this.logAiDiagnostic(message, {
            stage: 'chat',
            event: 'response',
            model: detailed.model,
            usageScope: detailed.usageScope,
            promptTokens: detailed.promptTokens,
            completionTokens: detailed.completionTokens,
            totalTokens: detailed.totalTokens,
            rateLimitHeaders: detailed.rateLimitHeaders,
            status: detailed.status,
            responseSnippet: answer.slice(0, 500)
          });
        }

        await sendChunkedReply(message, answer);

        await this.activityLog
          .logCommand({
            guildId: message.guildId!,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: message.member?.displayName ?? message.author.username,
            commandName: 'ai-chat-response',
            summary: `answer=${answer.slice(0, 500)}`
          })
          .catch((error) => logger.warn('Failed to log AI response:', error));

        await this.withGuildLock(message.guildId!, async () => {
          const at = new Date();
          const userName = message.member?.displayName ?? message.author.username;
          this.memory.appendTurn({
            guildId: message.guildId!,
            channelId: message.channelId,
            userId: message.author.id,
            userName,
            messageId: message.id,
            role: 'user',
            content: prompt,
            importance: 0,
            createdAt: at
          });
          this.memory.appendTurn({
            guildId: message.guildId!,
            channelId: message.channelId,
            userId: message.client.user?.id ?? '__bot__',
            userName: message.client.user?.username ?? 'ChococoBot',
            messageId: null,
            role: 'assistant',
            content: answer,
            importance: 0,
            createdAt: at
          });
          await this.maybeCompactGuildMemory(message.guildId!, message.author.id);
        });

        return true;
      } catch (error) {
        await this.handleError(message, prompt, error).catch((logError) => logger.error(logError));
        return true;
      }
    };

    return this.enqueue(this.channelQueues, key, task);
  }

  getConversationContext(guildId: string, limit = this.settings.aiMemoryRecentTurns): string {
    const safeLimit = Math.max(1, Math.min(limit, this.settings.aiMemoryRecentTurns));
    const snapshot = this.memory.getGuildSnapshot(guildId, safeLimit);
    const sections: string[] = [];
    if (snapshot.summary.trim()) {
      sections.push(`요약:\n${truncateMemoryText(snapshot.summary, MEMORY_CONTEXT_SUMMARY_MAX_CHARS)}`);
    }
    if (snapshot.recentTurns.length) {
      sections.push(`최근 대화:\n${snapshot.recentTurns.map(formatMemoryContextTurn).join('\n')}`);
    }
    return truncateMemoryText(sections.join('\n\n'), MEMORY_CONTEXT_MAX_CHARS);
  }

  async rememberExchange(message: Message, prompt: string, answer: string): Promise<void> {
    if (!message.guildId || message.author.bot) return;
    await this.withGuildLock(message.guildId, async () => {
      const at = new Date();
      const userName = message.member?.displayName ?? message.author.username;
      this.memory.appendTurn({
        guildId: message.guildId!,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
        messageId: message.id,
        role: 'user',
        content: prompt,
        importance: 0,
        createdAt: at
      });
      this.memory.appendTurn({
        guildId: message.guildId!,
        channelId: message.channelId,
        userId: message.client.user?.id ?? '__bot__',
        userName: message.client.user?.username ?? 'ChococoBot',
        messageId: null,
        role: 'assistant',
        content: prepareAiChatReply(answer),
        importance: 0,
        createdAt: at
      });
      await this.maybeCompactGuildMemory(message.guildId!, message.author.id);
    });
  }

  resetGuildMemory(guildId: string): Promise<void> {
    return this.withGuildLock(guildId, async () => {
      this.memory.resetGuildMemory(guildId);
    });
  }


  private async askDetailedOrText(params: Parameters<AiService['askMessages']>[0]): Promise<string | AiDetailedResponse> {
    if ('askMessagesDetailed' in this.ai && typeof this.ai.askMessagesDetailed === 'function') {
      return this.ai.askMessagesDetailed(params);
    }
    return this.ai.askMessages(params);
  }

  private async logAiDiagnostic(message: Message, details: {
    stage: 'chat' | 'summary';
    event: 'response' | 'error' | 'rate_limit';
    model?: string;
    usageScope?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    rateLimitHeaders?: Readonly<Record<string, string>>;
    status?: number;
    responseSnippet?: string;
    error?: unknown;
  }): Promise<void> {
    if (!message.guildId) return;
    const errorDetails = details.error ? extractErrorDetails(details.error) : undefined;
    await this.activityLog.logAiDiagnostic({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      stage: details.stage,
      event: details.event,
      model: details.model,
      usageScope: details.usageScope,
      promptTokens: details.promptTokens,
      completionTokens: details.completionTokens,
      totalTokens: details.totalTokens,
      rateLimitHeaders: details.rateLimitHeaders ?? errorDetails?.rateLimitHeaders,
      status: details.status ?? errorDetails?.status,
      responseSnippet: details.responseSnippet,
      errorName: errorDetails?.errorName,
      errorMessage: errorDetails?.errorMessage
    }).catch((error) => logger.warn('Failed to log AI diagnostic:', error));
  }

  private async handleError(message: Message, prompt: string, error: unknown): Promise<void> {
    logger.error(error);
    await this.logAiDiagnostic(message, { stage: 'chat', event: extractErrorDetails(error).status === 429 ? 'rate_limit' : 'error', error });
    await this.activityLog.logError({
      guildId: message.guildId!,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      commandName: 'ai-chat',
      summary: `prompt=${prompt.slice(0, 500)}`,
      error
    });
    const errorMessage = error instanceof AiLimitError ? error.message : 'AI 답변을 가져오지 못했어요...';
    await message.reply({ content: errorMessage, allowedMentions: { parse: [], repliedUser: false } });
  }

  private async maybeCompactGuildMemory(guildId: string, userId: string): Promise<void> {
    try {
      const snapshot = this.memory.getGuildSnapshot(guildId, this.settings.aiMemoryRecentTurns);
      if (
        snapshot.unsummarizedCount < this.settings.aiMemoryCompactAfterTurns &&
        snapshot.unsummarizedChars < this.settings.aiMemoryMaxSummaryChars &&
        snapshot.summary.length <= this.settings.aiMemoryMaxSummaryChars
      ) {
        return;
      }

      const messages: AiChatMessage[] = [
        { role: 'system', content: '당신은 Discord 서버 대화 메모리를 압축하는 요약기예요.' },
        { role: 'user', content: buildMemorySummaryPrompt(snapshot.summary, snapshot.recentTurns) }
      ];
      const detailed = await this.askDetailedOrText({
        guildId,
        userId,
        messages,
        usageScope: 'summary'
      });
      const summary = typeof detailed === 'string' ? detailed : detailed.content;
      if (typeof detailed !== 'string') {
        await this.activityLog.logAiDiagnostic({
          guildId,
          guildName: null,
          channelId: 'memory-compaction',
          userId,
          userName: 'ChococoBot',
          stage: 'summary',
          event: 'response',
          model: detailed.model,
          usageScope: detailed.usageScope,
          promptTokens: detailed.promptTokens,
          completionTokens: detailed.completionTokens,
          totalTokens: detailed.totalTokens,
          rateLimitHeaders: detailed.rateLimitHeaders,
          status: detailed.status,
          responseSnippet: summary.slice(0, 500)
        }).catch((logError) => logger.warn('Failed to log AI summary diagnostic:', logError));
      }
      const compacted = summary.slice(0, this.settings.aiMemoryMaxSummaryChars).trim();
      this.memory.replaceSummaryAndMarkCompacted(guildId, compacted);
    } catch (error) {
      logger.warn('AI memory compaction failed:', error);
      await this.activityLog
        .logError({
          guildId,
          guildName: null,
          channelId: 'memory-compaction',
          userId,
          userName: 'ChococoBot',
          commandName: 'ai-memory-compact',
          summary: `guild=${guildId}`,
          error
        })
        .catch((logError) => logger.error(logError));
    }
  }

  private enqueue<T>(queues: Map<string, Promise<unknown>>, key: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    queues.set(key, current.then(() => undefined, () => undefined));
    return current;
  }

  private withGuildLock<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    return this.enqueue(this.guildLocks, guildId, task);
  }
}
