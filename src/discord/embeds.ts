import { Tournament } from '../types';
import { BracketSimResult, DarkHorse, QuarterAnalysis } from '../bracket-sim/simulator';
import { MatchPrediction } from '../types';
import { AccuracyRecord } from '../types';
import { DiscordEmbed, EmbedField, truncate } from './webhook';

// ─── Medal Emojis ─────────────────────────────────────────────────────────────

const PLACE_EMOJI = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const SURFACE_EMOJI: Record<string, string> = {
  hard: '🔵', clay: '🟠', grass: '🟢',
};
const EDGE_EMOJI = (edge: number): string => {
  if (Math.abs(edge) >= 0.10) return '🚀';
  if (Math.abs(edge) >= 0.06) return '💡';
  return '';
};

// ─── Pre-Tournament Bracket Embed ─────────────────────────────────────────────

export function buildPreTournamentEmbed(
  tournament: Tournament,
  year: number,
  mensResults: BracketSimResult[],
  womensResults: BracketSimResult[],
  darkHorsesMens: DarkHorse[],
  darkHorsesWomens: DarkHorse[],
  quartersMens: QuarterAnalysis[],
  numSims: number
): DiscordEmbed[] {
  const embeds: DiscordEmbed[] = [];

  // ── Men's Embed ──────────────────────────────────────────────────────────
  const mensTop10 = mensResults.slice(0, 10);
  let mensOdds = mensTop10.map((r, i) =>
    `${PLACE_EMOJI[i] ?? `${i + 1}.`} **${r.playerName}**${r.seed ? ` [${r.seed}]` : ''}: **${(r.championProb * 100).toFixed(1)}%**`
  ).join('\n');

  const topQuarter = quartersMens.sort((a, b) => b.avgChampProb - a.avgChampProb)[0];
  const openestQuarter = quartersMens.sort((a, b) => a.avgChampProb - b.avgChampProb)[0];

  let darkHorseText = '';
  if (darkHorsesMens.length > 0) {
    darkHorseText = darkHorsesMens.map(d =>
      `• **${d.playerName}** — ${(d.qfProb * 100).toFixed(0)}% to reach QF despite seed #${d.seed}`
    ).join('\n');
  } else {
    darkHorseText = '*No major dark horses identified*';
  }

  embeds.push({
    title: `${tournament.emoji} Grand Slam Oracle — ${tournament.name} ${year} Men's Draw`,
    description: truncate(
      `**128-player draw simulated ${numSims.toLocaleString()} times**\n\n` +
      `**${SURFACE_EMOJI[tournament.surface]} Surface:** ${tournament.surface.charAt(0).toUpperCase() + tournament.surface.slice(1)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏆 **CHAMPIONSHIP ODDS — Top 10**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n` +
      mensOdds,
      4096
    ),
    color: tournament.color,
    fields: [
      {
        name: '🔥 Toughest Quarter',
        value: `**Q${topQuarter?.quarter}** — ${topQuarter?.label}\n${topQuarter?.topSeeds.join(', ')}`,
        inline: true,
      },
      {
        name: '🟢 Most Open Quarter',
        value: `**Q${openestQuarter?.quarter}** — ${openestQuarter?.label}`,
        inline: true,
      },
      {
        name: '🎯 Dark Horses',
        value: darkHorseText,
        inline: false,
      },
      {
        name: '📊 Finalist Odds (Top 4)',
        value: mensResults.slice(0, 4).map(r =>
          `${r.playerName}: Final ${(r.finalistProb * 100).toFixed(0)}% | SF ${(r.semifinalistProb * 100).toFixed(0)}%`
        ).join('\n'),
        inline: false,
      },
    ],
    footer: {
      text: `Based on ${numSims.toLocaleString()} bracket simulations | Surface: ${tournament.surface} | Grand Slam Oracle v4.1`,
    },
    timestamp: new Date().toISOString(),
  });

  // ── Women's Embed ────────────────────────────────────────────────────────
  const womensTop10 = womensResults.slice(0, 10);
  let womensOdds = womensTop10.map((r, i) =>
    `${PLACE_EMOJI[i] ?? `${i + 1}.`} **${r.playerName}**${r.seed ? ` [${r.seed}]` : ''}: **${(r.championProb * 100).toFixed(1)}%**`
  ).join('\n');

  let wDarkHorseText = darkHorsesWomens.length > 0
    ? darkHorsesWomens.map(d =>
        `• **${d.playerName}** — ${(d.qfProb * 100).toFixed(0)}% to reach QF despite seed #${d.seed}`
      ).join('\n')
    : '*No major dark horses identified*';

  embeds.push({
    title: `${tournament.emoji} Grand Slam Oracle — ${tournament.name} ${year} Women's Draw`,
    description: truncate(
      `**${SURFACE_EMOJI[tournament.surface]} Surface:** ${tournament.surface.charAt(0).toUpperCase() + tournament.surface.slice(1)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏆 **CHAMPIONSHIP ODDS — Top 10**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n` +
      womensOdds,
      4096
    ),
    color: tournament.color,
    fields: [
      {
        name: '🎯 Dark Horses',
        value: wDarkHorseText,
        inline: false,
      },
      {
        name: '📊 Finalist Odds (Top 4)',
        value: womensResults.slice(0, 4).map(r =>
          `${r.playerName}: Final ${(r.finalistProb * 100).toFixed(0)}% | SF ${(r.semifinalistProb * 100).toFixed(0)}%`
        ).join('\n'),
        inline: false,
      },
    ],
    footer: {
      text: `${numSims.toLocaleString()} simulations | Grand Slam Oracle v4.1`,
    },
    timestamp: new Date().toISOString(),
  });

  return embeds;
}

