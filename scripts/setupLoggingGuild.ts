import { Events } from 'discord.js';
import { assertRuntimeSettings, loadSettings } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { logger } from '../src/logger.js';

const settings = loadSettings();
assertRuntimeSettings(settings);

const { client, context } = await createBot(settings, { bootstrapLogging: false });

client.once(Events.ClientReady, async () => {
  try {
    logger.info(`Resetting logging guild ${settings.loggingGuildId}`);
    await context.activityLog.resetLoggingGuildLayout();
    logger.info('Logging guild reset complete');
  } catch (error) {
    logger.error('Logging guild reset failed:', error);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

await client.login(settings.discordToken);
