import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection
} from '@discordjs/voice';
import type { GuildMember, Message, TextBasedChannel, VoiceBasedChannel } from 'discord.js';
import { isDaveCloseCode } from './voiceDiagnostics.js';
import { normalizeTtsEngineName, TtsService, type TtsEngine } from './ttsService.js';
import type { VoiceSettingsStore } from './voiceSettingsStore.js';
import { logger } from '../logger.js';

export type VoiceQueueItem = {
  text: string;
  userId?: string;
};

export type GuildVoiceState = {
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: VoiceQueueItem[];
  playing: boolean;
  generation: number;
  lastError?: string;
  idleLeaveTimer?: NodeJS.Timeout;
};

export class VoiceService {
  private readonly states = new Map<string, GuildVoiceState>();

  constructor(
    private readonly tts: TtsService,
    private readonly voiceSettings: VoiceSettingsStore,
    private readonly voicePresets: Readonly<Record<string, string>>,
    private readonly defaultTtsEngine: TtsEngine,
    private readonly idleLeaveMs: number
  ) {}

  async join(member: GuildMember): Promise<void> {
    const channel = member.voice.channel;
    if (!channel) throw new Error('먼저 음성 채널에 들어가 주세요...');
    await this.joinChannel(channel);
  }

  async joinChannel(channel: VoiceBasedChannel): Promise<void> {
    this.leave(channel.guild.id);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        // TTS 재생만 필요하므로 수신 경로를 열지 않고 연결합니다.
        // 현재 Discord voice 환경에서는 selfDeaf=false 조합이 Ready에 도달하지 못하는 경우가 있어,
        // 안정적인 재생을 위해 deafened 상태로 조인합니다.
        selfDeaf: true
      });
      connection.subscribe(player);
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.states.set(channel.guild.id, {
        connection,
        player,
        queue: [],
        playing: false,
        generation: 0
      });
      player.on('error', (error) => logger.error('Audio player error:', error));
    } catch (error) {
      if (isDaveCloseCode(error)) {
        throw new Error(
          'Discord DAVE/E2EE voice 연결 실패(4017 가능): @discordjs/voice와 @snazzah/davey 버전을 확인해 주세요...'
        );
      }
      throw error;
    }
  }

  leave(guildId: string): void {
    const state = this.states.get(guildId);
    if (state?.idleLeaveTimer) clearTimeout(state.idleLeaveTimer);
    state?.player.stop();
    state?.connection.destroy();
    this.states.delete(guildId);
    getVoiceConnection(guildId)?.destroy();
  }

  isConnected(guildId: string): boolean {
    return this.states.has(guildId);
  }

  setWatchedChannel(guildId: string, channelId: string, enabled: boolean): void {
    this.voiceSettings.setWatchedChannelId(guildId, enabled ? channelId : undefined);
  }

  getWatchedChannelId(guildId: string): string | undefined {
    return this.voiceSettings.getWatchedChannelId(guildId);
  }

  isWatching(guildId: string, channelId: string): boolean {
    return this.voiceSettings.getWatchedChannelId(guildId) === channelId;
  }

  async enqueueMessage(message: Message): Promise<boolean> {
    if (!message.guildId || !this.isWatching(message.guildId, message.channelId)) return false;
    if (!this.states.has(message.guildId)) return false;
    const author = message.member?.displayName ?? message.author.displayName ?? message.author.username;
    return this.speak(message.guildId, `${author}님: ${message.cleanContent}`, message.author.id);
  }

  async speak(guildId: string, text: string, userId?: string): Promise<boolean> {
    const state = this.getState(guildId);
    state.lastError = undefined;
    if (state.idleLeaveTimer) {
      clearTimeout(state.idleLeaveTimer);
      state.idleLeaveTimer = undefined;
    }
    state.queue.push({ text, userId });
    if (!state.playing) return this.drain(guildId, state);
    return true;
  }

  stopPlayback(guildId: string): boolean {
    const state = this.states.get(guildId);
    if (!state) return false;
    state.generation += 1;
    state.queue.length = 0;
    state.playing = false;
    state.player.stop(true);
    this.scheduleIdleLeave(guildId, state);
    return true;
  }

  listVoicePresets(): string[] {
    return Object.keys(this.voicePresets).sort();
  }

  getUserVoicePreset(guildId: string, userId: string): string | undefined {
    return this.voiceSettings.getUserVoicePreset(guildId, userId);
  }

  setUserVoicePreset(guildId: string, userId: string, preset: string): void {
    const normalized = preset.toLowerCase();
    if (!this.voicePresets[normalized]) {
      throw new Error(`알 수 없는 음색이에요. 사용 가능: ${this.listVoicePresets().join(', ')}`);
    }
    this.voiceSettings.setUserVoicePreset(guildId, userId, normalized);
  }

  listTtsEngines(): TtsEngine[] {
    return ['edge', 'gtts'];
  }

  getUserTtsEngine(guildId: string, userId: string): TtsEngine {
    const stored = this.voiceSettings.getUserTtsEngine(guildId, userId) as TtsEngine | undefined;
    return stored ?? this.defaultTtsEngine;
  }

  setUserTtsEngine(guildId: string, userId: string, engine: string): void {
    const normalized = normalizeTtsEngineName(engine);
    if (!normalized) {
      throw new Error(`알 수 없는 TTS 엔진이에요. 사용 가능: ${this.listTtsEngines().join(', ')}`);
    }
    this.voiceSettings.setUserTtsEngine(guildId, userId, normalized);
  }

  clearUserTtsEngine(guildId: string, userId: string): void {
    this.voiceSettings.setUserTtsEngine(guildId, userId, undefined);
  }

  getLastError(guildId: string): string | undefined {
    return this.states.get(guildId)?.lastError;
  }

  private async drain(guildId: string, state: GuildVoiceState): Promise<boolean> {
    const generation = state.generation;
    const next = state.queue.shift();
    if (!next) {
      state.playing = false;
      this.scheduleIdleLeave(guildId, state);
      return false;
    }
    state.playing = true;

    let filePath: string | undefined;
    let played = false;
    try {
      filePath = await this.synthesizeWithFallback(guildId, next);
      if (!this.states.has(guildId) || this.states.get(guildId) !== state || state.generation !== generation) {
        return false;
      }
      const resource = createAudioResource(filePath);
      state.player.play(resource);
      await entersState(state.player, AudioPlayerStatus.Idle, 60_000);
      played = true;
    } catch (error) {
      state.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logger.error('TTS synthesis/playback failed:', error);
    } finally {
      if (filePath) await this.tts.cleanup(filePath);
    }

    if (!this.states.has(guildId) || this.states.get(guildId) !== state || state.generation !== generation) {
      return played;
    }
    const restPlayed = this.states.has(guildId) ? await this.drain(guildId, state) : false;
    return played || restPlayed;
  }

  private async synthesizeWithFallback(guildId: string, item: VoiceQueueItem): Promise<string> {
    const voice = this.resolveVoice(guildId, item.userId);
    const primaryEngine = this.resolveEngine(guildId, item.userId);
    try {
      return await this.tts.synthesize(item.text, voice, primaryEngine);
    } catch (primaryError) {
      if (primaryEngine !== 'edge') throw primaryError;
      logger.warn('Edge TTS failed; retrying with gTTS:', primaryError);
      try {
        return await this.tts.synthesize(item.text, voice, 'gtts');
      } catch (fallbackError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`edge TTS failed: ${primaryMessage}; gTTS fallback failed: ${fallbackMessage}`);
      }
    }
  }

  private getState(guildId: string): GuildVoiceState {
    const state = this.states.get(guildId);
    if (!state) throw new Error('봇이 아직 음성 채널에 연결되어 있지 않아요... `!들어와`를 먼저 실행해 주세요...');
    return state;
  }

  private resolveVoice(guildId: string, userId: string | undefined): string | undefined {
    if (!userId) return undefined;
    const preset = this.voiceSettings.getUserVoicePreset(guildId, userId);
    return preset ? this.voicePresets[preset] : undefined;
  }

  private resolveEngine(guildId: string, userId: string | undefined): TtsEngine {
    if (!userId) return this.defaultTtsEngine;
    return this.getUserTtsEngine(guildId, userId);
  }

  private scheduleIdleLeave(guildId: string, state: GuildVoiceState): void {
    if (this.idleLeaveMs < 1) return;
    if (state.idleLeaveTimer) clearTimeout(state.idleLeaveTimer);
    state.idleLeaveTimer = setTimeout(() => {
      const current = this.states.get(guildId);
      if (current !== state) return;
      if (current.playing || current.queue.length > 0) return;
      logger.info(`Voice idle timeout reached for guild ${guildId}; leaving voice channel.`);
      this.leave(guildId);
    }, this.idleLeaveMs);
  }
}

export function assertTextChannel(channel: TextBasedChannel | null): asserts channel is TextBasedChannel {
  if (!channel) throw new Error('텍스트 채널을 찾을 수 없어요...');
}
