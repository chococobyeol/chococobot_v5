import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types.js';
import { AiLimitError } from '../services/aiService.js';

export const aiCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder()
      .setName('ai')
      .setDescription('Groq AI와 대화합니다.')
      .addStringOption((option) =>
        option.setName('prompt').setDescription('질문 또는 요청').setMaxLength(1800).setRequired(true)
      ),
    async execute(interaction, context) {
      if (!interaction.guildId) throw new Error('서버에서만 사용할 수 있어요.');
      await interaction.deferReply();
      try {
        const answer = await context.ai.ask({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          prompt: interaction.options.getString('prompt', true)
        });
        await interaction.editReply(answer.slice(0, 1900));
      } catch (error) {
        if (error instanceof AiLimitError) await interaction.editReply(error.message);
        else throw error;
      }
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('ai-usage')
      .setDescription('Groq AI 사용량을 확인합니다.')
      .addIntegerOption((option) => option.setName('days').setDescription('조회 일수').setMinValue(1).setMaxValue(30))
      .addUserOption((option) => option.setName('user').setDescription('관리자용: 특정 유저 조회')),
    async execute(interaction, context) {
      if (!interaction.guildId) throw new Error('서버에서만 사용할 수 있어요.');
      const days = interaction.options.getInteger('days') ?? 1;
      const requestedUser = interaction.options.getUser('user');
      const canQueryOthers = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
      if (requestedUser && !canQueryOthers) throw new Error('다른 유저 사용량 조회에는 Manage Server 권한이 필요해요.');
      const user = requestedUser ?? interaction.user;
      const usage = context.usageStore.summarizeUser(interaction.guildId, user.id, days);
      await interaction.reply({
        ephemeral: true,
        content: [
          `대상: ${user.tag}`,
          `기간: 최근 ${days}일`,
          `요청 수: ${usage.requests}`,
          `프롬프트 토큰: ${usage.promptTokens}`,
          `완성 토큰: ${usage.completionTokens}`,
          `총 토큰: ${usage.totalTokens}`
        ].join('\n')
      });
    }
  }
];
