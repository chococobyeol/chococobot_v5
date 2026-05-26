export const TAROT_CARD_COUNT = 78;
export const TAROT_ASSET_ROOT = 'assets/tarot';

export type TarotArcana = 'major' | 'cups' | 'pentacles' | 'swords' | 'wands';
export type TarotOrientation = 'upright' | 'reversed';

export type TarotCard = {
  id: string;
  arcana: TarotArcana;
  nameKo: string;
  nameEn: string;
  assetPath: string;
  reversedAssetPath?: string;
  keywords: readonly string[];
  energy: { flow: number; emotion: number; action: number };
};

export type TarotDrawnCard = {
  selectionNumber: number;
  card: TarotCard;
  orientation: TarotOrientation;
  assetPath: string;
  attachmentName: string;
};

export type TarotSelectionValidation =
  | { ok: true; numbers: number[] }
  | { ok: false; code: 'numbers_required' | 'duplicate_numbers' | 'number_out_of_range' | 'wrong_count'; field: 'numbers'; message: string; hint: string };

type CardSeed = Omit<TarotCard, 'assetPath' | 'reversedAssetPath' | 'energy'> & { file: string; flow?: number; emotion?: number; action?: number };

const MAJOR: readonly CardSeed[] = [
  { id: 'major-00', arcana: 'major', nameKo: '바보', nameEn: 'The Fool', file: 'tarot_fool.png', keywords: ['시작', '가능성', '자유'], flow: 4, emotion: 4, action: 5 },
  { id: 'major-01', arcana: 'major', nameKo: '마법사', nameEn: 'The Magician', file: 'tarot_magician.png', keywords: ['의지', '실행', '집중'], flow: 4, emotion: 3, action: 5 },
  { id: 'major-02', arcana: 'major', nameKo: '여사제', nameEn: 'The High Priestess', file: 'tarot_high_priestess.png', keywords: ['직감', '비밀', '관찰'], flow: 3, emotion: 5, action: 2 },
  { id: 'major-03', arcana: 'major', nameKo: '여황제', nameEn: 'The Empress', file: 'tarot_empress.png', keywords: ['풍요', '돌봄', '성장'], flow: 5, emotion: 5, action: 3 },
  { id: 'major-04', arcana: 'major', nameKo: '황제', nameEn: 'The Emperor', file: 'tarot_emperor.png', keywords: ['질서', '책임', '기반'], flow: 3, emotion: 2, action: 5 },
  { id: 'major-05', arcana: 'major', nameKo: '교황', nameEn: 'The Hierophant', file: 'tarot_hierophant.png', keywords: ['전통', '조언', '신뢰'], flow: 3, emotion: 3, action: 3 },
  { id: 'major-06', arcana: 'major', nameKo: '연인', nameEn: 'The Lovers', file: 'tarot_lovers.png', keywords: ['선택', '관계', '조화'], flow: 4, emotion: 5, action: 3 },
  { id: 'major-07', arcana: 'major', nameKo: '전차', nameEn: 'The Chariot', file: 'tarot_chariot.png', keywords: ['전진', '승부', '통제'], flow: 4, emotion: 2, action: 5 },
  { id: 'major-08', arcana: 'major', nameKo: '힘', nameEn: 'Strength', file: 'tarot_strength.png', keywords: ['용기', '인내', '다정함'], flow: 4, emotion: 4, action: 4 },
  { id: 'major-09', arcana: 'major', nameKo: '은둔자', nameEn: 'The Hermit', file: 'tarot_hermit.png', keywords: ['성찰', '탐색', '거리두기'], flow: 2, emotion: 3, action: 2 },
  { id: 'major-10', arcana: 'major', nameKo: '운명의 수레바퀴', nameEn: 'Wheel of Fortune', file: 'tarot_wheel_of_fortune.png', keywords: ['전환', '타이밍', '기회'], flow: 5, emotion: 3, action: 4 },
  { id: 'major-11', arcana: 'major', nameKo: '정의', nameEn: 'Justice', file: 'tarot_justice.png', keywords: ['균형', '판단', '책임'], flow: 3, emotion: 2, action: 4 },
  { id: 'major-12', arcana: 'major', nameKo: '매달린 사람', nameEn: 'The Hanged Man', file: 'tarot_hanged_man.png', keywords: ['멈춤', '관점전환', '양보'], flow: 2, emotion: 3, action: 1 },
  { id: 'major-13', arcana: 'major', nameKo: '죽음', nameEn: 'Death', file: 'tarot_death.png', keywords: ['종료', '변화', '정리'], flow: 4, emotion: 2, action: 4 },
  { id: 'major-14', arcana: 'major', nameKo: '절제', nameEn: 'Temperance', file: 'tarot_temperance.png', keywords: ['조율', '회복', '중용'], flow: 4, emotion: 4, action: 3 },
  { id: 'major-15', arcana: 'major', nameKo: '악마', nameEn: 'The Devil', file: 'tarot_devil.png', keywords: ['집착', '유혹', '패턴'], flow: 2, emotion: 2, action: 3 },
  { id: 'major-16', arcana: 'major', nameKo: '탑', nameEn: 'The Tower', file: 'tarot_tower.png', keywords: ['충격', '해체', '진실'], flow: 1, emotion: 1, action: 4 },
  { id: 'major-17', arcana: 'major', nameKo: '별', nameEn: 'The Star', file: 'tarot_star.png', keywords: ['희망', '치유', '영감'], flow: 5, emotion: 5, action: 2 },
  { id: 'major-18', arcana: 'major', nameKo: '달', nameEn: 'The Moon', file: 'tarot_moon.png', keywords: ['불안', '상상', '모호함'], flow: 2, emotion: 5, action: 1 },
  { id: 'major-19', arcana: 'major', nameKo: '태양', nameEn: 'The Sun', file: 'tarot_sun.png', keywords: ['활력', '확신', '성공'], flow: 5, emotion: 5, action: 5 },
  { id: 'major-20', arcana: 'major', nameKo: '심판', nameEn: 'Judgement', file: 'tarot_judgement.png', keywords: ['각성', '결정', '부름'], flow: 4, emotion: 3, action: 4 },
  { id: 'major-21', arcana: 'major', nameKo: '세계', nameEn: 'The World', file: 'tarot_world.png', keywords: ['완성', '확장', '통합'], flow: 5, emotion: 4, action: 4 }
];

