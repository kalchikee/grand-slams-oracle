import { Tournament, Surface } from '../types';

// ─── Tournament Definitions ───────────────────────────────────────────────────

export const TOURNAMENTS: Tournament[] = [
  {
    name: 'Australian Open',
    shortName: 'AO',
    surface: 'hard',
    color: 0x003087, // Deep AO blue
    emoji: '🏆',
    startMonth: 1, startDay: 13,
    endMonth: 1,   endDay: 26,
  },
  {
    name: 'Roland Garros',
    shortName: 'RG',
    surface: 'clay',
    color: 0xC84B00, // Clay orange
    emoji: '🎾',
    startMonth: 5, startDay: 25,
    endMonth: 6,   endDay: 8,
  },
  {
    name: 'Wimbledon',
    shortName: 'WIM',
    surface: 'grass',
    color: 0x2D5F2D, // Wimbledon green
    emoji: '🌿',
    startMonth: 6, startDay: 30,
    endMonth: 7,   endDay: 13,
  },
  {
    name: 'US Open',
    shortName: 'USO',
    surface: 'hard',
    color: 0x1B5299, // USO blue
    emoji: '🗽',
    startMonth: 8, startDay: 25,
    endMonth: 9,   endDay: 7,
  },
];

// ─── Active Slam Detection ────────────────────────────────────────────────────

export function getCurrentSlam(date: Date = new Date()): Tournament | null {
  const year = date.getFullYear();
  for (const t of TOURNAMENTS) {
    const start = new Date(year, t.startMonth - 1, t.startDay);
    const end   = new Date(year, t.endMonth - 1,   t.endDay + 1); // inclusive
    if (date >= start && date < end) return t;
  }
  return null;
}

export function getUpcomingSlam(date: Date = new Date()): Tournament & { daysUntil: number } | null {
  const year = date.getFullYear();
  let nearest: { t: Tournament; diff: number } | null = null;

  for (const t of TOURNAMENTS) {
    // Try current year then next year
    for (const y of [year, year + 1]) {
      const start = new Date(y, t.startMonth - 1, t.startDay);
      const diff = Math.floor((start.getTime() - date.getTime()) / 86400000);
      if (diff > 0 && (nearest === null || diff < nearest.diff)) {
        nearest = { t, diff };
      }
    }
  }
  if (!nearest) return null;
  return { ...nearest.t, daysUntil: nearest.diff };
}

export function getPreTournamentDate(tournament: Tournament, year: number): Date {
  // 2 days before start
  const start = new Date(year, tournament.startMonth - 1, tournament.startDay);
  start.setDate(start.getDate() - 2);
  return start;
}

// ─── Slam Identification from Match Data ─────────────────────────────────────

const SLAM_NAME_MAP: Record<string, string> = {
  'australian open': 'Australian Open',
  'roland garros': 'Roland Garros',
  'french open': 'Roland Garros',
  'wimbledon': 'Wimbledon',
  'us open': 'US Open',
};

export function normalizeSlamName(raw: string): string | null {
  const lower = raw.toLowerCase();
  for (const [key, val] of Object.entries(SLAM_NAME_MAP)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

export function isGrandSlam(tourneyName: string, tourneyLevel?: string): boolean {
  if (tourneyLevel === 'G') return true;
  return normalizeSlamName(tourneyName) !== null;
}

export function surfaceFromSlam(slamName: string): Surface {
  const t = TOURNAMENTS.find(t => t.name === slamName);
  return t?.surface ?? 'hard';
}

// ─── Tournament Round Ordering ────────────────────────────────────────────────

export const ROUND_ORDER: Record<string, number> = {
  R128: 1, R64: 2, R32: 3, R16: 4, QF: 5, SF: 6, F: 7,
};

export function roundToLabel(round: string): string {
  const labels: Record<string, string> = {
    R128: 'Round of 128', R64: 'Round of 64', R32: 'Round of 32',
    R16: 'Round of 16', QF: 'Quarterfinal', SF: 'Semifinal', F: 'Final',
  };
  return labels[round] ?? round;
}

export function sackmannRoundToStandard(raw: string): string {
  const map: Record<string, string> = {
    'R128': 'R128', 'R64': 'R64', 'R32': 'R32', 'R16': 'R16',
    'QF': 'QF', 'SF': 'SF', 'F': 'F',
  };
  return map[raw] ?? raw;
}

// ─── Draw Quarter Assignment ──────────────────────────────────────────────────

export function drawPositionToQuarter(position: number): 1 | 2 | 3 | 4 {
  if (position <= 32) return 1;
  if (position <= 64) return 2;
  if (position <= 96) return 3;
  return 4;
}

// ─── Day Label ────────────────────────────────────────────────────────────────

export function getSlamDayLabel(slam: Tournament, date: Date): string {
  const year = date.getFullYear();
  const start = new Date(year, slam.startMonth - 1, slam.startDay);
  const dayNum = Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
  if (dayNum <= 0 || dayNum > 14) return '';
  const rounds: Record<number, string> = {
    1: 'R1', 2: 'R1', 3: 'R2', 4: 'R2',
    5: 'R3', 6: 'R3', 7: 'R4', 8: 'R4',
    9: 'QF', 10: 'QF', 11: 'SF', 12: 'SF',
    13: 'F (Women\'s)', 14: 'F (Men\'s)',
  };
  return rounds[dayNum] ?? '';
}
