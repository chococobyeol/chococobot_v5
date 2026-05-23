import { assertRuntimeSettings, loadSettings, type Settings } from './config.js';
import { createBot } from './bot.js';
import { diagnoseVoiceStack } from './services/voiceDiagnostics.js';
import { logger } from './logger.js';

const settings = loadSettings();
const smokeMode = process.env.SMOKE_MODE === '1';
assertRuntimeSettings(settings, { requireDiscordToken: !smokeMode });

if (smokeMode) {
  await runSmokeMode(settings);
} else {
  const voiceDiagnostic = await diagnoseVoiceStack();
  logger.info(voiceDiagnostic.report);
  if (!voiceDiagnostic.ok) {
    for (const problem of voiceDiagnostic.problems) logger.warn(problem);
  }

  const { client } = await createBot(settings);
  await client.login(settings.discordToken);
}

async function runSmokeMode(settings: Settings): Promise<void> {
  logger.info('SMOKE_MODE=1: validating startup configuration without Discord login.');
  if (settings.webSearchEnabled) {
    if (!settings.webSearchBaseUrl) {
      throw new Error('SMOKE_MODE requires WEB_SEARCH_BASE_URL when WEB_SEARCH_ENABLED=true');
    }
    await waitForSearxng(settings.webSearchBaseUrl, settings.webSearchTimeoutMs);
  }
  logger.info('SMOKE_MODE=1: startup configuration and local SearXNG probe passed.');
}

async function waitForSearxng(baseUrl: string, timeoutMs: number): Promise<void> {
  const probeUrl = new URL('/search', `${baseUrl.replace(/\/+$/, '')}/`);
  probeUrl.searchParams.set('q', 'chococobot smoke');
  probeUrl.searchParams.set('format', 'json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(probeUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`SearXNG smoke probe returned HTTP ${response.status}`);
    }
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results)) {
      throw new Error('SearXNG smoke probe did not return a JSON results array');
    }
  } finally {
    clearTimeout(timeout);
  }
}
