import type { ChatInputCommandInteraction, Message, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { BotContext } from './bot.js';

export type CommandData = {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
};

export type SlashCommand = {
  data: CommandData;
  execute(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void>;
};

export type PrefixCommand = {
  name: string;
  aliases: string[];
  description: string;
  execute(message: Message, args: string[], context: BotContext): Promise<void>;
};
