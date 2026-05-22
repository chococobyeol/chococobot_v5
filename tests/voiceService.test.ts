import { createAudioPlayer } from '@discordjs/voice';
import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../src/services/voiceService.js';
import { TtsService } from '../src/services/ttsService.js';
import { InMemoryVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';

describe('VoiceService speak failure handling', () => {
  it('returns false and does not throw when synthesis fails', async () => {
    const tts = {
      synthesize: vi.fn(async () => {
        throw new Error('boom');
      }),
      cleanup: vi.fn(async () => undefined)
    } as unknown as TtsService;
    const store = new InMemoryVoiceSettingsStore();
    const service = new VoiceService(tts, store, { sunhi: 'ko-KR-SunHiNeural' }, 'edge', 1_000);

    (service as any).states.set('guild-1', {
      connection: { destroy: vi.fn() },
      player: createAudioPlayer(),
      queue: [],
      playing: false,
      generation: 0
    });

    await expect(service.speak('guild-1', '안녕', 'user-1')).resolves.toBe(false);
    expect(tts.synthesize).toHaveBeenCalled();
    expect(service.getLastError('guild-1')).toContain('boom');
    expect(tts.cleanup).not.toHaveBeenCalled();
  });

  it('falls back to gTTS when edge synthesis fails', async () => {
    const tts = {
      synthesize: vi.fn(async (_text: string, _voice: string | undefined, engine: string) => {
        if (engine === 'edge') throw new Error('edge failed');
        return '/tmp/fallback.mp3';
      }),
      cleanup: vi.fn(async () => undefined)
    } as unknown as TtsService;
    const store = new InMemoryVoiceSettingsStore();
    const service = new VoiceService(tts, store, { sunhi: 'ko-KR-SunHiNeural' }, 'edge', 1_000);
    const player = createAudioPlayer();
    vi.spyOn(player, 'play').mockImplementation(() => undefined as any);
    (service as any).states.set('guild-1', {
      connection: { destroy: vi.fn() },
      player,
      queue: [],
      playing: false,
      generation: 0
    });

    const promise = service.speak('guild-1', '안녕', 'user-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.stop();

    await expect(promise).resolves.toBe(true);
    expect(tts.synthesize).toHaveBeenNthCalledWith(1, '안녕', undefined, 'edge');
    expect(tts.synthesize).toHaveBeenNthCalledWith(2, '안녕', undefined, 'gtts');
    expect(tts.cleanup).toHaveBeenCalledWith('/tmp/fallback.mp3');
  });

  it('auto-leaves after being idle for the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const tts = {
        synthesize: vi.fn(async () => {
          throw new Error('boom');
        }),
        cleanup: vi.fn(async () => undefined)
      } as unknown as TtsService;
      const store = new InMemoryVoiceSettingsStore();
      const service = new VoiceService(tts, store, { sunhi: 'ko-KR-SunHiNeural' }, 'edge', 1_000);
      const leave = vi.fn();
      (service as any).leave = leave;
      (service as any).states.set('guild-1', {
        connection: { destroy: vi.fn() },
        player: createAudioPlayer(),
        queue: [],
        playing: false,
        generation: 0
      });

      await service.speak('guild-1', '안녕', 'user-1');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(leave).toHaveBeenCalledWith('guild-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
