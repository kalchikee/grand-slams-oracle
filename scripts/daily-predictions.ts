/**
 * Daily predictions script — runs each morning during a Grand Slam.
 * Predicts all scheduled matches and sends a Discord embed.
 *
 * Usage: npm run daily-predictions
 *        npm run daily-predictions -- --tournament "Roland Garros" --year 2026 --dry-run
 *
 * Requires: DISCORD_WEBHOOK_URL, today's match schedule in DB or --schedule-file
 */

import { getCurrentSlam, getUpcomingSlam, TOURNAMENTS, getSlamDayLabel } from '../src/utils/tournament';
import { predictMatch } from '../src/pipeline/predict';
import { buildDailyPredictionsEmbed } from '../src/discord/embeds';
import { sendWebhook, getWebhookUrl } from '../src/discord/webhook';
import {
  getOrCreateAccuracy, savePrediction, getDraw, saveDraw, getDb,
} from '../src/db/database';
import { MatchContext } from '../src/pipeline/features';
import { MatchPrediction, DrawEntry } from '../src/types';
import { writePredictionsFile, SlamPickInput } from '../src/kalshi/predictionsFile';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const tournamentArg = args.find(a => a.startsWith('--tournament='))?.split('=').slice(1).join('=');
const yearArg       = parseInt(args.find(a => a.startsWith('--year='))?.split('=')[1] ?? '0');
const roundArg      = args.find(a => a.startsWith('--round='))?.split('=')[1];
const dryRun        = args.includes('--dry-run');

// ─── Sample Schedule (for testing) ───────────────────────────────────────────

// Seed list used to bootstrap a draw when the DB has none. Player IDs in the
// `players` table are Sackmann numeric IDs (e.g. "104925" = Djokovic), so
// looking up by slug fails and predictMatch falls back to a default Elo —
// producing 99% blowouts in the wrong direction. We look up each player by
// name against the actual players table; misses are dropped. Keeps
// daily-predictions usable when pre-tournament-sim never ran (the
// silent-failure path that killed Roland Garros 2026 Discord output).
function bootstrapSampleDraw(
  _tournamentName: string,
  _year: number,
  gender: 'mens' | 'womens',
): DrawEntry[] {
  const wantedNames = gender === 'mens' ? [
    'Novak Djokovic', 'Carlos Alcaraz', 'Jannik Sinner', 'Daniil Medvedev',
    'Alexander Zverev', 'Andrey Rublev', 'Holger Rune', 'Casper Ruud',
    'Tommy Paul', 'Grigor Dimitrov', 'Taylor Fritz', 'Alex De Minaur',
    'Stefanos Tsitsipas', 'Ben Shelton', 'Frances Tiafoe', 'Ugo Humbert',
  ] : [
    'Iga Swiatek', 'Aryna Sabalenka', 'Coco Gauff', 'Elena Rybakina',
    'Jessica Pegula', 'Marketa Vondrousova', 'Ons Jabeur', 'Caroline Garcia',
    'Karolina Muchova', 'Mirra Andreeva', 'Diana Shnaider', 'Emma Navarro',
    'Danielle Collins', 'Belinda Bencic', 'Anna Kalinskaya', 'Liudmila Samsonova',
  ];
  const db = getDb();
  const lookup = db.prepare(
    "SELECT player_id, name FROM players WHERE LOWER(REPLACE(name,'-',' ')) = LOWER(?) LIMIT 1"
  );
  const draw: DrawEntry[] = [];
  let drawPos = 1;
  for (const name of wantedNames) {
    const row = lookup.get(name) as { player_id: string; name: string } | undefined;
    if (!row) {
      console.log(`[bootstrap] WARN: ${name} not found in players table — skipping`);
      continue;
    }
    draw.push({
      playerId: row.player_id, playerName: row.name,
      seed: drawPos, drawPosition: drawPos++, gender,
    });
  }
  return draw;
}

