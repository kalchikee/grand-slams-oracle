import { Surface, Gender, MatchFeatures, PlayerElo, PlayerStats } from '../types';
import { getDb, getH2H, getPlayerStats, getPlayerElo } from '../db/database';

// ─── Fatigue Context ──────────────────────────────────────────────────────────

export interface TournamentFatigue {
  matchesPlayed: number;
  setsPlayed: number;
  totalMinutes: number;
  daysSinceLastMatch: number;
}

export function getTournamentFatigue(
  playerId: string,
  tournament: string,
  year: number,
  currentDate: string
): TournamentFatigue {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.score, m.date
    FROM matches m
    WHERE (m.player_a_id = ? OR m.player_b_id = ?)
      AND m.tournament = ?
      AND strftime('%Y', m.date) = ?
      AND m.winner_id IS NOT NULL
    ORDER BY m.date DESC
  `).all(playerId, playerId, tournament, year.toString()) as any[];

  let setsPlayed = 0;
  let totalMinutes = 0;

  for (const r of rows) {
    setsPlayed += countSetsFromScore(r.score ?? '');
  }

  const lastMatch = rows[0];
  let daysSinceLastMatch = 1;
  if (lastMatch) {
    const d1 = new Date(lastMatch.date);
    const d2 = new Date(currentDate);
    daysSinceLastMatch = Math.max(0, Math.floor((d2.getTime() - d1.getTime()) / 86400000));
  }

  return {
    matchesPlayed: rows.length,
    setsPlayed,
    totalMinutes,
    daysSinceLastMatch,
  };
}

function countSetsFromScore(score: string): number {
  if (!score) return 3; // assume average
  return score.split(' ').filter(s => s.includes('-')).length;
}

// ─── Slam History ─────────────────────────────────────────────────────────────

export function getSlamHistory(playerId: string, slamName: string): number {
  const db = getDb();
  // Returns best round reached at this specific Slam (encoded as 1-7)
  const row = db.prepare(`
    SELECT MAX(
      CASE m.round
        WHEN 'R128' THEN 1 WHEN 'R64' THEN 2 WHEN 'R32' THEN 3
        WHEN 'R16'  THEN 4 WHEN 'QF'  THEN 5 WHEN 'SF'  THEN 6
        WHEN 'F'    THEN 7 ELSE 0
      END
    ) as best_round
    FROM matches m
    WHERE (m.player_a_id = ? OR m.player_b_id = ?)
      AND m.tournament = ?
      AND m.is_grand_slam = 1
  `).get(playerId, playerId, slamName) as any;
  return row?.best_round ?? 0;
}

export function getSlamExperience(playerId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM matches
    WHERE (player_a_id = ? OR player_b_id = ?) AND is_grand_slam = 1
  `).get(playerId, playerId) as any;
  return row?.cnt ?? 0;
}