// ─── Daily Match Predictions Embed ───────────────────────────────────────────

export function buildDailyPredictionsEmbed(
  tournament: Tournament,
  year: number,
  dayNum: number,
  roundLabel: string,
  mensPredictions: MatchPrediction[],
  womensPredictions: MatchPrediction[],
  accuracy: AccuracyRecord
): DiscordEmbed[] {
  const embeds: DiscordEmbed[] = [];
  const accPct = accuracy.totalPredictions > 0
    ? ((accuracy.correctPredictions / accuracy.totalPredictions) * 100).toFixed(1)
    : '—';
  const highConvPct = accuracy.highConvTotal > 0
    ? ((accuracy.highConvCorrect / accuracy.highConvTotal) * 100).toFixed(1)
    : '—';

  const header = `🏆 **Slam Record**: ${accuracy.correctPredictions}-${accuracy.totalPredictions - accuracy.correctPredictions} (${accPct}%)  |  🎯 **High Conviction**: ${accuracy.highConvCorrect}-${accuracy.highConvTotal - accuracy.highConvCorrect} (${highConvPct}%)`;

  // Build match prediction fields
  const buildMatchFields = (preds: MatchPrediction[], label: string): EmbedField[] => {
    if (preds.length === 0) return [];
    const fields: EmbedField[] = [];

    let matchLines = '';
    for (const p of preds) {
      const favProb = Math.max(p.playerAWinProb, 1 - p.playerAWinProb);
      const favName = p.playerAWinProb >= 0.5 ? p.playerAName : p.playerBName;
      const undName = p.playerAWinProb >= 0.5 ? p.playerBName : p.playerAName;
      const undProb = 1 - favProb;
      const isUpset = favProb < 0.60;
      const convIcon = p.isExtremeConviction ? '🔥' : p.isHighConviction ? '⚡' : '';
      const upsetIcon = isUpset ? '🔴' : '';
      const edgeIcon = p.edgeVsOdds !== undefined ? EDGE_EMOJI(p.edgeVsOdds) : '';

      const h2h = (() => {
        const { getH2H } = require('../db/database');
        const h = getH2H(p.playerAId, p.playerBId, 'all');
        const total = h.winsA + h.winsB;
        if (total === 0) return 'No H2H';
        return `H2H: ${h.winsA}-${h.winsB}`;
      })();

      const surEloA = (() => {
        const { getPlayerElo } = require('../db/database');
        const e = getPlayerElo(p.playerAId);
        return e ? Math.round(e[p.surface]).toString() : '?';
      })();
      const surEloB = (() => {
        const { getPlayerElo } = require('../db/database');
        const e = getPlayerElo(p.playerBId);
        return e ? Math.round(e[p.surface]).toString() : '?';
      })();

      const line = [
        `${upsetIcon}${convIcon} **${p.playerAName}** vs **${p.playerBName}**`,
        `  → Pick: **${favName}** (${(favProb * 100).toFixed(0)}%) ${edgeIcon}`,
        `  ${p.surface} Elo: ${surEloA} vs ${surEloB} | ${h2h}`,
        '',
      ].join('\n');

      if ((matchLines + line).length < 900) {
        matchLines += line;
      } else {
        fields.push({ name: label, value: truncate(matchLines, 1024), inline: false });
        matchLines = line;
        label = '(continued)';
      }
    }
    if (matchLines) {
      fields.push({ name: label, value: truncate(matchLines, 1024), inline: false });
    }
    return fields;
  };

  const mensFields  = buildMatchFields(mensPredictions,   `🎾 Men's — ${roundLabel}`);
  const womensFields = buildMatchFields(womensPredictions, `🎾 Women's — ${roundLabel}`);

  embeds.push({
    title: `${tournament.emoji} ${tournament.name} ${year} — Day ${dayNum} (${roundLabel}) Predictions`,
    description: truncate(header, 4096),
    color: tournament.color,
    fields: [
      ...mensFields,
      ...womensFields,
    ].slice(0, 25),
    footer: {
      text: `Grand Slam Oracle v4.1 | 🔥=80%+ conviction | ⚡=70%+ | 🔴=potential upset | 💡=value bet`,
    },
    timestamp: new Date().toISOString(),
  });

  return embeds;
}

// ─── Daily Recap Embed ────────────────────────────────────────────────────────

export interface RecapResult {
  playerAName: string;
  playerBName: string;
  playerAWinProb: number;
  actualWinnerName: string;
  correct: boolean;
  edgeVsOdds?: number;
}

