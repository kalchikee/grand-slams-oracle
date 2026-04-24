import { DrawEntry, Gender, BracketSimResult } from '../types';
export type { BracketSimResult };
import { quickMatchProb } from '../pipeline/predict';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SIMS = 10_000;

// ─── Bracket Structure ────────────────────────────────────────────────────────

type BracketSlot = DrawEntry | null;

/** Group 128-player draw into rounds. Draw positions 1-128 seeded by ATP/WTA convention. */
function buildFirstRound(draw: DrawEntry[]): [BracketSlot, BracketSlot][] {
  // Sort by draw position
  const sorted = [...draw].sort((a, b) => a.drawPosition - b.drawPosition);
  const pairs: [BracketSlot, BracketSlot][] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    pairs.push([sorted[i] ?? null, sorted[i + 1] ?? null]);
  }
  return pairs;
}

/** Play a single bracket round, returning winners. */
function playRound(
  players: (DrawEntry | null)[],
  surface: string,
  gender: Gender,
  rng: () => number
): (DrawEntry | null)[] {
  const winners: (DrawEntry | null)[] = [];
  for (let i = 0; i < players.length; i += 2) {
    const a = players[i];
    const b = players[i + 1];

    if (!a && !b) { winners.push(null); continue; }
    if (!a) { winners.push(b); continue; }
    if (!b) { winners.push(a); continue; }

    const pA = quickMatchProb(a.playerId, b.playerId, surface, gender);
    winners.push(rng() < pA ? a : b);
  }
  return winners;
}

/** Run one full tournament simulation. Returns the finishing round for each player. */
function simulateTournament(
  draw: DrawEntry[],
  surface: string,
  gender: Gender,
  rng: () => number
): Map<string, number> {
  // roundReached: 1=R1 exit, 2=R2, ..., 7=Champion
  const roundReached = new Map<string, number>();
  draw.forEach(p => roundReached.set(p.playerId, 1));

  let alive = [...draw].sort((a, b) => a.drawPosition - b.drawPosition);

  let round = 1;
  while (alive.length > 1) {
    const nextAlive: DrawEntry[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i];
      const b = alive[i + 1];

      if (!b) { nextAlive.push(a); continue; }

      const pA = quickMatchProb(a.playerId, b.playerId, surface, gender);
      const winner = rng() < pA ? a : b;
      const loser  = winner === a ? b : a;

      nextAlive.push(winner);
      // Loser exits at this round
      roundReached.set(loser.playerId, round + 1); // reached round (survived to this point)
    }
    round++;
    alive = nextAlive;
    // Mark remaining as reaching the next round
    alive.forEach(p => roundReached.set(p.playerId, round + 1));
  }

  // Champion
  if (alive[0]) roundReached.set(alive[0].playerId, 8); // 8 = Champion

  return roundReached;
}

// ─── Round Number Mapping ─────────────────────────────────────────────────────

const ROUND_THRESHOLDS = {
  r16:   4, // survived to round 4 = reached R16
  qf:    5, // survived to round 5 = reached QF
  sf:    6, // survived to round 6 = reached SF
  final: 7, // survived to round 7 = reached Final
  champ: 8, // survived to round 8 = Champion
};

// ─── Main Simulation ──────────────────────────────────────────────────────────

export interface SimulationOptions {
  numSims?: number;
  surface: string;
  gender: Gender;
  seed?: number; // for reproducible results
}

