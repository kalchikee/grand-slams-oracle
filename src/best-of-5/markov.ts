/**
 * Best-of-5 Set Amplification
 *
 * Grand Slam men's matches are best-of-5 sets, which amplifies the favorite's
 * advantage compared to best-of-3 (standard tour format).
 *
 * The Elo model is calibrated on tour data (primarily best-of-3).
 * This module converts those probabilities to best-of-5 probabilities.
 *
 * Method: extract implied set-win probability, then compute P(win 3 of 5 sets).
 */

// ─── Set-Level Conversion ────────────────────────────────────────────────────

/**
 * P(win best-of-3) = p_set^2 * (3 - 2*p_set)
 * Invert numerically to find p_set given p_bo3.
 */
export function bo3ProbToSetProb(p_bo3: number): number {
  if (p_bo3 === 0.5) return 0.5;
  if (p_bo3 >= 1) return 1;
  if (p_bo3 <= 0) return 0;

  // Binary search on [0, 1]
  let lo = 0, hi = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const est = bo3FromSetProb(mid);
    if (est < p_bo3) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(win best-of-3) from per-set win probability p. */
export function bo3FromSetProb(p: number): number {
  const q = 1 - p;
  return p * p * (3 - 2 * p);
  // Equivalent: p^2 + 2*p^2*q = p^2*(1 + 2q) = p^2*(3-2p)
}

/** P(win best-of-5) from per-set win probability p. */
export function bo5FromSetProb(p: number): number {
  const q = 1 - p;
  // P(3-0) + P(3-1) + P(3-2)
  // P(3-0) = p^3
  // P(3-1) = C(3,1) * p^3 * q = 3*p^3*q   (opponent wins 1 of first 3)
  // P(3-2) = C(4,2) * p^3 * q^2 = 6*p^3*q^2 (opponent wins 2 of first 4)
  return p * p * p * (1 + 3 * q + 6 * q * q);
}

/**
 * Convert a best-of-3 match win probability to best-of-5.
 * Used for men's Grand Slam matches.
 */
export function convertBo3ToBo5(p_bo3: number): number {
  if (p_bo3 === 0.5) return 0.5;
  const pSet = bo3ProbToSetProb(p_bo3);
  return bo5FromSetProb(pSet);
}

// ─── Full Markov Chain (Point → Game → Set → Match) ─────────────────────────
//
// For use when we have serve/return statistics directly.
// p_serve = P(win a point while serving)
// p_return = 1 - opponent's p_serve (on their service games)

/** P(win a game while serving) given P(win a point on serve) = p. */
export function gameWinProb(p: number): number {
  const q = 1 - p;
  // Non-deuce paths: 4-0, 4-1, 4-2
  const nonDeuce = Math.pow(p, 4) * (1 + 4 * q + 10 * q * q);
  // Deuce path: reach 3-3 (prob = C(6,3)*p^3*q^3 = 20*p^3*q^3), then win from deuce
  const pDeuce = 20 * Math.pow(p, 3) * Math.pow(q, 3);
  const pWinFromDeuce = (p * p) / (p * p + q * q);
  return nonDeuce + pDeuce * pWinFromDeuce;
}

/**
 * P(win a set) given:
 * - p_sg = P(player wins their service game)
 * - p_rg = P(player wins opponent's service game)  [= 1 - P(opp wins service game)]
 * Assumes tiebreak at 6-6 (standard for most Slams).
 */
export function setWinProb(p_sg: number, p_rg: number): number {
  // In a set, games alternate serve. We model probabilistically:
  // P(win a game) alternates between p_sg and p_rg per service game.
  // Use a Markov chain on set scores [0-0 through 7-6].
  // States: (i, j) = games won by player vs opponent, with tiebreak at 6-6.

  const N = 8; // 0 through 7
  // dp[i][j] = P(player reaches this score)
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
  dp[0][0] = 1;

  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      if (dp[i][j] === 0) continue;
      const total = i + j;
      // Determine whose serve it is (simplified: alternates each game)
      // In real tennis serve alternates but for sim purposes:
      const serverWinProb = total % 2 === 0 ? p_sg : p_rg;

      // Check if we're at 6-6 (tiebreak)
      if (i === 6 && j === 6) {
        // Tiebreak: use serve/return average
        const tbProb = (p_sg + p_rg) / 2;
        dp[7][6] += dp[i][j] * tbProb;
        dp[6][7] += dp[i][j] * (1 - tbProb);
        continue;
      }

      // Normal game
      if (i < 6 || j < 6 || Math.abs(i - j) < 2) {
        if (!(i === 6 && j < 5) && !(j === 6 && i < 5)) {
          dp[i + 1][j] += dp[i][j] * serverWinProb;
          dp[i][j + 1] += dp[i][j] * (1 - serverWinProb);
        }
      }
    }
  }

  // Sum all terminal states where player wins set (i > j and i >= 6)
  let pWin = 0;
  for (let i = 6; i <= 7; i++) {
    for (let j = 0; j <= 6; j++) {
      if (i > j && !(i === 6 && j === 6)) {
        pWin += dp[i][j];
      }
    }
  }
  // 7-6 tiebreak win
  pWin += dp[7][6];

  return Math.max(0, Math.min(1, pWin));
}

