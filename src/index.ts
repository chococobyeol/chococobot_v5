import { assertRuntimeSettings, loadSettings } from './config.js';
import { createBot } from './bot.js';
import { diagnoseVoiceStack } from './services/voiceDiagnostics.js';
import { logger } from './logger.js';

const settings = loadSettings();
assertRuntimeSettings(settings);

const voiceDiagnostic = await diagnoseVoiceStack();
logger.info(voiceDiagnostic.report);
if (!voiceDiagnostic.ok) {
  for (const problem of voiceDiagnostic.problems) logger.warn(problem);
}

const { client } = await createBot(settings);
await client.login(settings.discordToken);