export function simulateBracket(
  draw: DrawEntry[],
  opts: SimulationOptions
): BracketSimResult[] {
  const numSims = opts.numSims ?? DEFAULT_SIMS;

  // Counters
  const counters = new Map<string, {
    r16: number; qf: number; sf: number; final: number; champ: number;
  }>();
  draw.forEach(p => counters.set(p.playerId, { r16: 0, qf: 0, sf: 0, final: 0, champ: 0 }));

  // Simple seeded RNG (Mulberry32)
  let rngState = opts.seed ?? Date.now();
  const rng = (): number => {
    rngState |= 0;
    rngState = rngState + 0x6D2B79F5 | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let sim = 0; sim < numSims; sim++) {
    const results = simulateTournament(draw, opts.surface, opts.gender, rng);

    for (const [pid, round] of results) {
      const c = counters.get(pid);
      if (!c) continue;
      if (round >= ROUND_THRESHOLDS.r16)   c.r16++;
      if (round >= ROUND_THRESHOLDS.qf)    c.qf++;
      if (round >= ROUND_THRESHOLDS.sf)    c.sf++;
      if (round >= ROUND_THRESHOLDS.final) c.final++;
      if (round >= ROUND_THRESHOLDS.champ) c.champ++;
    }
  }

  // Build results
  const results: BracketSimResult[] = draw.map(entry => {
    const c = counters.get(entry.playerId) ?? { r16: 0, qf: 0, sf: 0, final: 0, champ: 0 };
    return {
      playerId: entry.playerId,
      playerName: entry.playerName,
      seed: entry.seed,
      championProb:      c.champ / numSims,
      finalistProb:      c.final / numSims,
      semifinalistProb:  c.sf    / numSims,
      quarterfinalistProb: c.qf  / numSims,
      r16Prob:           c.r16   / numSims,
      quarter: drawPositionToQuarter(entry.drawPosition),
    };
  });

  return results.sort((a, b) => b.championProb - a.championProb);
}

function drawPositionToQuarter(pos: number): 1 | 2 | 3 | 4 {
  if (pos <= 32) return 1;
  if (pos <= 64) return 2;
  if (pos <= 96) return 3;
  return 4;
}

// ─── Dark Horse Detection ────────────────────────────────────────────────────

export interface DarkHorse {
  playerName: string;
  seed: number | null;
  qfProb: number;
  reason: string;
}

export function findDarkHorses(results: BracketSimResult[], threshold = 0.20): DarkHorse[] {
  return results
    .filter(r => r.seed !== null && r.seed > 8 && r.quarterfinalistProb >= threshold)
    .slice(0, 3)
    .map(r => ({
      playerName: r.playerName,
      seed: r.seed,
      qfProb: r.quarterfinalistProb,
      reason: `Seed #${r.seed} with ${(r.quarterfinalistProb * 100).toFixed(0)}% QF probability`,
    }));
}

// ─── Bracket Difficulty Analysis ─────────────────────────────────────────────

export interface QuarterAnalysis {
  quarter: 1 | 2 | 3 | 4;
  topSeeds: string[];
  avgChampProb: number;
  label: 'Death Quarter' | 'Strong' | 'Open' | 'Wide Open';
}

export function analyzeQuarters(results: BracketSimResult[]): QuarterAnalysis[] {
  const quarters = [1, 2, 3, 4] as const;
  return quarters.map(q => {
    const players = results.filter(r => r.quarter === q);
    const top = players.slice(0, 3);
    const avgChamp = top.reduce((s, r) => s + r.championProb, 0) / Math.max(top.length, 1);
    const topSeeds = top.map(r => `${r.playerName}${r.seed ? ` [${r.seed}]` : ''}`);

    let label: QuarterAnalysis['label'];
    if (avgChamp > 0.25) label = 'Death Quarter';
    else if (avgChamp > 0.15) label = 'Strong';
    else if (avgChamp > 0.08) label = 'Open';
    else label = 'Wide Open';

    return { quarter: q, topSeeds, avgChampProb: avgChamp, label };
  });
}

// ─── Updated Simulation (Post-Round) ─────────────────────────────────────────

/**
 * Re-simulate the bracket with some players eliminated (actual results).
 * @param remainingDraw  Players still in the tournament
 * @param startRound     Round number where simulation begins (2 = starting from R2, etc.)
 */
export function simulateRemainingBracket(
  remainingDraw: DrawEntry[],
  opts: SimulationOptions
): BracketSimResult[] {
  return simulateBracket(remainingDraw, opts);
}