/**
 * Full point-to-match conversion.
 * Given serve and return point win probabilities, compute P(win match) for best-of-5.
 */
export function pointWinProbToMatchProb(
  p_serve: number,   // P(win point on own serve)
  p_return: number,  // P(win point on opponent's serve)
  bestOf: 3 | 5
): number {
  const pServeGame  = gameWinProb(p_serve);
  const pReturnGame = gameWinProb(p_return);

  const pSetWin = setWinProb(pServeGame, pReturnGame);

  if (bestOf === 3) return bo3FromSetProb(pSetWin);
  return bo5FromSetProb(pSetWin);
}

// ─── Elo → Point Win Probability ────────────────────────────────────────────

/**
 * Approximate the underlying point-win probability on serve from Elo match probability.
 * Uses an empirical calibration:
 * - Average ATP server wins ~63% of points on serve
 * - At equal Elo (p=0.5 match), both players win ~63% of points on their serve
 * - Elo difference shifts the effective serve/return percentages
 */
export function eloMatchProbToServeReturnProbs(
  matchWinProb: number,
  baseServeWinPct: number = 0.63 // ATP average; WTA ≈ 0.59
): { pServe: number; pReturn: number } {
  if (matchWinProb === 0.5) {
    return { pServe: baseServeWinPct, pReturn: 1 - baseServeWinPct };
  }

  // Binary search: find pServe such that pointWinProbToMatchProb matches matchWinProb
  let lo = 0.5, hi = 0.9;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const pReturn = 1 - (baseServeWinPct + (baseServeWinPct - mid)); // symmetric shift
    const est = pointWinProbToMatchProb(mid, pReturn, 3);
    if (est < matchWinProb) lo = mid;
    else hi = mid;
  }
  const pServe = (lo + hi) / 2;
  const pReturn = 1 - (baseServeWinPct + (baseServeWinPct - pServe));
  return { pServe, pReturn };
}

// ─── Primary Export ───────────────────────────────────────────────────────────

/**
 * Apply best-of-5 amplification to an Elo-derived match probability.
 * For men's Grand Slams only (women's play best-of-3).
 *
 * @param p_bo3  Match win probability calibrated to best-of-3 tour results
 * @param gender 'mens' applies bo5 amplification, 'womens' returns p unchanged
 * @returns      Adjusted match win probability for the Grand Slam format
 */
export function amplifyForGrandSlam(p_bo3: number, gender: 'mens' | 'womens'): number {
  if (gender === 'womens') return p_bo3;
  return convertBo3ToBo5(p_bo3);
}

// ─── Verification ─────────────────────────────────────────────────────────────
//
// Sanity check: "a player with 60% point-win prob wins ~73% BO3, ~81% BO5"
// p_serve ≈ 0.60 (simplified, treating as overall point prob)
// bo3FromSetProb(0.60) ≈ 0.648 -- note plan is referring to point, not set probability
// The plan uses a simplified framing; our set-level conversion is more precise.

export function verifySanityChecks(): void {
  // Example from plan: p_bo3 = 0.73 → p_bo5 ≈ 0.81
  const p = convertBo3ToBo5(0.73);
  console.log(`BO3=0.73 → BO5=${p.toFixed(3)} (expect ≈0.81)`);

  const p2 = convertBo3ToBo5(0.60);
  console.log(`BO3=0.60 → BO5=${p2.toFixed(3)}`);

  const p3 = convertBo3ToBo5(0.90);
  console.log(`BO3=0.90 → BO5=${p3.toFixed(3)} (expect ≈0.95+)`);
}
