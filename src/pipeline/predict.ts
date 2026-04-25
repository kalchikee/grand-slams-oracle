import path from 'path';
import { MatchFeatures, MatchPrediction, ModelCoefficients, CalibrationParams, Gender } from '../types';
import { MatchContext, extractFeatures } from './features';
import { amplifyForGrandSlam } from '../best-of-5/markov';
import { eloDiffToWinProb, surfaceEloWinProb } from '../elo/elo';
import { getPlayerElo } from '../db/database';

// ─── Model Loading ────────────────────────────────────────────────────────────

let _mensModel: ModelCoefficients | null = null;
let _womensModel: ModelCoefficients | null = null;
let _mensCalib: CalibrationParams | null = null;
let _womensCalib: CalibrationParams | null = null;

function sanityCheckModel(model: ModelCoefficients | null, label: string): ModelCoefficients | null {
  if (!model) return null;

  // Length consistency: feature_names length must agree with the
  // coefficients dict's key count (positional source of truth = feature_names).
  const namesLen = Array.isArray(model.feature_names) ? model.feature_names.length : -1;
  const coeffEntries = model.coefficients && typeof model.coefficients === 'object'
    ? Object.keys(model.coefficients).length
    : -1;

  if (namesLen <= 0 || coeffEntries <= 0) {
    console.error(
      `[GrandSlams] ${label} model load aborted: feature_names (${namesLen}) or coefficients dict (${coeffEntries}) is empty — refusing to use the model.`,
    );
    return null;
  }
  if (namesLen !== coeffEntries) {
    console.error(
      `[GrandSlams] ${label} model load aborted: feature_names length (${namesLen}) disagrees with coefficients key count (${coeffEntries}) — refusing to use the model.`,
    );
    return null;
  }

  // Verify EVERY feature_name has a corresponding entry in the dict —
  // catches the case where the JSON shape changed (e.g. became `coefficients: number[]`)
  // and dict lookups would silently return undefined → 0.
  const values: number[] = [];
  let missing = 0;
  for (const fname of model.feature_names) {
    const v = (model.coefficients as Record<string, number>)[fname];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      missing++;
    } else {
      values.push(v);
    }
  }
  if (missing > 0) {
    console.error(
      `[GrandSlams] ${label} model load aborted: ${missing}/${namesLen} feature_names had no numeric coefficient (NaN or missing key) — JSON shape likely mismatched.`,
    );
    return null;
  }

  // All-zero check — strong signal of a JSON shape mismatch where lookups
  // silently coerced to 0.
  const nonZero = values.reduce((acc, v) => acc + (v !== 0 ? 1 : 0), 0);
  if (nonZero === 0) {
    console.error(
      `[GrandSlams] ${label} model load aborted: ALL ${namesLen} coefficients are zero — JSON shape likely mismatched. Refusing to use the model.`,
    );
    return null;
  }

  return model;
}

function loadModels(): void {
  try {
    const rawMens   = require(path.resolve(__dirname, '../../model/mens_model.json')) as ModelCoefficients;
    const rawWomens = require(path.resolve(__dirname, '../../model/womens_model.json')) as ModelCoefficients;
    _mensModel   = sanityCheckModel(rawMens, 'mens');
    _womensModel = sanityCheckModel(rawWomens, 'womens');
    _mensCalib   = require(path.resolve(__dirname, '../../model/calibration_mens.json'));
    _womensCalib = require(path.resolve(__dirname, '../../model/calibration_womens.json'));
  } catch (e) {
    console.warn('Model files not found — using Elo-only prediction');
  }
}

loadModels();

// ─── Logistic Regression Inference ───────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function logisticPredict(features: MatchFeatures, model: ModelCoefficients): number {
  let logit = model.intercept;
  for (const fname of model.feature_names) {
    const val = (features as any)[fname] ?? 0;
    const coef = model.coefficients[fname] ?? 0;
    logit += coef * val;
  }
  return sigmoid(logit);
}

function plattCalibrate(rawProb: number, calib: CalibrationParams): number {
  // Platt: P = 1 / (1 + exp(A * f(x) + B))
  // where f(x) is the uncalibrated log-odds
  const logOdds = Math.log(rawProb / (1 - rawProb + 1e-10));
  return 1 / (1 + Math.exp(calib.a * logOdds + calib.b));
}

// ─── Pure Elo Fallback ────────────────────────────────────────────────────────

function eloOnlyPredict(ctx: MatchContext): number {
  const eloA = getPlayerElo(ctx.playerAId);
  const eloB = getPlayerElo(ctx.playerBId);
  if (!eloA || !eloB) return 0.5;
  return surfaceEloWinProb(eloA, eloB, ctx.surface);
}

// ─── Main Prediction ──────────────────────────────────────────────────────────

export function predictMatch(ctx: MatchContext): MatchPrediction {
  const features = extractFeatures(ctx);

  const model = ctx.gender === 'mens' ? _mensModel : _womensModel;
  const calib = ctx.gender === 'mens' ? _mensCalib : _womensCalib;

  let rawProb: number;
  if (model) {
    rawProb = logisticPredict(features, model);
    if (calib) rawProb = plattCalibrate(rawProb, calib);
  } else {
    rawProb = eloOnlyPredict(ctx);
  }

  // Apply best-of-5 amplification for men's Grand Slams
  const finalProb = amplifyForGrandSlam(rawProb, ctx.gender);

  // Edge vs bookmaker odds
  let edgeVsOdds: number | undefined;
  if (ctx.playerAOdds) {
    const impliedProb = 1 / ctx.playerAOdds;
    edgeVsOdds = finalProb - impliedProb;
  }

  const eloA = getPlayerElo(ctx.playerAId);
  const eloB = getPlayerElo(ctx.playerBId);

  return {
    playerAId: ctx.playerAId,
    playerAName: eloA?.name ?? ctx.playerAId,
    playerBId: ctx.playerBId,
    playerBName: eloB?.name ?? ctx.playerBId,
    playerAWinProb: finalProb,
    surface: ctx.surface,
    round: ctx.round as any,
    features,
    edgeVsOdds,
    isHighConviction: finalProb >= 0.70 || finalProb <= 0.30,
    isExtremeConviction: finalProb >= 0.80 || finalProb <= 0.20,
    isValueBet: edgeVsOdds !== undefined && Math.abs(edgeVsOdds) >= 0.05,
  };
}

// ─── Batch Prediction ─────────────────────────────────────────────────────────

export function predictMatches(ctxList: MatchContext[]): MatchPrediction[] {
  return ctxList.map(predictMatch);
}

// ─── Quick Elo-Only Probability (for bracket simulation) ──────────────────────

export function quickMatchProb(
  playerAId: string,
  playerBId: string,
  surface: string,
  gender: Gender
): number {
  const eloA = getPlayerElo(playerAId);
  const eloB = getPlayerElo(playerBId);
  if (!eloA || !eloB) return 0.5;

  const surfKey = surface.toLowerCase() as 'hard' | 'clay' | 'grass';
  const eloProb = 1 / (1 + Math.pow(10, -(eloA[surfKey] - eloB[surfKey]) / 400));
  return amplifyForGrandSlam(eloProb, gender);
}
