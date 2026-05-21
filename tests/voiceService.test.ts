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
    expect(tts.cleanup).not.toHaveBeenCalled();
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
