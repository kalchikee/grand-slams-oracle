/**
 * Test the Discord webhook with a sample pre-tournament embed.
 * Uses sample data — no database required.
 *
 * Usage: npm run test-discord
 *        DISCORD_WEBHOOK_URL=<url> npx ts-node scripts/test-discord.ts
 */

import { TOURNAMENTS } from '../src/utils/tournament';
import { buildPreTournamentEmbed } from '../src/discord/embeds';
import { sendWebhook } from '../src/discord/webhook';
import { BracketSimResult, DarkHorse, QuarterAnalysis } from '../src/bracket-sim/simulator';

// ─── Sample Data ──────────────────────────────────────────────────────────────

function buildSampleMensResults(): BracketSimResult[] {
  const players = [
    { name: 'J. Sinner',     seed: 1,  champ: 0.28 },
    { name: 'C. Alcaraz',    seed: 2,  champ: 0.22 },
    { name: 'N. Djokovic',   seed: 3,  champ: 0.14 },
    { name: 'A. Zverev',     seed: 4,  champ: 0.09 },
    { name: 'D. Medvedev',   seed: 5,  champ: 0.07 },
    { name: 'A. Rublev',     seed: 6,  champ: 0.04 },
    { name: 'H. Rune',       seed: 7,  champ: 0.04 },
    { name: 'C. Ruud',       seed: 8,  champ: 0.03 },
    { name: 'T. Paul',       seed: 9,  champ: 0.02 },
    { name: 'G. Dimitrov',   seed: 10, champ: 0.02 },
    { name: 'T. Fritz',      seed: 11, champ: 0.015 },
    { name: 'S. Tsitsipas',  seed: 12, champ: 0.015 },
  ];

  return players.map((p, i) => ({
    playerId: p.name.replace(/[. ]/g, '-').toLowerCase(),
    playerName: p.name,
    seed: p.seed,
    championProb: p.champ,
    finalistProb: p.champ * 2.2,
    semifinalistProb: p.champ * 3.5,
    quarterfinalistProb: p.champ * 5,
    r16Prob: p.champ * 7,
    quarter: ([1, 3, 2, 4, 1, 3, 2, 4, 1, 3, 2, 4][i] as 1 | 2 | 3 | 4),
  }));
}

function buildSampleWomensResults(): BracketSimResult[] {
  const players = [
    { name: 'I. Swiatek',      seed: 1,  champ: 0.30 },
    { name: 'A. Sabalenka',    seed: 2,  champ: 0.20 },
    { name: 'C. Gauff',        seed: 3,  champ: 0.12 },
    { name: 'E. Rybakina',     seed: 4,  champ: 0.10 },
    { name: 'J. Pegula',       seed: 5,  champ: 0.06 },
    { name: 'O. Jabeur',       seed: 6,  champ: 0.05 },
    { name: 'M. Vondrousova',  seed: 7,  champ: 0.04 },
    { name: 'C. Garcia',       seed: 8,  champ: 0.03 },
    { name: 'M. Andreeva',     seed: 9,  champ: 0.025 },
    { name: 'D. Shnaider',     seed: 10, champ: 0.02 },
  ];

  return players.map((p, i) => ({
    playerId: p.name.replace(/[. ]/g, '-').toLowerCase(),
    playerName: p.name,
    seed: p.seed,
    championProb: p.champ,
    finalistProb: p.champ * 2.0,
    semifinalistProb: p.champ * 3.2,
    quarterfinalistProb: p.champ * 4.8,
    r16Prob: p.champ * 6.5,
    quarter: ([1, 3, 2, 4, 1, 3, 2, 4, 1, 3][i] as 1 | 2 | 3 | 4),
  }));
}

const darkHorsesMens: DarkHorse[] = [
  { playerName: 'B. Shelton', seed: 14, qfProb: 0.22, reason: 'Seed #14 with 22% QF probability' },
  { playerName: 'F. Tiafoe',  seed: 16, qfProb: 0.18, reason: 'Seed #16 with 18% QF probability' },
];

const quartersMens: QuarterAnalysis[] = [
  { quarter: 1, topSeeds: ['J. Sinner [1]', 'T. Fritz [11]'], avgChampProb: 0.30, label: 'Death Quarter' },
  { quarter: 2, topSeeds: ['C. Alcaraz [2]', 'H. Rune [7]'],  avgChampProb: 0.20, label: 'Strong' },
  { quarter: 3, topSeeds: ['N. Djokovic [3]', 'A. Rublev [6]'], avgChampProb: 0.15, label: 'Open' },
  { quarter: 4, topSeeds: ['A. Zverev [4]', 'C. Ruud [8]'],  avgChampProb: 0.10, label: 'Wide Open' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Sending test Discord embed...');

  // Use the provided webhook URL
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL
    ?? 'https://discord.com/api/webhooks/1492539369809252352/K7yGGwZhGu1Ru8uBZJt-2AcBHv_36_8U4J8q1lzq2__onfL4DUWWRVOrpMpTnLyXfVrn';

  const tournament = TOURNAMENTS[1]; // Roland Garros (next upcoming)
  const year = 2026;

  const mensResults   = buildSampleMensResults();
  const womensResults = buildSampleWomensResults();

  const embeds = buildPreTournamentEmbed(
    tournament, year,
    mensResults, womensResults,
    darkHorsesMens, [],
    quartersMens, 10000
  );

  await sendWebhook(webhookUrl, {
    username: 'Grand Slam Oracle',
    embeds,
  });

  console.log('✅ Test embed sent successfully!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
