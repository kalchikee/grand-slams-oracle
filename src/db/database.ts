import { DatabaseSync, StatementSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import {
  PlayerElo, PlayerStats, BracketSimResult, AccuracyRecord, DrawEntry,
} from '../types';

// ─── DB Singleton ─────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '../../data/oracle.sqlite');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

// ─── Transaction Helper ───────────────────────────────────────────────────────

export function runTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      player_id       TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      nationality     TEXT DEFAULT '',
      hand            TEXT DEFAULT '',
      birth_date      TEXT DEFAULT '',
      height_cm       INTEGER DEFAULT 0,
      elo_overall     REAL NOT NULL DEFAULT 1300,
      elo_hard        REAL NOT NULL DEFAULT 1300,
      elo_clay        REAL NOT NULL DEFAULT 1300,
      elo_grass       REAL NOT NULL DEFAULT 1300,
      last_updated    TEXT NOT NULL DEFAULT '',
      is_active       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS player_stats (
      player_id                   TEXT PRIMARY KEY REFERENCES players(player_id),
      ace_rate                    REAL DEFAULT 0,
      df_rate                     REAL DEFAULT 0,
      first_serve_pct             REAL DEFAULT 0,
      first_serve_won_pct         REAL DEFAULT 0,
      second_serve_won_pct        REAL DEFAULT 0,
      service_games_won_pct       REAL DEFAULT 0,
      return_games_won_pct        REAL DEFAULT 0,
      bp_converted_pct            REAL DEFAULT 0,
      bp_saved_pct                REAL DEFAULT 0,
      tiebreak_win_pct            REAL DEFAULT 0,
      recent_win_pct              REAL DEFAULT 0,
      recent_surface_win_pct      REAL DEFAULT 0,
      slam_experience             INTEGER DEFAULT 0,
      slam_titles                 INTEGER DEFAULT 0,
      age                         REAL DEFAULT 0,
      updated_at                  TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS h2h_records (
      player_a_id   TEXT NOT NULL,
      player_b_id   TEXT NOT NULL,
      surface       TEXT NOT NULL DEFAULT 'all',
      wins_a        INTEGER NOT NULL DEFAULT 0,
      wins_b        INTEGER NOT NULL DEFAULT 0,
      last_match    TEXT DEFAULT '',
      PRIMARY KEY (player_a_id, player_b_id, surface)
    );

    CREATE TABLE IF NOT EXISTS matches (
      match_id            TEXT PRIMARY KEY,
      tournament          TEXT NOT NULL,
      surface             TEXT NOT NULL,
      round               TEXT NOT NULL,
      date                TEXT NOT NULL,
      player_a_id         TEXT NOT NULL,
      player_b_id         TEXT NOT NULL,
      winner_id           TEXT,
      score               TEXT,
      best_of             INTEGER NOT NULL DEFAULT 3,
      player_a_elo_pre    REAL,
      player_b_elo_pre    REAL,
      predicted_winner_id TEXT,
      win_probability     REAL,
      is_grand_slam       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tournament_draws (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament    TEXT NOT NULL,
      year          INTEGER NOT NULL,
      gender        TEXT NOT NULL,
      player_id     TEXT NOT NULL,
      player_name   TEXT NOT NULL,
      seed          INTEGER,
      draw_position INTEGER NOT NULL,
      UNIQUE(tournament, year, gender, draw_position)
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament          TEXT NOT NULL,
      year                INTEGER NOT NULL,
      round               TEXT NOT NULL,
      date                TEXT NOT NULL,
      player_a_id         TEXT NOT NULL,
      player_b_id         TEXT NOT NULL,
      player_a_win_prob   REAL NOT NULL,
      features_json       TEXT,
      actual_winner_id    TEXT,
      correct             INTEGER,
      edge_vs_odds        REAL
    );

    CREATE TABLE IF NOT EXISTS bracket_simulations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament        TEXT NOT NULL,
      year              INTEGER NOT NULL,
      gender            TEXT NOT NULL,
      run_date          TEXT NOT NULL,
      player_id         TEXT NOT NULL,
      player_name       TEXT NOT NULL,
      seed              INTEGER,
      champion_prob     REAL NOT NULL DEFAULT 0,
      finalist_prob     REAL NOT NULL DEFAULT 0,
      semi_prob         REAL NOT NULL DEFAULT 0,
      quarter_prob      REAL NOT NULL DEFAULT 0,
      r16_prob          REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accuracy_tracker (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament            TEXT NOT NULL,
      year                  INTEGER NOT NULL,
      total_predictions     INTEGER NOT NULL DEFAULT 0,
      correct_predictions   INTEGER NOT NULL DEFAULT 0,
      high_conv_total       INTEGER NOT NULL DEFAULT 0,
      high_conv_correct     INTEGER NOT NULL DEFAULT 0,
      extreme_conv_total    INTEGER NOT NULL DEFAULT 0,
      extreme_conv_correct  INTEGER NOT NULL DEFAULT 0,
      value_bets_total      INTEGER NOT NULL DEFAULT 0,
      value_bets_correct    INTEGER NOT NULL DEFAULT 0,
      value_bets_profit     REAL NOT NULL DEFAULT 0,
      UNIQUE(tournament, year)
    );

    CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament, date);
    CREATE INDEX IF NOT EXISTS idx_predictions_tournament ON predictions(tournament, year);
    CREATE INDEX IF NOT EXISTS idx_h2h ON h2h_records(player_a_id, player_b_id);
  `);
}

// ─── Row Helpers ──────────────────────────────────────────────────────────────

function row(r: unknown): any { return r as any; }

// ─── Player Elo ───────────────────────────────────────────────────────────────

export function upsertPlayerElo(elo: PlayerElo): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO players (player_id, name, elo_overall, elo_hard, elo_clay, elo_grass, last_updated, is_active)
    VALUES (@playerId, @name, @overall, @hard, @clay, @grass, @lastUpdated, 1)
    ON CONFLICT(player_id) DO UPDATE SET
      name        = excluded.name,
      elo_overall = excluded.elo_overall,
      elo_hard    = excluded.elo_hard,
      elo_clay    = excluded.elo_clay,
      elo_grass   = excluded.elo_grass,
      last_updated = excluded.last_updated
  `).run({
    playerId: elo.playerId,
    name: elo.name,
    overall: elo.overall,
    hard: elo.hard,
    clay: elo.clay,
    grass: elo.grass,
    lastUpdated: elo.lastUpdated,
  });
}