function suitCards(arcana: Exclude<TarotArcana, 'major'>, koSuit: string, enSuit: string, fileSuit: string): readonly CardSeed[] {
  const ranks = [
    ['1', '에이스', 'Ace', ['시작', '씨앗']], ['2', '2', 'Two', ['균형', '선택']], ['3', '3', 'Three', ['확장', '협력']],
    ['4', '4', 'Four', ['안정', '멈춤']], ['5', '5', 'Five', ['갈등', '변화']], ['6', '6', 'Six', ['회복', '교류']],
    ['7', '7', 'Seven', ['평가', '도전']], ['8', '8', 'Eight', ['속도', '몰입']], ['9', '9', 'Nine', ['결실', '개인']],
    ['10', '10', 'Ten', ['완성', '부담']], ['page', '시종', 'Page', ['소식', '배움']], ['knight', '기사', 'Knight', ['추진', '이동']],
    ['queen', '여왕', 'Queen', ['성숙', '돌봄']], ['king', '왕', 'King', ['통솔', '결정']]
  ] as const;
  return ranks.map(([fileRank, koRank, enRank, keywords], index) => ({
    id: `${arcana}-${String(index + 1).padStart(2, '0')}`,
    arcana,
    nameKo: `${koSuit} ${koRank}`,
    nameEn: `${enRank} of ${enSuit}`,
    file: `tarot_${fileSuit}_${fileRank}.png`,
    keywords,
    flow: Math.max(1, Math.min(5, ((index + 2) % 5) + 1)),
    emotion: arcana === 'cups' ? 5 : arcana === 'swords' ? 2 : 3,
    action: arcana === 'wands' ? 5 : arcana === 'pentacles' ? 4 : 3
  }));
}

export const TAROT_DECK: readonly TarotCard[] = [
  ...MAJOR,
  ...suitCards('cups', '컵', 'Cups', 'cups'),
  ...suitCards('pentacles', '펜타클', 'Pentacles', 'pentacles'),
  ...suitCards('swords', '소드', 'Swords', 'swords'),
  ...suitCards('wands', '완드', 'Wands', 'wands')
].map((seed) => ({
  id: seed.id,
  arcana: seed.arcana,
  nameKo: seed.nameKo,
  nameEn: seed.nameEn,
  assetPath: `${TAROT_ASSET_ROOT}/${seed.file}`,
  reversedAssetPath: `${TAROT_ASSET_ROOT}/reverse/${seed.file.replace(/\.png$/, '_r.png')}`,
  keywords: seed.keywords,
  energy: { flow: seed.flow ?? 3, emotion: seed.emotion ?? 3, action: seed.action ?? 3 }
}));

