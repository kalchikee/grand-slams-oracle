import { Surface, PlayerElo } from '../types';
import { getDb, upsertPlayerElo, getPlayerElo, batchUpsertElos, runTransaction } from '../db/database';

// ─── Constants ────────────────────────────────────────────────────────────────

const K_OVERALL  = 24;   // Overall Elo K-factor
const K_SURFACE  = 32;   // Surface-specific K-factor
const K_CROSS    = 8;    // Cross-surface bleed-through K-factor
const INIT_ELO   = 1300; // Starting Elo for new players
const MEAN_ELO   = 1500; // Regression target for inactive players
const REGRESS_RATE = 0.03; // 3% toward mean per 6-month inactive period

// ─── Core Elo Math ────────────────────────────────────────────────────────────

/** Expected score for player A given ratings A and B. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** Convert Elo difference to win probability. */
export function eloDiffToWinProb(eloDiff: number): number {
  return 1 / (1 + Math.pow(10, -eloDiff / 400));
}

/** Win probability from surface-adjusted Elo (primary prediction feature). */
export function surfaceEloWinProb(
  playerAElo: PlayerElo,
  playerBElo: PlayerElo,
  surface: Surface
): number {
  return eloDiffToWinProb(playerAElo[surface] - playerBElo[surface]);
}

// ─── Elo Update ───────────────────────────────────────────────────────────────

/**
 * Update both players' Elo ratings in-place after a match.
 * Returns the updated Elo objects (also modified in place).
 */
export function processMatch(
  winner: PlayerElo,
  loser: PlayerElo,
  surface: Surface
): void {
  const surfaceKey = surface as 'hard' | 'clay' | 'grass';
  const otherSurfaces = (['hard', 'clay', 'grass'] as Surface[]).filter(s => s !== surface);

  // ── Overall ──
  const expW_overall = expectedScore(winner.overall, loser.overall);
  winner.overall += K_OVERALL * (1 - expW_overall);
  loser.overall  += K_OVERALL * (0 - (1 - expW_overall));

  // ── Primary surface ──
  const expW_surface = expectedScore(winner[surfaceKey], loser[surfaceKey]);
  winner[surfaceKey] += K_SURFACE * (1 - expW_surface);
  loser[surfaceKey]  += K_SURFACE * (0 - (1 - expW_surface));

  // ── Cross-surface bleed ──
  for (const s of otherSurfaces) {
    const exp = expectedScore(winner[s], loser[s]);
    winner[s] += K_CROSS * (1 - exp);
    loser[s]  += K_CROSS * (0 - (1 - exp));
  }

  // Update timestamps
  const now = new Date().toISOString();
  winner.lastUpdated = now;
  loser.lastUpdated  = now;
}

// ─── Inactivity Regression ────────────────────────────────────────────────────

/**
 * Regress a player's Elo toward the mean after a period of inactivity.
 * Called once per 6-month inactivity window.
 */
export function applyInactivityRegression(player: PlayerElo, sixMonthPeriods: number): void {
  const factor = Math.pow(1 - REGRESS_RATE, sixMonthPeriods);
  player.overall = MEAN_ELO + (player.overall - MEAN_ELO) * factor;
  player.hard    = MEAN_ELO + (player.hard    - MEAN_ELO) * factor;
  player.clay    = MEAN_ELO + (player.clay    - MEAN_ELO) * factor;
  player.grass   = MEAN_ELO + (player.grass   - MEAN_ELO) * factor;
}

// ─── Player Initialization ───────────────────────────────────────────────────

export function getOrCreatePlayerElo(
  playerId: string,
  playerName: string,
  date: string
): PlayerElo {
  const db = getDb();
  const existing = getPlayerElo(playerId);
  if (existing) return existing;

  const newPlayer: PlayerElo = {
    playerId,
    name: playerName,
    overall: INIT_ELO,
    hard:    INIT_ELO,
    clay:    INIT_ELO,
    grass:   INIT_ELO,
    lastUpdated: date,
    isActive: true,
  };
  upsertPlayerElo(newPlayer);
  return newPlayer;
}

// ─── Batch Match Processing ───────────────────────────────────────────────────

export interface RawMatchForElo {
  winnerId: string;
  winnerName: string;
  loserId: string;
  loserName: string;
  surface: Surface;
  date: string;
  tourneyLevel: string; // 'G' = Grand Slam
}

/**
 * Process a batch of historical matches in chronological order to build Elo ratings.
 * Returns a map of playerId → PlayerElo for all affected players.
 */
export function processMatchBatch(
  matches: RawMatchForElo[],
  onProgress?: (i: number, total: number) => void
): Map<string, PlayerElo> {
  const eloMap = new Map<string, PlayerElo>();

  const getElo = (id: string, name: string, date: string): PlayerElo => {
    if (!eloMap.has(id)) {
      // Try database first (for resumable processing)
      const existing = getPlayerElo(id);
      eloMap.set(id, existing ?? {
        playerId: id, name,
        overall: INIT_ELO, hard: INIT_ELO, clay: INIT_ELO, grass: INIT_ELO,
        lastUpdated: date, isActive: true,
      });
    }
    const p = eloMap.get(id)!;
    p.name = name; // Update name in case it changed
    return p;
  };

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const surface = normalizeSurface(m.surface as string);
    const winner = getElo(m.winnerId, m.winnerName, m.date);
    const loser  = getElo(m.loserId,  m.loserName,  m.date);

    processMatch(winner, loser, surface);

    if (onProgress && i % 1000 === 0) onProgress(i, matches.length);
  }

  return eloMap;
}

/** Persist entire eloMap to the database in one transaction. */
export function persistEloMap(eloMap: Map<string, PlayerElo>): void {
  batchUpsertElos(Array.from(eloMap.values()));
}

// ─── Surface Normalization ────────────────────────────────────────────────────

export function normalizeSurface(raw: string): Surface {
  const s = raw.toLowerCase().trim();
  if (s === 'clay') return 'clay';
  if (s === 'grass') return 'grass';
  return 'hard'; // Hard, Carpet, Acrylic, Indoor → hard
}

// ─── Rating Helpers ───────────────────────────────────────────────────────────

export function eloRankings(surface?: Surface): PlayerElo[] {
  const db = getDb();
  const col = surface ? `elo_${surface}` : 'elo_overall';
  const rows = db.prepare(
    `SELECT player_id, name, elo_overall, elo_hard, elo_clay, elo_grass, last_updated, is_active
     FROM players WHERE is_active = 1 ORDER BY ${col} DESC`
  ).all() as any[];
  return rows.map((r: any) => ({
    playerId: r.player_id, name: r.name,
    overall: r.elo_overall, hard: r.elo_hard, clay: r.elo_clay, grass: r.elo_grass,
    lastUpdated: r.last_updated, isActive: r.is_active === 1,
  }));
}

export function getSurfaceElo(player: PlayerElo, surface: Surface): number {
  return player[surface];
}

export function eloToDisplayRating(elo: number): string {
  return Math.round(elo).toString();
}
