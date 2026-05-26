import type { Message } from 'discord.js';
import type { BotContext } from './bot.js';

export type PrefixCommand = {
  name: string;
  aliases: string[];
  description: string;
  aiVisible?: boolean;
  execute(message: Message, args: string[], context: BotContext): Promise<void>;
};
