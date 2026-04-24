/**
 * Pre-tournament bracket simulation.
 * Run 1–2 days before a Grand Slam starts, after the draw is released.
 *
 * Usage:
 *   npm run pre-tournament
 *   npm run pre-tournament -- --tournament "Roland Garros" --year 2026
 *
 * Requires: DISCORD_WEBHOOK_URL env variable
 *           Draw loaded into the database (or provided via --draw-file)
 */

import { getCurrentSlam, getUpcomingSlam, TOURNAMENTS } from '../src/utils/tournament';
import { simulateBracket, findDarkHorses, analyzeQuarters } from '../src/bracket-sim/simulator';
import {
  buildPreTournamentEmbed,
} from '../src/discord/embeds';
import { sendWebhook, getWebhookUrl } from '../src/discord/webhook';
import { getDraw, saveDraw, saveBracketSim } from '../src/db/database';
import { DrawEntry } from '../src/types';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const tournamentArg = args.find(a => a.startsWith('--tournament='))?.split('=').slice(1).join('=');
const yearArg       = parseInt(args.find(a => a.startsWith('--year='))?.split('=')[1] ?? '0');
const dryRun        = args.includes('--dry-run');
const numSims       = parseInt(args.find(a => a.startsWith('--sims='))?.split('=')[1] ?? '10000');

// ─── Sample Draw Generator (for testing without real draw data) ───────────────

