import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { SackmannMatch } from '../types';
import { normalizeSurface } from '../elo/elo';
import { isGrandSlam } from './tournament';

// ─── Paths ────────────────────────────────────────────────────────────────────

export const ATP_DATA_DIR = path.resolve(__dirname, '../../data/sackmann_atp');
export const WTA_DATA_DIR = path.resolve(__dirname, '../../data/sackmann_wta');

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

function parseNum(v: string | undefined): number {
  if (!v || v === '' || v === 'N/A') return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function parseRow(row: Record<string, string>): SackmannMatch {
  return {
    tourneyId:         row['tourney_id']   ?? '',
    tourneyName:       row['tourney_name'] ?? '',
    surface:           row['surface']      ?? 'Hard',
    tourneyLevel:      row['tourney_level'] ?? '',
    tourneyDate:       row['tourney_date'] ?? '',
    winnerId:          row['winner_id']    ?? '',
    winnerName:        row['winner_name']  ?? '',
    winnerAge:         parseNum(row['winner_age']),
    winnerRank:        parseNum(row['winner_rank']),
    winnerRankPoints:  parseNum(row['winner_rank_points']),
    loserId:           row['loser_id']     ?? '',
    loserName:         row['loser_name']   ?? '',
    loserAge:          parseNum(row['loser_age']),
    loserRank:         parseNum(row['loser_rank']),
    loserRankPoints:   parseNum(row['loser_rank_points']),
    score:             row['score']        ?? '',
    bestOf:            parseNum(row['best_of']) || 3,
    round:             row['round']        ?? '',
    minutes:           parseNum(row['minutes']),
    wAce:    parseNum(row['w_ace']),    wDf:   parseNum(row['w_df']),
    wSvpt:   parseNum(row['w_svpt']),  w1stIn: parseNum(row['w_1stIn']),
    w1stWon: parseNum(row['w_1stWon']), w2ndWon: parseNum(row['w_2ndWon']),
    wSvGms:  parseNum(row['w_SvGms']), wBpSaved: parseNum(row['w_bpSaved']),
    wBpFaced: parseNum(row['w_bpFaced']),
    lAce:    parseNum(row['l_ace']),    lDf:   parseNum(row['l_df']),
    lSvpt:   parseNum(row['l_svpt']),  l1stIn: parseNum(row['l_1stIn']),
    l1stWon: parseNum(row['l_1stWon']), l2ndWon: parseNum(row['l_2ndWon']),
    lSvGms:  parseNum(row['l_SvGms']), lBpSaved: parseNum(row['l_bpSaved']),
    lBpFaced: parseNum(row['l_bpFaced']),
  };
}

/** Load all matches from a single Sackmann CSV file. */
export function loadSackmannFile(filePath: string): SackmannMatch[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parse(content, { columns: true, skip_empty_lines: true, relax_quotes: true }) as Record<string, string>[];
  return rows.map(parseRow).filter(m => m.winnerId && m.loserId);
}

/** Load all ATP or WTA matches for a year range. */
export function loadMatchesForYears(
  gender: 'atp' | 'wta',
  startYear: number,
  endYear: number = new Date().getFullYear()
): SackmannMatch[] {
  const dataDir = gender === 'atp' ? ATP_DATA_DIR : WTA_DATA_DIR;
  const prefix  = gender === 'atp' ? 'atp_matches_' : 'wta_matches_';

  const allMatches: SackmannMatch[] = [];

  for (let year = startYear; year <= endYear; year++) {
    const filePath = path.join(dataDir, `${prefix}${year}.csv`);
    if (!fs.existsSync(filePath)) {
      // Try alternate naming
      const alt = path.join(dataDir, `${prefix.replace('_matches_', '_matches')}${year}.csv`);
      if (!fs.existsSync(alt)) {
        console.warn(`  Missing: ${filePath}`);
        continue;
      }
    }
    const fp = fs.existsSync(path.join(dataDir, `${prefix}${year}.csv`))
      ? path.join(dataDir, `${prefix}${year}.csv`)
      : path.join(dataDir, `${prefix.replace('_matches_', '_matches')}${year}.csv`);
    try {
      const matches = loadSackmannFile(fp);
      allMatches.push(...matches);
      console.log(`  Loaded ${matches.length} matches from ${year} (${gender.toUpperCase()})`);
    } catch (e: any) {
      console.warn(`  Error loading ${fp}: ${e.message}`);
    }
  }

  // Sort chronologically
  allMatches.sort((a, b) => a.tourneyDate.localeCompare(b.tourneyDate));
  return allMatches;
}

// ─── Derived Statistics ───────────────────────────────────────────────────────

export interface ServeReturnStats {
  aceRate: number;
  dfRate: number;
  firstServePct: number;
  firstServeWonPct: number;
  secondServeWonPct: number;
  serviceGamesWonPct: number;
  returnGamesWonPct: number;
  bpConvertedPct: number;
  bpSavedPct: number;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function computeServeStats(matches: SackmannMatch[], playerId: string): ServeReturnStats {
  // Accumulate stats where this player won or lost
  let ace=0, df=0, svpt=0, fstIn=0, fstWon=0, sndWon=0, svGms=0, bpSaved=0, bpFaced=0;
  let returnGmsWon=0, returnGmsPlayed=0, bpConv=0, bpOpp=0;

  for (const m of matches) {
    const isWinner = m.winnerId === playerId;
    const isLoser  = m.loserId  === playerId;
    if (!isWinner && !isLoser) continue;

    if (isWinner) {
      ace += m.wAce; df += m.wDf; svpt += m.wSvpt;
      fstIn += m.w1stIn; fstWon += m.w1stWon; sndWon += m.w2ndWon;
      svGms += m.wSvGms; bpSaved += m.wBpSaved; bpFaced += m.wBpFaced;
      // Opponent's serve games = this player's return games
      returnGmsWon += (m.lSvGms - m.lBpSaved + m.lBpFaced - m.lBpSaved); // simplified
      returnGmsPlayed += m.lSvGms;
      bpConv += (m.lBpFaced - m.lBpSaved);
      bpOpp  += m.lBpFaced;
    } else {
      ace += m.lAce; df += m.lDf; svpt += m.lSvpt;
      fstIn += m.l1stIn; fstWon += m.l1stWon; sndWon += m.l2ndWon;
      svGms += m.lSvGms; bpSaved += m.lBpSaved; bpFaced += m.lBpFaced;
      returnGmsWon += (m.wSvGms - m.wBpSaved + m.wBpFaced - m.wBpSaved); // simplified
      returnGmsPlayed += m.wSvGms;
      bpConv += (m.wBpFaced - m.wBpSaved);
      bpOpp  += m.wBpFaced;
    }
  }

  const sndSvpt = svpt - fstIn;
  return {
    aceRate:             safeDiv(ace, svGms),
    dfRate:              safeDiv(df, svGms),
    firstServePct:       safeDiv(fstIn, svpt),
    firstServeWonPct:    safeDiv(fstWon, fstIn),
    secondServeWonPct:   safeDiv(sndWon, sndSvpt),
    serviceGamesWonPct:  safeDiv(svGms - bpFaced + bpSaved, svGms),
    returnGamesWonPct:   safeDiv(returnGmsWon, Math.max(returnGmsPlayed, 1)),
    bpConvertedPct:      safeDiv(bpConv, bpOpp),
    bpSavedPct:          safeDiv(bpSaved, bpFaced),
  };
}

// ─── Grand Slam Specific Filters ─────────────────────────────────────────────

export function filterGrandSlams(matches: SackmannMatch[]): SackmannMatch[] {
  return matches.filter(m => isGrandSlam(m.tourneyName, m.tourneyLevel));
}

export function filterByTournament(matches: SackmannMatch[], name: string): SackmannMatch[] {
  const lower = name.toLowerCase();
  return matches.filter(m => m.tourneyName.toLowerCase().includes(lower));
}

export function filterBySurface(matches: SackmannMatch[], surface: string): SackmannMatch[] {
  return matches.filter(m => normalizeSurface(m.surface) === surface.toLowerCase());
}

export function filterRecentMonths(matches: SackmannMatch[], months: number): SackmannMatch[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');
  return matches.filter(m => m.tourneyDate >= cutoffStr);
}

// ─── Player Match History ─────────────────────────────────────────────────────

export function getPlayerMatches(
  matches: SackmannMatch[],
  playerId: string,
  limit?: number
): SackmannMatch[] {
  const result = matches.filter(m => m.winnerId === playerId || m.loserId === playerId);
  return limit ? result.slice(-limit) : result;
}

export function getRecentWinPct(
  matches: SackmannMatch[],
  playerId: string,
  last = 10
): number {
  const recent = getPlayerMatches(matches, playerId).slice(-last);
  if (recent.length === 0) return 0.5;
  const wins = recent.filter(m => m.winnerId === playerId).length;
  return wins / recent.length;
}

// ─── Data Download Helper ─────────────────────────────────────────────────────

export function checkDataExists(gender: 'atp' | 'wta'): boolean {
  const dataDir = gender === 'atp' ? ATP_DATA_DIR : WTA_DATA_DIR;
  return fs.existsSync(dataDir) && fs.readdirSync(dataDir).some(f => f.endsWith('.csv'));
}

export function printDataSetupInstructions(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║              SACKMANN DATA SETUP REQUIRED                        ║
╠══════════════════════════════════════════════════════════════════╣
║  Run these commands to download the Sackmann datasets:          ║
║                                                                  ║
║  mkdir -p data                                                   ║
║  cd data                                                         ║
║  git clone https://github.com/JeffSackmann/tennis_atp sackmann_atp
║  git clone https://github.com/JeffSackmann/tennis_wta sackmann_wta
║                                                                  ║
║  Or: the GitHub Actions workflow handles this automatically.    ║
╚══════════════════════════════════════════════════════════════════╝
  `);
}