export function getPlayerElo(playerId: string): PlayerElo | null {
  const db = getDb();
  const r = row(db.prepare(
    'SELECT player_id, name, elo_overall, elo_hard, elo_clay, elo_grass, last_updated, is_active FROM players WHERE player_id = ?'
  ).get(playerId));
  if (!r) return null;
  return {
    playerId: r.player_id,
    name: r.name,
    overall: r.elo_overall,
    hard: r.elo_hard,
    clay: r.elo_clay,
    grass: r.elo_grass,
    lastUpdated: r.last_updated,
    isActive: r.is_active === 1,
  };
}

export function getAllPlayerElos(): PlayerElo[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT player_id, name, elo_overall, elo_hard, elo_clay, elo_grass, last_updated, is_active FROM players ORDER BY elo_overall DESC'
  ).all() as any[];
  return rows.map(r => ({
    playerId: r.player_id, name: r.name,
    overall: r.elo_overall, hard: r.elo_hard, clay: r.elo_clay, grass: r.elo_grass,
    lastUpdated: r.last_updated, isActive: r.is_active === 1,
  }));
}

// ─── Player Stats ─────────────────────────────────────────────────────────────

export function upsertPlayerStats(stats: PlayerStats): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO player_stats
      (player_id, ace_rate, df_rate, first_serve_pct, first_serve_won_pct,
       second_serve_won_pct, service_games_won_pct, return_games_won_pct,
       bp_converted_pct, bp_saved_pct, tiebreak_win_pct, recent_win_pct,
       recent_surface_win_pct, slam_experience, slam_titles, age, updated_at)
    VALUES
      (@playerId, @aceRate, @dfRate, @firstServePct, @firstServeWonPct,
       @secondServeWonPct, @serviceGamesWonPct, @returnGamesWonPct,
       @bpConvertedPct, @bpSavedPct, @tiebreakWinPct, @recentWinPct,
       @recentSurfaceWinPct, @slamExperience, @slamTitles, @age, @updatedAt)
    ON CONFLICT(player_id) DO UPDATE SET
      ace_rate = excluded.ace_rate,
      df_rate = excluded.df_rate,
      first_serve_pct = excluded.first_serve_pct,
      first_serve_won_pct = excluded.first_serve_won_pct,
      second_serve_won_pct = excluded.second_serve_won_pct,
      service_games_won_pct = excluded.service_games_won_pct,
      return_games_won_pct = excluded.return_games_won_pct,
      bp_converted_pct = excluded.bp_converted_pct,
      bp_saved_pct = excluded.bp_saved_pct,
      tiebreak_win_pct = excluded.tiebreak_win_pct,
      recent_win_pct = excluded.recent_win_pct,
      recent_surface_win_pct = excluded.recent_surface_win_pct,
      slam_experience = excluded.slam_experience,
      slam_titles = excluded.slam_titles,
      age = excluded.age,
      updated_at = excluded.updated_at
  `).run({
    playerId: stats.playerId, aceRate: stats.aceRate, dfRate: stats.dfRate,
    firstServePct: stats.firstServePct, firstServeWonPct: stats.firstServeWonPct,
    secondServeWonPct: stats.secondServeWonPct, serviceGamesWonPct: stats.serviceGamesWonPct,
    returnGamesWonPct: stats.returnGamesWonPct, bpConvertedPct: stats.bpConvertedPct,
    bpSavedPct: stats.bpSavedPct, tiebreakWinPct: stats.tiebreakWinPct,
    recentWinPct: stats.recentWinPct, recentSurfaceWinPct: stats.recentSurfaceWinPct,
    slamExperience: stats.slamExperience, slamTitles: stats.slamTitles,
    age: stats.age, updatedAt: new Date().toISOString(),
  });
}

export function getPlayerStats(playerId: string): PlayerStats | null {
  const db = getDb();
  const r = row(db.prepare('SELECT * FROM player_stats WHERE player_id = ?').get(playerId));
  if (!r) return null;
  return {
    playerId: r.player_id, aceRate: r.ace_rate, dfRate: r.df_rate,
    firstServePct: r.first_serve_pct, firstServeWonPct: r.first_serve_won_pct,
    secondServeWonPct: r.second_serve_won_pct, serviceGamesWonPct: r.service_games_won_pct,
    returnGamesWonPct: r.return_games_won_pct, bpConvertedPct: r.bp_converted_pct,
    bpSavedPct: r.bp_saved_pct, tiebreakWinPct: r.tiebreak_win_pct,
    recentWinPct: r.recent_win_pct, recentSurfaceWinPct: r.recent_surface_win_pct,
    slamExperience: r.slam_experience, slamTitles: r.slam_titles, age: r.age,
  };
}

// ─── H2H Records ─────────────────────────────────────────────────────────────

export function updateH2H(winId: string, loseId: string, surface: string, date: string): void {
  const db = getDb();
  const [aId, bId] = winId < loseId ? [winId, loseId] : [loseId, winId];
  const aWon = winId === aId;

  for (const s of [surface, 'all']) {
    db.prepare(`
      INSERT INTO h2h_records (player_a_id, player_b_id, surface, wins_a, wins_b, last_match)
      VALUES (@aId, @bId, @s, @wa, @wb, @date)
      ON CONFLICT(player_a_id, player_b_id, surface) DO UPDATE SET
        wins_a = wins_a + @wa,
        wins_b = wins_b + @wb,
        last_match = CASE WHEN @date > last_match THEN @date ELSE last_match END
    `).run({ aId, bId, s, wa: aWon ? 1 : 0, wb: aWon ? 0 : 1, date });
  }
}

export function getH2H(playerAId: string, playerBId: string, surface?: string): { winsA: number; winsB: number } {
  const db = getDb();
  const [aId, bId] = playerAId < playerBId ? [playerAId, playerBId] : [playerBId, playerAId];
  const flipped = playerAId !== aId;
  const s = surface ?? 'all';

  const r = row(db.prepare(
    'SELECT wins_a, wins_b FROM h2h_records WHERE player_a_id = ? AND player_b_id = ? AND surface = ?'
  ).get(aId, bId, s));

  if (!r) return { winsA: 0, winsB: 0 };
  return flipped
    ? { winsA: r.wins_b, winsB: r.wins_a }
    : { winsA: r.wins_a, winsB: r.wins_b };
}

// ─── Predictions ──────────────────────────────────────────────────────────────

export function savePrediction(p: {
  tournament: string; year: number; round: string; date: string;
  playerAId: string; playerBId: string; playerAWinProb: number;
  featuresJson?: string; edgeVsOdds?: number;
}): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO predictions (tournament, year, round, date, player_a_id, player_b_id,
      player_a_win_prob, features_json, edge_vs_odds)
    VALUES (@tournament, @year, @round, @date, @playerAId, @playerBId,
      @playerAWinProb, @featuresJson, @edgeVsOdds)
  `).run({
    tournament: p.tournament, year: p.year, round: p.round, date: p.date,
    playerAId: p.playerAId, playerBId: p.playerBId, playerAWinProb: p.playerAWinProb,
    featuresJson: p.featuresJson ?? null, edgeVsOdds: p.edgeVsOdds ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function getPredictionsForSlam(tournament: string, year: number): any[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM predictions WHERE tournament = ? AND year = ? ORDER BY date'
  ).all(tournament, year) as any[];
}

// ─── Bracket Simulations ─────────────────────────────────────────────────────

export function saveBracketSim(
  tournament: string, year: number, gender: string, results: BracketSimResult[]
): void {
  const db = getDb();
  const runDate = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO bracket_simulations
      (tournament, year, gender, run_date, player_id, player_name, seed,
       champion_prob, finalist_prob, semi_prob, quarter_prob, r16_prob)
    VALUES (@tournament, @year, @gender, @runDate, @playerId, @playerName, @seed,
      @championProb, @finalistProb, @semiProb, @quarterProb, @r16Prob)
  `);
  runTransaction(() => {
    for (const r of results) {
      insert.run({
        tournament, year, gender, runDate,
        playerId: r.playerId, playerName: r.playerName, seed: r.seed ?? null,
        championProb: r.championProb, finalistProb: r.finalistProb,
        semiProb: r.semifinalistProb, quarterProb: r.quarterfinalistProb, r16Prob: r.r16Prob,
      });
    }
  });
}

export function getLatestBracketSim(tournament: string, year: number, gender: string): BracketSimResult[] {
  const db = getDb();
  const latest = row(db.prepare(`
    SELECT MAX(run_date) as max_date FROM bracket_simulations
    WHERE tournament = ? AND year = ? AND gender = ?
  `).get(tournament, year, gender));
  if (!latest?.max_date) return [];

  const rows = db.prepare(`
    SELECT * FROM bracket_simulations
    WHERE tournament = ? AND year = ? AND gender = ? AND run_date = ?
    ORDER BY champion_prob DESC
  `).all(tournament, year, gender, latest.max_date) as any[];

  return rows.map(r => ({
    playerId: r.player_id, playerName: r.player_name, seed: r.seed,
    championProb: r.champion_prob, finalistProb: r.finalist_prob,
    semifinalistProb: r.semi_prob, quarterfinalistProb: r.quarter_prob, r16Prob: r.r16_prob,
    quarter: 1 as const,
  }));
}

// ─── Tournament Draw ──────────────────────────────────────────────────────────

export function saveDraw(tournament: string, year: number, gender: string, entries: DrawEntry[]): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO tournament_draws (tournament, year, gender, player_id, player_name, seed, draw_position)
    VALUES (@tournament, @year, @gender, @playerId, @playerName, @seed, @drawPosition)
  `);
  runTransaction(() => {
    for (const e of entries) {
      insert.run({ tournament, year, gender, playerId: e.playerId, playerName: e.playerName,
                   seed: e.seed ?? null, drawPosition: e.drawPosition });
    }
  });
}