function generateSampleDraw(tournament: string, year: number, gender: 'mens' | 'womens'): DrawEntry[] {
  const players = gender === 'mens' ? [
    { id: 'novak-djokovic', name: 'N. Djokovic' },
    { id: 'carlos-alcaraz', name: 'C. Alcaraz' },
    { id: 'jannik-sinner', name: 'J. Sinner' },
    { id: 'daniil-medvedev', name: 'D. Medvedev' },
    { id: 'alexander-zverev', name: 'A. Zverev' },
    { id: 'andrey-rublev', name: 'A. Rublev' },
    { id: 'holger-rune', name: 'H. Rune' },
    { id: 'casper-ruud', name: 'C. Ruud' },
    { id: 'tommy-paul', name: 'T. Paul' },
    { id: 'grigor-dimitrov', name: 'G. Dimitrov' },
    { id: 'taylor-fritz', name: 'T. Fritz' },
    { id: 'alex-de-minaur', name: 'A. de Minaur' },
    { id: 'stefanos-tsitsipas', name: 'S. Tsitsipas' },
    { id: 'ben-shelton', name: 'B. Shelton' },
    { id: 'frances-tiafoe', name: 'F. Tiafoe' },
    { id: 'ugo-humbert', name: 'U. Humbert' },
  ] : [
    { id: 'iga-swiatek', name: 'I. Swiatek' },
    { id: 'aryna-sabalenka', name: 'A. Sabalenka' },
    { id: 'coco-gauff', name: 'C. Gauff' },
    { id: 'elena-rybakina', name: 'E. Rybakina' },
    { id: 'jessica-pegula', name: 'J. Pegula' },
    { id: 'marketa-vondrousova', name: 'M. Vondrousova' },
    { id: 'ons-jabeur', name: 'O. Jabeur' },
    { id: 'caroline-garcia', name: 'C. Garcia' },
    { id: 'karolina-muchova', name: 'K. Muchova' },
    { id: 'mirra-andreeva', name: 'M. Andreeva' },
    { id: 'diana-shnaider', name: 'D. Shnaider' },
    { id: 'emma-navarro', name: 'E. Navarro' },
    { id: 'danielle-collins', name: 'D. Collins' },
    { id: 'belinda-bencic', name: 'B. Bencic' },
    { id: 'anna-kalinskaya', name: 'A. Kalinskaya' },
    { id: 'liudmila-samsonova', name: 'L. Samsonova' },
  ];

  // Fill to 32 with generic players for sample
  const draw: DrawEntry[] = [];
  for (let i = 0; i < 128; i++) {
    const seeded = i < players.length;
    const player = seeded ? players[i] : { id: `player-${i + 1}`, name: `Player ${i + 1}` };
    draw.push({
      playerId: player.id,
      playerName: player.name,
      seed: seeded ? i + 1 : null,
      drawPosition: i + 1,
      gender,
    });
  }
  return draw;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Grand Slam Oracle — Pre-Tournament     ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Determine which tournament
  const now = new Date();
  const year = yearArg || now.getFullYear();

  let tournament = TOURNAMENTS.find(t => t.name === tournamentArg);
  if (!tournament) {
    const upcoming = getUpcomingSlam(now);
    tournament = upcoming ?? TOURNAMENTS[1]; // default to Roland Garros
    console.log(`Auto-detected tournament: ${tournament.name}`);
  }

  console.log(`Tournament: ${tournament.name} ${year}`);
  console.log(`Surface:    ${tournament.surface}`);
  console.log(`Simulations: ${numSims.toLocaleString()}`);

  // ── Load or generate draw ──────────────────────────────────────────────
  let mensDraw = getDraw(tournament.name, year, 'mens');
  let womensDraw = getDraw(tournament.name, year, 'womens');

  if (mensDraw.length === 0) {
    console.log('\nNo draw in DB. Using sample draw for demonstration.');
    mensDraw   = generateSampleDraw(tournament.name, year, 'mens');
    womensDraw = generateSampleDraw(tournament.name, year, 'womens');
    // Save sample draws
    saveDraw(tournament.name, year, 'mens',   mensDraw);
    saveDraw(tournament.name, year, 'womens', womensDraw);
  }

  console.log(`\nMen's draw:   ${mensDraw.length} players`);
  console.log(`Women's draw: ${womensDraw.length} players`);

  // ── Run simulations ────────────────────────────────────────────────────
  console.log(`\nSimulating men's bracket (${numSims.toLocaleString()} runs)...`);
  const mensResults = simulateBracket(mensDraw, {
    numSims, surface: tournament.surface, gender: 'mens',
  });

  console.log(`Simulating women's bracket (${numSims.toLocaleString()} runs)...`);
  const womensResults = simulateBracket(womensDraw, {
    numSims, surface: tournament.surface, gender: 'womens',
  });

  // Save to database
  saveBracketSim(tournament.name, year, 'mens',   mensResults);
  saveBracketSim(tournament.name, year, 'womens', womensResults);

  // ── Analysis ───────────────────────────────────────────────────────────
  const darkHorsesMens   = findDarkHorses(mensResults);
  const darkHorsesWomens = findDarkHorses(womensResults);
  const quartersMens     = analyzeQuarters(mensResults);

  // Print summary to console
  console.log('\n── Men\'s Championship Odds (Top 10) ──');
  mensResults.slice(0, 10).forEach((r, i) =>
    console.log(`  ${i + 1}. ${r.playerName}${r.seed ? ` [${r.seed}]` : ''}: ${(r.championProb * 100).toFixed(1)}%`)
  );

  console.log('\n── Women\'s Championship Odds (Top 10) ──');
  womensResults.slice(0, 10).forEach((r, i) =>
    console.log(`  ${i + 1}. ${r.playerName}${r.seed ? ` [${r.seed}]` : ''}: ${(r.championProb * 100).toFixed(1)}%`)
  );

  if (dryRun) {
    console.log('\n[dry-run] Skipping Discord webhook send.');
    return;
  }

  // ── Send Discord embed ─────────────────────────────────────────────────
  console.log('\nSending Discord embed...');
  const webhookUrl = getWebhookUrl();

  const embeds = buildPreTournamentEmbed(
    tournament, year,
    mensResults, womensResults,
    darkHorsesMens, darkHorsesWomens,
    quartersMens, numSims
  );

  await sendWebhook(webhookUrl, {
    username: 'Grand Slam Oracle',
    embeds,
  });

  console.log('✅ Pre-tournament embed sent!');
}

main().catch(err => { console.error(err); process.exit(1); });
