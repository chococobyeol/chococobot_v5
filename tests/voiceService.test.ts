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
    const service = new VoiceService(tts, store, { sunhi: 'ko-KR-SunHiNeural' }, 'edge');

    (service as any).states.set('guild-1', {
      connection: { destroy: vi.fn() },
      player: createAudioPlayer(),
      queue: [],
      playing: false
    });

    await expect(service.speak('guild-1', '안녕', 'user-1')).resolves.toBe(false);
    expect(tts.synthesize).toHaveBeenCalled();
    expect(tts.cleanup).not.toHaveBeenCalled();
  });
});