export function buildRecapEmbed(
  tournament: Tournament,
  year: number,
  dayNum: number,
  roundLabel: string,
  results: RecapResult[],
  updatedChampionOdds: BracketSimResult[],
  accuracy: AccuracyRecord
): DiscordEmbed[] {
  const embeds: DiscordEmbed[] = [];

  const correct   = results.filter(r => r.correct).length;
  const incorrect = results.length - correct;
  const dayPct    = results.length > 0 ? ((correct / results.length) * 100).toFixed(0) : '—';

  // Build results text
  let resultsText = '';
  for (const r of results) {
    const icon = r.correct ? '✅' : '❌';
    const favName = r.playerAWinProb >= 0.5 ? r.playerAName : r.playerBName;
    const favProb = Math.max(r.playerAWinProb, 1 - r.playerAWinProb);
    resultsText += `${icon} **${r.actualWinnerName}** def. ${r.playerAWinProb >= 0.5 ? r.playerBName : r.playerAName}` +
      ` (${(favProb * 100).toFixed(0)}% pick: ${favName})\n`;
  }

  // Updated champion odds (top 6)
  const updatedOdds = updatedChampionOdds.slice(0, 6).map((r, i) =>
    `${PLACE_EMOJI[i] ?? `${i + 1}.`} ${r.playerName}: **${(r.championProb * 100).toFixed(1)}%**`
  ).join('\n');

  const totalAcc = accuracy.totalPredictions > 0
    ? `${accuracy.correctPredictions}-${accuracy.totalPredictions - accuracy.correctPredictions} (${((accuracy.correctPredictions / accuracy.totalPredictions) * 100).toFixed(1)}%)`
    : '—';

  embeds.push({
    title: `${tournament.emoji} ${tournament.name} ${year} — Day ${dayNum} Recap`,
    description: truncate(
      `**Day ${dayNum} record: ${correct}-${incorrect} (${dayPct}%)**\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n` +
      resultsText,
      4096
    ),
    color: tournament.color,
    fields: [
      {
        name: '📊 Running Slam Record',
        value: `Match Winner: **${totalAcc}**\nHigh Conv (70%+): **${accuracy.highConvCorrect}-${accuracy.highConvTotal - accuracy.highConvCorrect}**\nValue Bets ROI: **${accuracy.valueBetsProfit >= 0 ? '+' : ''}${accuracy.valueBetsProfit.toFixed(2)}u**`,
        inline: true,
      },
      {
        name: '🏆 Updated Championship Odds',
        value: updatedOdds || '*No updated odds*',
        inline: true,
      },
    ],
    footer: { text: 'Grand Slam Oracle v4.1' },
    timestamp: new Date().toISOString(),
  });

  return embeds;
}

// ─── Post-Tournament Summary Embed ───────────────────────────────────────────

export function buildPostTournamentEmbed(
  tournament: Tournament,
  year: number,
  champion: string,
  preTournamentOdds: BracketSimResult[],
  accuracy: AccuracyRecord
): DiscordEmbed {
  const champEntry = preTournamentOdds.find(r =>
    r.playerName.toLowerCase().includes(champion.toLowerCase())
  );
  const champPreOdds = champEntry
    ? `Pre-tournament odds: **${(champEntry.championProb * 100).toFixed(1)}%** (ranked #${preTournamentOdds.indexOf(champEntry) + 1})`
    : 'Champion was not in initial top predictions';

  const totalAcc = accuracy.totalPredictions > 0
    ? `${accuracy.correctPredictions}-${accuracy.totalPredictions - accuracy.correctPredictions} (${((accuracy.correctPredictions / accuracy.totalPredictions) * 100).toFixed(1)}%)`
    : 'No predictions recorded';

  const hcAcc = accuracy.highConvTotal > 0
    ? `${accuracy.highConvCorrect}-${accuracy.highConvTotal - accuracy.highConvCorrect} (${((accuracy.highConvCorrect / accuracy.highConvTotal) * 100).toFixed(1)}%)`
    : '—';

  return {
    title: `🏆 ${tournament.name} ${year} — Final Summary`,
    description: truncate(
      `**Champion: ${champion}** 🎾\n${champPreOdds}\n\n` +
      preTournamentOdds.slice(0, 5).map((r, i) =>
        `${PLACE_EMOJI[i]} ${r.playerName}: predicted ${(r.championProb * 100).toFixed(1)}%`
      ).join('\n'),
      4096
    ),
    color: tournament.color,
    fields: [
      { name: '📊 Match Accuracy',       value: totalAcc, inline: true },
      { name: '🎯 High Conviction',       value: hcAcc,   inline: true },
      { name: '💰 Value Bets ROI',
        value: `${accuracy.valueBetsProfit >= 0 ? '+' : ''}${accuracy.valueBetsProfit.toFixed(2)} units (${accuracy.valueBetsTotal} bets)`,
        inline: true },
      { name: '🏅 Semifinalist Prediction',
        value: `${accuracy.highConvCorrect} of 4 semifinalists correctly predicted`,
        inline: false },
    ],
    footer: { text: 'Grand Slam Oracle v4.1' },
    timestamp: new Date().toISOString(),
  };
}
