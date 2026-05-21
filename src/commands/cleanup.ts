import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';
import type { SlashCommand } from '../types.js';
import {
  DEFAULT_CLEANUP_MAX_TARGET,
  DEFAULT_OWN_CLEANUP_TARGET,
  DEFAULT_PURGE_TARGET,
  cleanupChannelMessages,
  cleanupUserMessages,
  formatCleanupResult,
  hasManageMessages,
  mineMessageFilter,
  type CleanupFetchableChannel
} from '../services/cleanupService.js';

export { mineMessageFilter };

async function ensureGuildText(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('서버 텍스트 채널에서만 사용할 수 있어요.');
  }
  return channel;
}

export const cleanupCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder()
      .setName('clean-mine')
      .setDescription('내가 쓴 최근 메시지를 삭제합니다.')
      .addIntegerOption((option) =>
        option
          .setName('amount')
          .setDescription(`삭제할 내 메시지 수 (기본 ${DEFAULT_OWN_CLEANUP_TARGET})`)
          .setMinValue(1)
          .setMaxValue(DEFAULT_CLEANUP_MAX_TARGET)
          .setRequired(false)
      ),
    async execute(interaction, context) {
      const channel = await ensureGuildText(interaction);
      const amount = interaction.options.getInteger('amount', false);
      await interaction.deferReply({ ephemeral: true });

      const result = await cleanupUserMessages(channel as CleanupFetchableChannel, interaction.user.id, {
        target: amount,
        defaultTarget: context.settings.cleanMineDefaultTarget,
        maxTarget: context.settings.cleanMineMaxLimit
      });
      await interaction.editReply(formatCleanupResult('내 메시지', result));
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('clean-all')
      .setDescription('관리자용: 최근 채팅을 한 번에 삭제합니다.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((option) =>
        option
          .setName('amount')
          .setDescription(`삭제할 메시지 수 (기본 ${DEFAULT_PURGE_TARGET})`)
          .setMinValue(1)
          .setMaxValue(DEFAULT_CLEANUP_MAX_TARGET)
          .setRequired(false)
      ),
    async execute(interaction, context) {
      const channel = await ensureGuildText(interaction);
      if (!hasManageMessages(interaction.memberPermissions)) {
        throw new Error('Manage Messages 권한이 필요해요.');
      }
      const amount = interaction.options.getInteger('amount', false);
      await interaction.deferReply({ ephemeral: true });

      const result = await cleanupChannelMessages(channel as CleanupFetchableChannel, {
        target: amount,
        defaultTarget: context.settings.cleanAllDefaultTarget,
        maxTarget: context.settings.cleanAllMaxLimit
      });
      await interaction.editReply(formatCleanupResult('최근 메시지', result));
    }
  }
];
