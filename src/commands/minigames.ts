import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types.js';

export function drawChoices(raw: string, count: number): string[] {
  const choices = raw
    .split(',')
    .map((choice) => choice.trim())
    .filter(Boolean);
  if (!choices.length) throw new Error('쉼표로 구분된 선택지를 입력해 주세요...');
  if (count > choices.length) throw new Error('뽑을 개수가 선택지 개수보다 많아요.');
  return choices.sort(() => Math.random() - 0.5).slice(0, count);
}

export const miniGameCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder()
      .setName('draw')
      .setDescription('쉼표로 구분한 선택지 중 랜덤으로 뽑습니다.')
      .addStringOption((option) => option.setName('choices').setDescription('예: 사과, 바나나, 초코').setRequired(true))
      .addIntegerOption((option) => option.setName('count').setDescription('뽑을 개수').setMinValue(1).setMaxValue(20)),
    async execute(interaction) {
      const choices = interaction.options.getString('choices', true);
      const count = interaction.options.getInteger('count') ?? 1;
      const drawn = drawChoices(choices, count);
      await interaction.reply(`🎲 결과: ${drawn.join(', ')}`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('dice')
      .setDescription('주사위를 굴립니다.')
      .addIntegerOption((option) => option.setName('sides').setDescription('면 수').setMinValue(2).setMaxValue(1000))
      .addIntegerOption((option) => option.setName('count').setDescription('개수').setMinValue(1).setMaxValue(20)),
    async execute(interaction) {
      const sides = interaction.options.getInteger('sides') ?? 6;
      const count = interaction.options.getInteger('count') ?? 1;
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      await interaction.reply(`🎲 d${sides} x${count}: ${rolls.join(', ')} (합계 ${rolls.reduce((a, b) => a + b, 0)})`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('coin').setDescription('동전을 던집니다.'),
    async execute(interaction) {
      await interaction.reply(Math.random() < 0.5 ? '🪙 앞면!' : '🪙 뒷면!');
    }
  }
];