export function getDraw(tournament: string, year: number, gender: string): DrawEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM tournament_draws WHERE tournament = ? AND year = ? AND gender = ? ORDER BY draw_position'
  ).all(tournament, year, gender) as any[];
  return rows.map(r => ({
    playerId: r.player_id, playerName: r.player_name,
    seed: r.seed, drawPosition: r.draw_position, gender: r.gender,
  }));
}

// ─── Accuracy Tracking ───────────────────────────────────────────────────────

export function getOrCreateAccuracy(tournament: string, year: number): AccuracyRecord {
  const db = getDb();
  let r = row(db.prepare(
    'SELECT * FROM accuracy_tracker WHERE tournament = ? AND year = ?'
  ).get(tournament, year));
  if (!r) {
    db.prepare('INSERT OR IGNORE INTO accuracy_tracker (tournament, year) VALUES (?, ?)').run(tournament, year);
    r = row(db.prepare('SELECT * FROM accuracy_tracker WHERE tournament = ? AND year = ?').get(tournament, year));
  }
  return {
    tournament: r.tournament, year: r.year,
    totalPredictions: r.total_predictions, correctPredictions: r.correct_predictions,
    highConvTotal: r.high_conv_total, highConvCorrect: r.high_conv_correct,
    extremeConvTotal: r.extreme_conv_total, extremeConvCorrect: r.extreme_conv_correct,
    valueBetsTotal: r.value_bets_total, valueBetsCorrect: r.value_bets_correct,
    valueBetsProfit: r.value_bets_profit,
  };
}

// ─── Batch Upsert for Elo (used by init-elo) ─────────────────────────────────

export function batchUpsertElos(elos: PlayerElo[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO players (player_id, name, elo_overall, elo_hard, elo_clay, elo_grass, last_updated, is_active)
    VALUES (@playerId, @name, @overall, @hard, @clay, @grass, @lastUpdated, 1)
    ON CONFLICT(player_id) DO UPDATE SET
      name        = excluded.name,
      elo_overall = excluded.elo_overall,
      elo_hard    = excluded.elo_hard,
      elo_clay    = excluded.elo_clay,
      elo_grass   = excluded.elo_grass,
      last_updated = excluded.last_updated
  `);
  runTransaction(() => {
    for (const e of elos) {
      stmt.run({
        playerId: e.playerId, name: e.name,
        overall: e.overall, hard: e.hard, clay: e.clay, grass: e.grass,
        lastUpdated: e.lastUpdated,
      });
    }
  });
}
