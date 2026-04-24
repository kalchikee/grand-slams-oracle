/**
 * Initialize Elo ratings from Jeff Sackmann's historical match data (2010–present).
 * Run once to bootstrap the database, then use update-elo.ts for incremental updates.
 *
 * Usage:  npm run init-elo
 *         npm run init-elo -- --start-year 2015 --gender atp
 */

import {
  loadMatchesForYears,
  checkDataExists,
  printDataSetupInstructions,
  computeServeStats,
  getPlayerMatches,
  filterGrandSlams,
} from '../src/utils/sackmann';
import {
  processMatchBatch,
  persistEloMap,
  normalizeSurface,
  RawMatchForElo,
} from '../src/elo/elo';
import {
  upsertPlayerStats,
  updateH2H,
  getDb,
  runTransaction,
} from '../src/db/database';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const startYear = parseInt(args.find(a => a.startsWith('--start-year='))?.split('=')[1] ?? '2010');
const genderArg = (args.find(a => a.startsWith('--gender='))?.split('=')[1] ?? 'both') as 'atp' | 'wta' | 'both';
const skipStats = args.includes('--skip-stats');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Grand Slam Oracle — Elo Init         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const genders: ('atp' | 'wta')[] = genderArg === 'both' ? ['atp', 'wta'] : [genderArg];

  for (const gender of genders) {
    console.log(`\n── Processing ${gender.toUpperCase()} (${startYear}–present) ──`);

    if (!checkDataExists(gender)) {
      printDataSetupInstructions();
      process.exit(1);
    }

    const endYear = new Date().getFullYear();
    console.log(`Loading matches...`);
    const matches = loadMatchesForYears(gender, startYear, endYear);
    console.log(`Total matches loaded: ${matches.length.toLocaleString()}`);

    // ── Elo Processing ────────────────────────────────────────────────────
    const rawMatches: RawMatchForElo[] = matches.map(m => ({
      winnerId:    m.winnerId,
      winnerName:  m.winnerName,
      loserId:     m.loserId,
      loserName:   m.loserName,
      surface:     normalizeSurface(m.surface),
      date:        formatDate(m.tourneyDate),
      tourneyLevel: m.tourneyLevel,
    }));

    console.log(`\nComputing Elo ratings (${rawMatches.length.toLocaleString()} matches)...`);
    const eloMap = processMatchBatch(rawMatches, (i, total) => {
      if (i % 5000 === 0) process.stdout.write(`\r  Progress: ${i.toLocaleString()} / ${total.toLocaleString()}`);
    });
    console.log(`\n  Done. ${eloMap.size} unique players.`);

    console.log(`Persisting Elo ratings to database...`);
    persistEloMap(eloMap);
    console.log(`  Done.`);

    // ── H2H Records ───────────────────────────────────────────────────────
    console.log(`Building H2H records...`);
    const db = getDb();
    runTransaction(() => {
      let count = 0;
      for (const m of matches) {
        const date = formatDate(m.tourneyDate);
        updateH2H(m.winnerId, m.loserId, normalizeSurface(m.surface), date);
        if (++count % 10000 === 0) process.stdout.write(`\r  H2H: ${count.toLocaleString()}`);
      }
    });
    console.log(`\n  H2H records built.`);

    // ── Player Stats ──────────────────────────────────────────────────────
    if (!skipStats) {
      console.log(`Computing serve/return stats (last 12 months of available data)...`);
      // Use last available match date as anchor, not today (data may lag current date)
      const sorted = [...matches].sort((a, b) => b.tourneyDate.localeCompare(a.tourneyDate));
      const latestDate = sorted[0]?.tourneyDate ?? '20241231';
      const latestYear  = parseInt(latestDate.slice(0, 4));
      const latestMonth = parseInt(latestDate.slice(4, 6));
      const cutoffYear  = latestMonth >= 1 ? latestYear - 1 : latestYear - 2;
      const cutoffStr   = `${cutoffYear}${latestDate.slice(4, 6)}${latestDate.slice(6, 8)}`;
      console.log(`  Using cutoff: ${cutoffStr} (latest data: ${latestDate})`);
      const recentMatches = matches.filter(m => m.tourneyDate >= cutoffStr);

      // Grand Slam experience
      const slamMatches = filterGrandSlams(matches);
      const slamTitlesMap = new Map<string, number>();
      slamMatches
        .filter(m => m.round === 'F')
        .forEach(m => slamTitlesMap.set(m.winnerId, (slamTitlesMap.get(m.winnerId) ?? 0) + 1));

      const playerIds = Array.from(eloMap.keys());
      let statsCount = 0;

      for (const pid of playerIds) {
        const elo = eloMap.get(pid)!;
        const playerRecentMatches = getPlayerMatches(recentMatches, pid);
        if (playerRecentMatches.length === 0) continue;

        const stats = computeServeStats(playerRecentMatches, pid);
        const recentWins = playerRecentMatches.filter(m => m.winnerId === pid).length;
        const slamExp = slamMatches.filter(m => m.winnerId === pid || m.loserId === pid).length;
        const lastMatch = playerRecentMatches[playerRecentMatches.length - 1];

        upsertPlayerStats({
          playerId: pid,
          aceRate: stats.aceRate,
          dfRate:  stats.dfRate,
          firstServePct: stats.firstServePct,
          firstServeWonPct: stats.firstServeWonPct,
          secondServeWonPct: stats.secondServeWonPct,
          serviceGamesWonPct: stats.serviceGamesWonPct,
          returnGamesWonPct: stats.returnGamesWonPct,
          bpConvertedPct: stats.bpConvertedPct,
          bpSavedPct: stats.bpSavedPct,
          tiebreakWinPct: 0.50, // placeholder; computed separately
          recentWinPct: playerRecentMatches.length > 0 ? recentWins / playerRecentMatches.length : 0.5,
          recentSurfaceWinPct: 0.5, // computed per-surface in features
          slamExperience: slamExp,
          slamTitles: slamTitlesMap.get(pid) ?? 0,
          age: lastMatch
            ? (gender === 'atp' ? lastMatch.winnerAge || lastMatch.loserAge : lastMatch.winnerAge || lastMatch.loserAge)
            : 25,
        });

        if (++statsCount % 500 === 0) process.stdout.write(`\r  Stats: ${statsCount}`);
      }
      console.log(`\n  Player stats computed for ${statsCount} players.`);
    }

    // ── Grand Slam Match Records ──────────────────────────────────────────
    console.log(`Storing Grand Slam match records...`);
    const slamMatches = filterGrandSlams(matches);
    const stmtMatch = db.prepare(`
      INSERT OR IGNORE INTO matches
        (match_id, tournament, surface, round, date,
         player_a_id, player_b_id, winner_id, score, best_of,
         player_a_elo_pre, player_b_elo_pre, is_grand_slam)
      VALUES
        (@matchId, @tournament, @surface, @round, @date,
         @playerAId, @playerBId, @winnerId, @score, @bestOf,
         @playerAEloPre, @playerBEloPre, 1)
    `);
    runTransaction(() => {
      let c = 0;
      for (const m of slamMatches) {
        stmtMatch.run({
          matchId: `${m.tourneyId}_${m.round}_${m.winnerId}_${m.loserId}`,
          tournament: normalizeTourneyName(m.tourneyName),
          surface: normalizeSurface(m.surface),
          round: m.round,
          date: formatDate(m.tourneyDate),
          playerAId: m.winnerId,
          playerBId: m.loserId,
          winnerId: m.winnerId,
          score: m.score,
          bestOf: m.bestOf,
          playerAEloPre: 0,
          playerBEloPre: 0,
        });
        if (++c % 1000 === 0) process.stdout.write(`\r  Slams: ${c}`);
      }
    });
    console.log(`\n  ${slamMatches.length} Slam matches stored.`);
  }

  console.log('\n✅ Elo initialization complete!');
  console.log('   Next step: Run pre-tournament sim when draw is released.');
}

function formatDate(sackmannDate: string): string {
  // Sackmann dates are YYYYMMDD → ISO YYYY-MM-DD
  if (sackmannDate.length === 8) {
    return `${sackmannDate.slice(0, 4)}-${sackmannDate.slice(4, 6)}-${sackmannDate.slice(6, 8)}`;
  }
  return sackmannDate;
}

function normalizeTourneyName(name: string): string {
  const map: Record<string, string> = {
    'Australian Open': 'Australian Open',
    'Roland Garros': 'Roland Garros',
    'Wimbledon': 'Wimbledon',
    'US Open': 'US Open',
  };
  for (const [key, val] of Object.entries(map)) {
    if (name.includes(key)) return val;
  }
  return name;
}

main().catch(err => { console.error(err); process.exit(1); });