if (TAROT_DECK.length !== TAROT_CARD_COUNT) {
  throw new Error(`Tarot deck metadata must contain ${TAROT_CARD_COUNT} cards; found ${TAROT_DECK.length}`);
}

export function createTarotDeckOrder(seedSource = `${Date.now()}:${Math.random()}`): number[] {
  const order = Array.from({ length: TAROT_CARD_COUNT }, (_value, index) => index);
  const random = seededRandom(hashSeed(seedSource));
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  return order;
}

export function validateTarotSelectionNumbers(numbers: unknown, expectedCount: number): TarotSelectionValidation {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return { ok: false, code: 'numbers_required', field: 'numbers', message: `${expectedCount}개 숫자를 골라주세요.`, hint: 'Ask the user to pick numbered cards from 1 to 78.' };
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 5) {
    return { ok: false, code: 'wrong_count', field: 'numbers', message: '카드 개수는 1~5장만 지원해요.', hint: 'Use the active tarot session spreadCount.' };
  }
  const normalized = numbers.map((number) => typeof number === 'number' ? number : Number.NaN);
  if (normalized.some((number) => !Number.isInteger(number) || number < 1 || number > TAROT_CARD_COUNT)) {
    return { ok: false, code: 'number_out_of_range', field: 'numbers', message: '1~78 사이에서 골라주세요.', hint: 'Retry with only integer card numbers from 1 to 78.' };
  }
  if (normalized.length !== expectedCount) {
    return {
      ok: false,
      code: 'wrong_count',
      field: 'numbers',
      message: '선택한 카드 번호 개수가 요청과 다릅니다.',
      hint: expectedCount === 1
        ? `Expected 1 card number; received ${normalized.length}.`
        : `Expected ${expectedCount} unique card numbers; received ${normalized.length}.`
    };
  }
  if (new Set(normalized).size !== normalized.length) {
    return { ok: false, code: 'duplicate_numbers', field: 'numbers', message: '중복된 숫자는 선택할 수 없어요. 서로 다른 번호를 골라주세요.', hint: 'Retry with unique card numbers.' };
  }
  return { ok: true, numbers: normalized };
}

export function drawTarotCardsFromNumbers(numbers: readonly number[], deckOrder: readonly number[]): TarotDrawnCard[] {
  return numbers.map((selectionNumber) => {
    const deckIndex = deckOrder[selectionNumber - 1];
    if (deckIndex === undefined) throw new Error(`Invalid tarot selection number: ${selectionNumber}`);
    const card = TAROT_DECK[deckIndex];
    if (!card) throw new Error(`Invalid tarot deck index: ${deckIndex}`);
    const orientation = orientationFor(selectionNumber, deckIndex);
    const assetPath = orientation === 'reversed' && card.reversedAssetPath ? card.reversedAssetPath : card.assetPath;
    return {
      selectionNumber,
      card,
      orientation,
      assetPath,
      attachmentName: `tarot-${selectionNumber}-${assetPath.split('/').pop() ?? card.id}.png`.replace(/\.png\.png$/, '.png')
    };
  });
}

export function formatTarotEnergyBars(cards: readonly TarotDrawnCard[]): string {
  const scores = cards.reduce((acc, item) => {
    const direction = item.orientation === 'reversed' ? 0.75 : 1;
    acc.flow += item.card.energy.flow * direction;
    acc.emotion += item.card.energy.emotion * direction;
    acc.action += item.card.energy.action * direction;
    return acc;
  }, { flow: 0, emotion: 0, action: 0 });
  const count = Math.max(1, cards.length);
  return [
    `흐름 ${bar(scores.flow / count)}`,
    `감정 ${bar(scores.emotion / count)}`,
    `행동 ${bar(scores.action / count)}`
  ].join('\n');
}

function bar(score: number): string {
  const filled = Math.max(1, Math.min(5, Math.round(score)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)} ${filled}/5`;
}

function orientationFor(selectionNumber: number, deckIndex: number): TarotOrientation {
  return (selectionNumber + deckIndex) % 4 === 0 ? 'reversed' : 'upright';
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
