/** Narrative motivation, never coordinates; travel only. */
export const SHOT_INTENTS = ['continue', 'exchange', 'emphasis', 'reaction', 'reveal', 'release', 'rupture'] as const;
export type ShotIntent = (typeof SHOT_INTENTS)[number];

export const SHOT_INTENT_LABEL: Record<ShotIntent, string> = {
  continue: '延续', exchange: '交接注意', emphasis: '强调', reaction: '反应', reveal: '揭示', release: '舒缓 / 交代关系', rupture: '断裂',
};
