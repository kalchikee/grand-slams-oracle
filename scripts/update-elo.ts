/**
 * Weekly Elo update — processes new ATP/WTA tour results and updates Elo ratings.
 * Runs as a background GitHub Actions cron (no Discord message sent).
 *
 * Usage: npm run update-elo
 */

import { loadMatchesForYears, checkDataExists } from '../src/utils/sackmann';
import {
  processMatchBatch, persistEloMap, normalizeSurface, RawMatchForElo,
} from '../src/elo/elo';
import { updateH2H, getDb, runTransaction } from '../src/db/database';

async function main(): Promise<void> {
  console.log('── Grand Slam Oracle: Weekly Elo Update ──');

  const currentYear = new Date().getFullYear();

  for (const gender of ['atp', 'wta'] as const) {
    if (!checkDataExists(gender)) {
      console.warn(`No ${gender.toUpperCase()} data found. Run init-elo first.`);
      continue;
    }

    // Only process current year's matches for efficiency
    console.log(`\nProcessing ${gender.toUpperCase()} ${currentYear}...`);
    const matches = loadMatchesForYears(gender, currentYear, currentYear);
    if (matches.length === 0) {
      console.log('  No new matches found.');
      continue;
    }

    const rawMatches: RawMatchForElo[] = matches.map(m => ({
      winnerId:    m.winnerId,
      winnerName:  m.winnerName,
      loserId:     m.loserId,
      loserName:   m.loserName,
      surface:     normalizeSurface(m.surface),
      date:        formatDate(m.tourneyDate),
      tourneyLevel: m.tourneyLevel,
    }));

    const eloMap = processMatchBatch(rawMatches);
    persistEloMap(eloMap);
    console.log(`  Updated ${eloMap.size} player Elo ratings.`);

    // Update H2H records
    runTransaction(() => {
      for (const m of matches) {
        updateH2H(m.winnerId, m.loserId, normalizeSurface(m.surface), formatDate(m.tourneyDate));
      }
    });
    console.log(`  Updated H2H records.`);
  }

  console.log('\n✅ Weekly Elo update complete. No Discord message sent (between Slams).');
}

function formatDate(d: string): string {
  if (d.length === 8) return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  return d;
}

main().catch(err => { console.error(err); process.exit(1); });
