import 'dotenv/config';

export type Settings = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  groqApiKey: string;
  groqModel: string;
  aiSystemPrompt: string;
  aiMaxCompletionTokens: number;
  aiUserDailyTokenLimit: number;
  aiGuildDailyTokenLimit: number;
  cleanMineDefaultTarget: number;
  cleanMineMaxLimit: number;
  cleanAllDefaultTarget: number;
  cleanAllMaxLimit: number;
  databasePath: string;
  loggingGuildId: string;
  voiceIdleLeaveMs: number;
  ttsEngine: string;
  ttsVoice: string;
  ttsMaxChars: number;
  ttsReadBotMessages: boolean;
  ttsVoicePresets: Readonly<Record<string, string>>;
  logLevel: string;
};

export const DEFAULT_TTS_VOICE_PRESETS: Readonly<Record<string, string>> = {
  sunhi: 'ko-KR-SunHiNeural',
  injoon: 'ko-KR-InJoonNeural',
  bright: 'ko-KR-SunHiNeural',
  calm: 'ko-KR-InJoonNeural'
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = intFromEnv(name, fallback);
  if (parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

export function loadSettings(): Settings {
  return {
    discordToken: process.env.DISCORD_TOKEN ?? '',
    discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
    discordGuildId: process.env.DISCORD_GUILD_ID || undefined,
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    groqModel: process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
    aiSystemPrompt:
      process.env.AI_SYSTEM_PROMPT ??
      'You are ChococoBot, a concise and friendly Korean Discord assistant.',
    aiMaxCompletionTokens: intFromEnv('AI_MAX_COMPLETION_TOKENS', 800),
    aiUserDailyTokenLimit: intFromEnv('AI_USER_DAILY_TOKEN_LIMIT', 20_000),
    aiGuildDailyTokenLimit: intFromEnv('AI_GUILD_DAILY_TOKEN_LIMIT', 100_000),
    cleanMineDefaultTarget: positiveIntFromEnv('CLEAN_MINE_DEFAULT_TARGET', 500),
    cleanMineMaxLimit: positiveIntFromEnv('CLEAN_MINE_MAX_LIMIT', 500),
    cleanAllDefaultTarget: positiveIntFromEnv('CLEAN_ALL_DEFAULT_TARGET', 1000),
    cleanAllMaxLimit: positiveIntFromEnv('CLEAN_ALL_MAX_LIMIT', 1000),
    databasePath: process.env.DATABASE_PATH ?? 'data/chococobot.sqlite3',
    loggingGuildId: process.env.LOGGING_GUILD_ID ?? '1507058598423826533',
    voiceIdleLeaveMs: positiveIntFromEnv('VOICE_IDLE_LEAVE_MS', 10 * 60 * 1000),
    ttsEngine: process.env.TTS_ENGINE ?? 'edge',
    ttsVoice: process.env.TTS_VOICE ?? 'ko-KR-SunHiNeural',
    ttsMaxChars: positiveIntFromEnv('TTS_MAX_CHARS', 180),
    ttsReadBotMessages: boolFromEnv('TTS_READ_BOT_MESSAGES', false),
    ttsVoicePresets: DEFAULT_TTS_VOICE_PRESETS,
    logLevel: process.env.LOG_LEVEL ?? 'info'
  };
}

export function assertRuntimeSettings(settings: Settings): void {
  const missing: string[] = [];
  if (!settings.discordToken) missing.push('DISCORD_TOKEN');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (!settings.loggingGuildId) throw new Error('LOGGING_GUILD_ID is required');
  if (!['edge', 'gtts'].includes(settings.ttsEngine.toLowerCase())) {
    throw new Error('TTS_ENGINE must be one of: edge, gtts');
  }
  if (settings.cleanMineDefaultTarget > settings.cleanMineMaxLimit) {
    throw new Error('CLEAN_MINE_DEFAULT_TARGET must be less than or equal to CLEAN_MINE_MAX_LIMIT');
  }
  if (settings.cleanAllDefaultTarget > settings.cleanAllMaxLimit) {
    throw new Error('CLEAN_ALL_DEFAULT_TARGET must be less than or equal to CLEAN_ALL_MAX_LIMIT');
  }
}