export function getSlamTitles(playerId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM matches
    WHERE winner_id = ? AND is_grand_slam = 1 AND round = 'F'
  `).get(playerId) as any;
  return row?.cnt ?? 0;
}

// ─── Recent Surface Win Pct ───────────────────────────────────────────────────

export function getRecentSurfaceWinPct(
  playerId: string,
  surface: Surface,
  lookbackMonths: number = 12
): number {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - lookbackMonths);

  const rows = db.prepare(`
    SELECT winner_id FROM matches
    WHERE (player_a_id = ? OR player_b_id = ?)
      AND surface = ?
      AND date >= ?
      AND winner_id IS NOT NULL
  `).all(playerId, playerId, surface, cutoff.toISOString().slice(0, 10)) as any[];

  if (rows.length === 0) return 0.5;
  const wins = rows.filter(r => r.winner_id === playerId).length;
  return wins / rows.length;
}

// ─── H2H Adjustment ───────────────────────────────────────────────────────────

/**
 * Compute a H2H-based adjustment to the Elo probability.
 * Returns a value in [-0.05, +0.05] representing deviation from Elo expectation.
 * Uses both lifetime and surface H2H, down-weighted when sample < 3.
 */
export function computeH2HAdjustment(
  playerAId: string,
  playerBId: string,
  surface: Surface,
  eloBasedProb: number
): number {
  const overall = getH2H(playerAId, playerBId, 'all');
  const surfH2H = getH2H(playerAId, playerBId, surface);

  const totalMeetings = overall.winsA + overall.winsB;
  const surfMeetings  = surfH2H.winsA + surfH2H.winsB;

  if (totalMeetings < 3) return 0; // insufficient data

  // H2H win % (lifetime)
  const h2hWinPct = overall.winsA / totalMeetings;

  // Surface H2H win % (if available)
  const surfWinPct = surfMeetings >= 3
    ? surfH2H.winsA / surfMeetings
    : h2hWinPct;

  // Weighted: surface H2H counts more
  const weight = surfMeetings >= 3 ? 0.7 : 0.3;
  const blendedH2H = weight * surfWinPct + (1 - weight) * h2hWinPct;

  // How much does H2H deviate from Elo expectation?
  const deviation = blendedH2H - eloBasedProb;

  // Cap at ±5%, scale by number of meetings (more meetings = more trust)
  const meetingTrust = Math.min(1, totalMeetings / 20);
  const adj = deviation * meetingTrust * 0.5; // half the deviation

  return Math.max(-0.05, Math.min(0.05, adj));
}

// ─── Fatigue Penalty ──────────────────────────────────────────────────────────

/**
 * Returns a probability adjustment (negative = penalty) for fatigue.
 * 5-set matches → ~3-5% penalty in next match.
 */
export function computeFatiguePenalty(fatigue: TournamentFatigue, age: number): number {
  let penalty = 0;

  // Per set played beyond average (typical: 3 per match in BO5)
  const avgSets = fatigue.matchesPlayed * 3;
  const excessSets = Math.max(0, fatigue.setsPlayed - avgSets);
  penalty += excessSets * 0.008; // 0.8% per excess set

  // Rest recovery
  if (fatigue.daysSinceLastMatch === 1) penalty += 0.01; // playing back-to-back
  if (fatigue.daysSinceLastMatch === 0) penalty += 0.03; // same-day (rare)

  // Age amplification (30+)
  if (age >= 32) penalty *= 1.4;
  else if (age >= 30) penalty *= 1.2;

  return Math.min(0.08, penalty); // cap at 8%
}

// ─── Main Feature Extraction ─────────────────────────────────────────────────

export interface MatchContext {
  tournament: string;
  year: number;
  surface: Surface;
  gender: Gender;
  round: string;
  date: string;
  playerAId: string;
  playerBId: string;
  playerASeed: number | null;
  playerBSeed: number | null;
  playerAOdds?: number; // decimal odds from bookmaker
  playerBOdds?: number;
  playerAInjuryFlag?: boolean;
  playerBInjuryFlag?: boolean;
}

export function extractFeatures(ctx: MatchContext): MatchFeatures {
  const eloA = getPlayerElo(ctx.playerAId);
  const eloB = getPlayerElo(ctx.playerBId);
  const statsA = getPlayerStats(ctx.playerAId);
  const statsB = getPlayerStats(ctx.playerBId);

  // Defaults for missing players
  const defaultElo: PlayerElo = {
    playerId: '', name: '', overall: 1300,
    hard: 1300, clay: 1300, grass: 1300,
    lastUpdated: '', isActive: true,
  };
  const defaultStats: PlayerStats = {
    playerId: '', aceRate: 0.07, dfRate: 0.03,
    firstServePct: 0.62, firstServeWonPct: 0.73, secondServeWonPct: 0.53,
    serviceGamesWonPct: 0.82, returnGamesWonPct: 0.35,
    bpConvertedPct: 0.42, bpSavedPct: 0.63,
    tiebreakWinPct: 0.50, recentWinPct: 0.60, recentSurfaceWinPct: 0.55,
    slamExperience: 10, slamTitles: 0, age: 25,
  };

  const ea = eloA ?? defaultElo;
  const eb = eloB ?? defaultElo;
  const sa = statsA ?? defaultStats;
  const sb = statsB ?? defaultStats;

  // Surface-specific Elo diff (THE most important feature)
  const surfaceEloDiff = ea[ctx.surface] - eb[ctx.surface];
  const overallEloDiff = ea.overall - eb.overall;

  // Elo-based win probability (for H2H adjustment)
  const eloWinProb = 1 / (1 + Math.pow(10, -surfaceEloDiff / 400));

  // H2H adjustment
  const h2hAdj = computeH2HAdjustment(ctx.playerAId, ctx.playerBId, ctx.surface, eloWinProb);
  const h2hSurfaceAdj = (() => {
    const sh = getH2H(ctx.playerAId, ctx.playerBId, ctx.surface);
    const total = sh.winsA + sh.winsB;
    if (total < 3) return 0;
    return (sh.winsA / total) - eloWinProb;
  })();

  // Recent surface win pct
  const recentSurfA = getRecentSurfaceWinPct(ctx.playerAId, ctx.surface);
  const recentSurfB = getRecentSurfaceWinPct(ctx.playerBId, ctx.surface);

  // Fatigue
  const fatigueA = getTournamentFatigue(ctx.playerAId, ctx.tournament, ctx.year, ctx.date);
  const fatigueB = getTournamentFatigue(ctx.playerBId, ctx.tournament, ctx.year, ctx.date);
  const fatiguePenaltyA = computeFatiguePenalty(fatigueA, sa.age);
  const fatiguePenaltyB = computeFatiguePenalty(fatigueB, sb.age);

  // Slam history
  const slamHistA = getSlamHistory(ctx.playerAId, ctx.tournament);
  const slamHistB = getSlamHistory(ctx.playerBId, ctx.tournament);

  // Seeds
  const seedA = ctx.playerASeed ?? 33; // unseeded = 33
  const seedB = ctx.playerBSeed ?? 33;

  return {
    surface_elo_diff: surfaceEloDiff,
    overall_elo_diff: overallEloDiff,
    ranking_diff: 0, // populated externally if rankings available
    ranking_points_diff: 0,
    h2h_adj: h2hAdj,
    h2h_surface_adj: h2hSurfaceAdj,
    recent_10_win_pct_diff: sa.recentWinPct - sb.recentWinPct,
    recent_surface_win_pct_diff: recentSurfA - recentSurfB,
    sets_won_pct_recent_diff: 0, // computed from recent matches
    service_games_won_pct_diff: sa.serviceGamesWonPct - sb.serviceGamesWonPct,
    return_games_won_pct_diff: sa.returnGamesWonPct - sb.returnGamesWonPct,
    ace_rate_diff: sa.aceRate - sb.aceRate,
    double_fault_rate_diff: sa.dfRate - sb.dfRate,
    first_serve_pct_diff: sa.firstServePct - sb.firstServePct,
    first_serve_points_won_diff: sa.firstServeWonPct - sb.firstServeWonPct,
    second_serve_points_won_diff: sa.secondServeWonPct - sb.secondServeWonPct,
    break_points_converted_diff: sa.bpConvertedPct - sb.bpConvertedPct,
    break_points_saved_diff: sa.bpSavedPct - sb.bpSavedPct,
    tiebreak_win_pct_diff: sa.tiebreakWinPct - sb.tiebreakWinPct,
    age_diff: sa.age - sb.age,
    player_a_age: sa.age,
    matches_played_this_slam: fatigueA.matchesPlayed,
    total_sets_played_slam: fatigueA.setsPlayed,
    avg_match_duration_slam: fatigueA.totalMinutes / Math.max(1, fatigueA.matchesPlayed),
    days_since_last_match: fatigueA.daysSinceLastMatch,
    slam_experience_diff: sa.slamExperience - sb.slamExperience,
    slam_titles_diff: sa.slamTitles - sb.slamTitles,
    this_slam_history_diff: slamHistA - slamHistB,
    seed_diff: seedA - seedB,
    injury_flag: (ctx.playerAInjuryFlag ? 1 : 0) - (ctx.playerBInjuryFlag ? 1 : 0),
  };
}
