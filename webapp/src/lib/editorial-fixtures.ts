// ───────────────────────────────────────────────────────────────────────────
// Editorial Room — fixture data (personas, agent profiles, scoring pipelines).
//
// At v0p these are static tables that mirror what the rocketorchestra
// `personas`, agent-profile, and scoring-pipeline libraries will return when
// wired up. The shapes match the design intent in:
//   - docs/design/01_setup.md §5–9
//   - docs/EDITORIAL_ROOM_CONTRACT.md §2
//
// When the real backend lands, these consts get replaced with API loads;
// consumers (EditorialSetupPage, panel chat, scoring tables) keep the same
// shape.
// ───────────────────────────────────────────────────────────────────────────

export type PersonaColor =
  | 'green'
  | 'red'
  | 'blue'
  | 'gold'
  | 'purple'
  | 'teal';

export type Persona = {
  slug: string;
  name: string;
  monogram: string;
  color: PersonaColor;
  occupation: string;
  cohortTag: string;
  location: string;
  voiceQuote: string;
  lastEditDays: number;
  suggested?: 'yellow' | 'red';
};

// Persona library matching the GameMakers working example. A / R / M
// colors carry through into Draft panel chat avatars.
export const FIXTURE_PERSONAS: ReadonlyArray<Persona> = [
  {
    slug: 'persona/ankit-sharma',
    name: 'Ankit Sharma',
    monogram: 'A',
    color: 'green',
    occupation: 'indie dev · solo',
    cohortTag: 'indie_dev_economics',
    location: 'Bangalore',
    voiceQuote: "If you can't show me the MG schedule, I won't sign.",
    lastEditDays: 3,
  },
  {
    slug: 'persona/ravi-mehra',
    name: 'Ravi Mehra',
    monogram: 'R',
    color: 'red',
    occupation: 'studio lead · 14 ppl',
    cohortTag: 'studio_operator',
    location: 'Mumbai',
    voiceQuote: 'Cash flow first. The rest is theology.',
    lastEditDays: 3,
  },
  {
    slug: 'persona/mei-tanaka',
    name: 'Mei Tanaka',
    monogram: 'M',
    color: 'blue',
    occupation: 'publisher BD',
    cohortTag: 'publisher_bd',
    location: 'Tokyo',
    voiceQuote: "If you can't define recoupment, you don't have a deal.",
    lastEditDays: 3,
    suggested: 'yellow',
  },
  {
    slug: 'persona/sarah-chen',
    name: 'Sarah Chen',
    monogram: 'S',
    color: 'gold',
    occupation: 'solo journalist · ex-PCG',
    cohortTag: 'trade_press',
    location: 'San Francisco',
    voiceQuote: "I don't quote unless you name a source.",
    lastEditDays: 3,
  },
  {
    slug: 'persona/diego-rivera',
    name: 'Diego Rivera',
    monogram: 'D',
    color: 'purple',
    occupation: 'QA lead · 4-yr ten.',
    cohortTag: 'studio_ops',
    location: 'Mexico City',
    voiceQuote: 'I want to know what shipped vs what was promised.',
    lastEditDays: 3,
  },
  {
    slug: 'persona/yuki-watanabe',
    name: 'Yuki Watanabe',
    monogram: 'Y',
    color: 'teal',
    occupation: 'platform program lead',
    cohortTag: 'platform_relations',
    location: 'Tokyo',
    voiceQuote: "We don't comment, but we read everything.",
    lastEditDays: 5,
  },
  {
    slug: 'persona/priya-iyer',
    name: 'Priya Iyer',
    monogram: 'P',
    color: 'red',
    occupation: 'investor · seed/A',
    cohortTag: 'venture_lp',
    location: 'Singapore',
    voiceQuote: 'Tell me which deals would close today.',
    lastEditDays: 5,
  },
  {
    slug: 'persona/jonas-petersen',
    name: 'Jonas Petersen',
    monogram: 'J',
    color: 'blue',
    occupation: 'co-op studio rep',
    cohortTag: 'cooperative_studios',
    location: 'Copenhagen',
    voiceQuote: 'Bands of 5–10 are the only sustainable shape.',
    lastEditDays: 5,
  },
];

export function getPersonaBySlug(slug: string): Persona | null {
  return FIXTURE_PERSONAS.find((p) => p.slug === slug) ?? null;
}

// ─── LLM Room agent profile library ─────────────────────────────────────────
// Agent profiles are the AI critics on the panel — not anonymous chips per
// design §11 anti-pattern. Each is named, has a surface model + provider,
// a stance, and a per-turn cost so the user always sees what they're paying
// for and how the agent will critique.

export type AgentProfile = {
  id: string;
  name: string;
  role: string;
  monogram: string;
  color: PersonaColor;
  model: string;
  provider: string;
  stance: string;
  costPerTurnUsd: number;
  suggested?: boolean;
};

export const FIXTURE_AGENT_PROFILES: ReadonlyArray<AgentProfile> = [
  {
    id: 'agent/argus',
    name: 'Argus',
    role: 'argument critic',
    monogram: 'A',
    color: 'green',
    model: 'CLAUDE-OPUS-4',
    provider: 'ANTHROPIC',
    stance: 'hostile to weak claims · steelmans counters',
    costPerTurnUsd: 0.04,
  },
  {
    id: 'agent/marisol',
    name: 'Marisol',
    role: 'narrative shaper',
    monogram: 'M',
    color: 'blue',
    model: 'GPT-5',
    provider: 'OPENAI',
    stance: 'tightens prose · won’t soften claims',
    costPerTurnUsd: 0.03,
  },
  {
    id: 'agent/kenji',
    name: 'Kenji',
    role: 'source auditor',
    monogram: 'K',
    color: 'red',
    model: 'GEMINI-2-PRO',
    provider: 'GOOGLE',
    stance: 'verifies citations · flags missing primary sources',
    costPerTurnUsd: 0.02,
  },
  {
    id: 'agent/voice-critic',
    name: 'Voice Critic',
    role: 'voice consistency',
    monogram: 'V',
    color: 'gold',
    model: 'CLAUDE-OPUS-4',
    provider: 'ANTHROPIC',
    stance: 'enforces voice page rules · catches drift',
    costPerTurnUsd: 0.04,
    suggested: true,
  },
  {
    id: 'agent/ada',
    name: 'Ada',
    role: 'structure scout',
    monogram: 'D',
    color: 'purple',
    model: 'CLAUDE-SONNET-4',
    provider: 'ANTHROPIC',
    stance: 'evaluates section flow + length',
    costPerTurnUsd: 0.02,
  },
  {
    id: 'agent/counter',
    name: 'Counter',
    role: 'adversarial reader',
    monogram: 'C',
    color: 'teal',
    model: 'GPT-5',
    provider: 'OPENAI',
    stance: 'argues the opposite case · finds blind spots',
    costPerTurnUsd: 0.04,
  },
];

export function getAgentProfileById(id: string): AgentProfile | null {
  return FIXTURE_AGENT_PROFILES.find((a) => a.id === id) ?? null;
}