function buildSampleSchedule(
  tournamentName: string,
  year: number,
  date: string,
  round: string
): MatchContext[] {
  // Pull seeded players from the draw to build realistic matchups.
  // If pre-tournament-sim never ran for this Slam, bootstrap a draw so daily
  // predictions still produce output instead of exiting silently.
  let mensDraw = getDraw(tournamentName, year, 'mens');
  let womensDraw = getDraw(tournamentName, year, 'womens');
  if (mensDraw.length === 0) {
    console.log(`[bootstrap] No men's draw in DB for ${tournamentName} ${year} — seeding fallback draw.`);
    mensDraw = bootstrapSampleDraw(tournamentName, year, 'mens');
    saveDraw(tournamentName, year, 'mens', mensDraw);
  }
  if (womensDraw.length === 0) {
    console.log(`[bootstrap] No women's draw in DB for ${tournamentName} ${year} — seeding fallback draw.`);
    womensDraw = bootstrapSampleDraw(tournamentName, year, 'womens');
    saveDraw(tournamentName, year, 'womens', womensDraw);
  }

  const schedule: MatchContext[] = [];
  const surface = TOURNAMENTS.find(t => t.name === tournamentName)?.surface ?? 'hard';

  // Pair players for the day. For a real 128-draw we'd use 1v128 / 2v127
  // (top-vs-bottom R1 spread). For the bootstrap-seed draw (≤16 known
  // players, no fillers) we instead pair from the ends of the seeded band
  // (1v16, 2v15, ...) so every prediction is between two real players —
  // pairing a seed against a placeholder produces 99% blowouts in the
  // wrong direction because the placeholder has no Elo entry.
  const addMatches = (draw: typeof mensDraw, gender: 'mens' | 'womens', limit = 8) => {
    const sorted = [...draw].sort((a, b) => a.drawPosition - b.drawPosition);
    for (let i = 0; i < Math.min(sorted.length / 2, limit); i++) {
      const a = sorted[i];
      const b = sorted[sorted.length - 1 - i];
      if (!a || !b) continue;
      schedule.push({
        tournament: tournamentName,
        year,
        surface,
        gender,
        round: round as any,
        date,
        playerAId: a.playerId,
        playerBId: b.playerId,
        playerASeed: a.seed,
        playerBSeed: b.seed,
      });
    }
  };

  addMatches(mensDraw,   'mens',   6);
  addMatches(womensDraw, 'womens', 6);

  return schedule;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Grand Slam Oracle — Daily Predictions  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const now = new Date();
  const year = yearArg || now.getFullYear();

  // Determine active tournament
  let tournament = TOURNAMENTS.find(t => t.name === tournamentArg);
  if (!tournament) {
    const active = getCurrentSlam(now);
    if (!active) {
      const upcoming = getUpcomingSlam(now);
      if (upcoming) {
        console.log(`No active Slam. Next: ${upcoming.name} in ${upcoming.daysUntil} days. Exiting.`);
      } else {
        console.log('No active or upcoming Slam found. Exiting.');
      }
      process.exit(0);
    }
    tournament = active;
  }

  const date = now.toISOString().slice(0, 10);
  const roundLabel = roundArg ?? getSlamDayLabel(tournament, now) ?? 'R64';
  const dayNum = getDayNumber(tournament, now, year);

  console.log(`Tournament: ${tournament.name} ${year}`);
  console.log(`Date:       ${date}`);
  console.log(`Round:      ${roundLabel}`);
  console.log(`Day:        ${dayNum}`);

  // ── Build schedule ─────────────────────────────────────────────────────
  // In production: fetch from ATP/WTA schedule API or read from a file
  const schedule = buildSampleSchedule(tournament.name, year, date, roundLabel);
  console.log(`\nMatches to predict: ${schedule.length}`);

  if (schedule.length === 0) {
    console.log('No matches scheduled.');
    if (!dryRun) {
      try {
        const webhookUrl = getWebhookUrl();
        await sendWebhook(webhookUrl, {
          username: 'Grand Slam Oracle',
          embeds: [{
            title: `⚠️ ${tournament.name} ${year} — no matches produced`,
            description:
              `Daily predictions ran for **${date}** (${roundLabel}) but produced 0 matches.\n\n` +
              'Possible causes: draw is empty AND fallback seed list is empty, or ' +
              '`predictMatch` rejected every pairing. Check the workflow log.',
            color: 0xE67E22,
            footer: { text: 'Grand Slam Oracle · daily-predictions' },
            timestamp: new Date().toISOString(),
          }],
        });
      } catch (err) {
        console.error('Failed to send empty-schedule alert:', err);
      }
    }
    process.exit(0);
  }

  // ── Generate predictions ───────────────────────────────────────────────
  const mensPreds: MatchPrediction[] = [];
  const womensPreds: MatchPrediction[] = [];
  const kalshiItems: SlamPickInput[] = [];

  for (const ctx of schedule) {
    const pred = predictMatch(ctx);
    if (ctx.gender === 'mens') mensPreds.push(pred);
    else womensPreds.push(pred);
    kalshiItems.push({ prediction: pred, context: ctx });

    // Save to database
    savePrediction({
      tournament: tournament.name,
      year,
      round: ctx.round,
      date,
      playerAId: ctx.playerAId,
      playerBId: ctx.playerBId,
      playerAWinProb: pred.playerAWinProb,
      featuresJson: JSON.stringify(pred.features),
      edgeVsOdds: pred.edgeVsOdds,
    });

    // Console output
    const favProb = Math.max(pred.playerAWinProb, 1 - pred.playerAWinProb);
    const favName = pred.playerAWinProb >= 0.5 ? pred.playerAName : pred.playerBName;
    const convTag = pred.isExtremeConviction ? ' 🔥' : pred.isHighConviction ? ' ⚡' : '';
    console.log(`  ${pred.playerAName} vs ${pred.playerBName} → ${favName} ${(favProb * 100).toFixed(0)}%${convTag}`);
  }

  // ── Write predictions JSON for kalshi-safety ──────────────────────────
  try {
    const jsonPath = writePredictionsFile(date, tournament.name, kalshiItems);
    console.log(`Wrote predictions JSON: ${jsonPath}`);
  } catch (err) {
    console.warn('Failed to write predictions JSON (non-fatal):', err);
  }

  // ── Accuracy record ────────────────────────────────────────────────────
  const accuracy = getOrCreateAccuracy(tournament.name, year);

  if (dryRun) {
    console.log('\n[dry-run] Skipping Discord send.');
    return;
  }

  // ── Send Discord embed ─────────────────────────────────────────────────
  console.log('\nSending predictions embed...');
  const webhookUrl = getWebhookUrl();

  const embeds = buildDailyPredictionsEmbed(
    tournament, year, dayNum, roundLabel,
    mensPreds, womensPreds, accuracy
  );

  await sendWebhook(webhookUrl, { username: 'Grand Slam Oracle', embeds });
  console.log('✅ Predictions sent!');
}

function getDayNumber(tournament: any, date: Date, year: number): number {
  const start = new Date(year, tournament.startMonth - 1, tournament.startDay);
  return Math.max(1, Math.floor((date.getTime() - start.getTime()) / 86400000) + 1);
}

main().catch(err => { console.error(err); process.exit(1); });
