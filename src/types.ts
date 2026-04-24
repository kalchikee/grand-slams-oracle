// ─── Core Types ───────────────────────────────────────────────────────────────

export type Surface = 'hard' | 'clay' | 'grass';
export type Gender = 'mens' | 'womens';
export type Round =
  | 'R128' | 'R64' | 'R32' | 'R16' | 'QF' | 'SF' | 'F'
  | 'Q1' | 'Q2' | 'Q3' | 'RR';

// ─── Tournament ───────────────────────────────────────────────────────────────

export interface Tournament {
  name: string;
  shortName: string;
  surface: Surface;
  color: number; // Discord embed sidebar color (hex)
  emoji: string;
  startMonth: number; // 1-based
  startDay: number;
  endMonth: number;
  endDay: number;
}

// ─── Player ───────────────────────────────────────────────────────────────────

export interface PlayerElo {
  playerId: string;
  name: string;
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  lastUpdated: string; // ISO date
  isActive: boolean;
}

export interface PlayerStats {
  playerId: string;
  aceRate: number;         // aces / service games
  dfRate: number;          // double faults / service games
  firstServePct: number;   // first serves in %
  firstServeWonPct: number;
  secondServeWonPct: number;
  serviceGamesWonPct: number;
  returnGamesWonPct: number;
  bpConvertedPct: number;
  bpSavedPct: number;
  tiebreakWinPct: number;
  recentWinPct: number;    // last 10 matches
  recentSurfaceWinPct: number;
  slamExperience: number;  // career Grand Slam matches
  slamTitles: number;
  age: number;
}

// ─── Match ────────────────────────────────────────────────────────────────────

export interface MatchRecord {
  matchId: string;
  tournament: string;
  surface: Surface;
  round: Round;
  date: string;
  playerAId: string;
  playerBId: string;
  winnerId: string | null;
  score: string | null;
  bestOf: number;
  playerAEloPre: number;
  playerBEloPre: number;
  predictedWinnerId?: string;
  winProbability?: number;
}

export interface SackmannMatch {
  tourneyId: string;
  tourneyName: string;
  surface: string;
  tourneyLevel: string;
  tourneyDate: string;
  winnerId: string;
  winnerName: string;
  winnerAge: number;
  winnerRank: number;
  winnerRankPoints: number;
  loserId: string;
  loserName: string;
  loserAge: number;
  loserRank: number;
  loserRankPoints: number;
  score: string;
  bestOf: number;
  round: string;
  minutes: number;
  wAce: number; wDf: number; wSvpt: number;
  w1stIn: number; w1stWon: number; w2ndWon: number;
  wSvGms: number; wBpSaved: number; wBpFaced: number;
  lAce: number; lDf: number; lSvpt: number;
  l1stIn: number; l1stWon: number; l2ndWon: number;
  lSvGms: number; lBpSaved: number; lBpFaced: number;
}

// ─── Features ────────────────────────────────────────────────────────────────

export interface MatchFeatures {
  surface_elo_diff: number;
  overall_elo_diff: number;
  ranking_diff: number;
  ranking_points_diff: number;
  h2h_adj: number;
  h2h_surface_adj: number;
  recent_10_win_pct_diff: number;
  recent_surface_win_pct_diff: number;
  sets_won_pct_recent_diff: number;
  service_games_won_pct_diff: number;
  return_games_won_pct_diff: number;
  ace_rate_diff: number;
  double_fault_rate_diff: number;
  first_serve_pct_diff: number;
  first_serve_points_won_diff: number;
  second_serve_points_won_diff: number;
  break_points_converted_diff: number;
  break_points_saved_diff: number;
  tiebreak_win_pct_diff: number;
  age_diff: number;
  player_a_age: number;
  matches_played_this_slam: number;
  total_sets_played_slam: number;
  avg_match_duration_slam: number;
  days_since_last_match: number;
  slam_experience_diff: number;
  slam_titles_diff: number;
  this_slam_history_diff: number;
  seed_diff: number;
  injury_flag: number;
}

// ─── Prediction ───────────────────────────────────────────────────────────────

export interface MatchPrediction {
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  playerAWinProb: number; // after Bo5 amplification for men's
  surface: Surface;
  round: Round;
  features: MatchFeatures;
  edgeVsOdds?: number;
  isHighConviction: boolean;  // >= 70%
  isExtremeConviction: boolean; // >= 80%
  isValueBet: boolean;         // edge > 5%
}

// ─── Bracket Simulation ───────────────────────────────────────────────────────

export interface DrawEntry {
  playerId: string;
  playerName: string;
  seed: number | null;
  drawPosition: number; // 1–128
  gender: Gender;
}

export interface BracketSimResult {
  playerId: string;
  playerName: string;
  seed: number | null;
  championProb: number;
  finalistProb: number;
  semifinalistProb: number;
  quarterfinalistProb: number;
  r16Prob: number;
  // bracket section for grouping
  quarter: 1 | 2 | 3 | 4;
}

// ─── Model ────────────────────────────────────────────────────────────────────

export interface ModelCoefficients {
  intercept: number;
  coefficients: Record<string, number>;
  feature_names: string[];
  trained_on: string;
  accuracy?: number;
  brier_score?: number;
}

export interface CalibrationParams {
  method: 'platt' | 'isotonic';
  a: number; // sigmoid: 1/(1+exp(a*x+b))
  b: number;
}

// ─── Accuracy Tracking ───────────────────────────────────────────────────────

export interface AccuracyRecord {
  tournament: string;
  year: number;
  totalPredictions: number;
  correctPredictions: number;
  highConvTotal: number;
  highConvCorrect: number;
  extremeConvTotal: number;
  extremeConvCorrect: number;
  valueBetsTotal: number;
  valueBetsCorrect: number;
  valueBetsProfit: number;
}
