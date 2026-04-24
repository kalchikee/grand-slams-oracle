// Writes today's Grand Slam predictions to predictions/YYYY-MM-DD.json.
// The kalshi-safety service fetches this file via GitHub raw URL to
// decide which picks to back on Kalshi.

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { MatchPrediction } from '../types';
import { MatchContext } from '../pipeline/features';

interface Pick {
  gameId: string;
  home: string;
  away: string;
  startTime?: string;
  pickedTeam: string;
  pickedSide: 'home' | 'away';
  modelProb: number;
  vegasProb?: number;
  edge?: number;
  confidenceTier?: string;
  extra?: Record<string, unknown>;
}

interface PredictionsFile {
  sport: 'TENNIS';
  date: string;
  generatedAt: string;
  picks: Pick[];
}

const MIN_PROB = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.58');

function tierFor(prob: number): string {
  if (prob >= 0.80) return 'extreme';
  if (prob >= 0.70) return 'high_conviction';
  if (prob >= 0.60) return 'strong';
  if (prob >= 0.52) return 'lean';
  return 'uncertain';
}

export interface SlamPickInput {
  prediction: MatchPrediction;
  context: MatchContext;
}

export function writePredictionsFile(
  date: string,
  tournamentName: string,
  items: SlamPickInput[],
): string {
  const dir = resolve(process.cwd(), 'predictions');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${date}.json`);

  const picks: Pick[] = [];

  for (const { prediction: p, context: ctx } of items) {
    // Treat the seeded / higher-seeded player as "home" for the JSON shape.
    // Seed null counts as effectively unseeded (higher number = lower seed).
    const seedA = ctx.playerASeed ?? 999;
    const seedB = ctx.playerBSeed ?? 999;
    const aIsHome = seedA <= seedB;

    const homeName = aIsHome ? p.playerAName : p.playerBName;
    const awayName = aIsHome ? p.playerBName : p.playerAName;
    const homeId = aIsHome ? p.playerAId : p.playerBId;
    const awayId = aIsHome ? p.playerBId : p.playerAId;
    const homeSeed = aIsHome ? seedA : seedB;
    const awaySeed = aIsHome ? seedB : seedA;

    const playerAWinProb = p.playerAWinProb;
    const playerBWinProb = 1 - playerAWinProb;
    const favorsA = playerAWinProb >= playerBWinProb;
    const modelProb = favorsA ? playerAWinProb : playerBWinProb;
    if (modelProb < MIN_PROB) continue;

    const pickedIsHome = (favorsA && aIsHome) || (!favorsA && !aIsHome);
    const pickedTeam = pickedIsHome ? homeName : awayName;

    // Vegas implied prob & edge (if odds were present on the context).
    let vegasProb: number | undefined;
    let edge: number | undefined;
    if (ctx.playerAOdds && ctx.playerBOdds) {
      const impliedA = 1 / ctx.playerAOdds;
      const impliedB = 1 / ctx.playerBOdds;
      const vig = impliedA + impliedB;
      const fairA = impliedA / vig;
      const fairB = impliedB / vig;
      const modelA = playerAWinProb;
      const modelB = playerBWinProb;
      if (favorsA) {
        vegasProb = fairA;
        edge = modelA - fairA;
      } else {
        vegasProb = fairB;
        edge = modelB - fairB;
      }
    } else if (p.edgeVsOdds !== undefined) {
      edge = p.edgeVsOdds;
    }

    picks.push({
      gameId: `tennis-${date}-${homeId}-${awayId}`,
      home: homeName,
      away: awayName,
      pickedTeam,
      pickedSide: pickedIsHome ? 'home' : 'away',
      modelProb,
      vegasProb,
      edge,
      confidenceTier: tierFor(modelProb),
      extra: {
        tournament: ctx.tournament,
        year: ctx.year,
        surface: ctx.surface,
        round: ctx.round,
        gender: ctx.gender,
        homeSeed: homeSeed === 999 ? null : homeSeed,
        awaySeed: awaySeed === 999 ? null : awaySeed,
        homeId,
        awayId,
        isHighConviction: p.isHighConviction,
        isExtremeConviction: p.isExtremeConviction,
        isValueBet: p.isValueBet,
      },
    });
  }

  const file: PredictionsFile = {
    sport: 'TENNIS',
    date,
    generatedAt: new Date().toISOString(),
    picks,
  };
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}
