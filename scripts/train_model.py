"""
Grand Slam Oracle — ML Model Training
Phase 3: Train logistic regression models (men's + women's) on Sackmann data.

Usage:
    python scripts/train_model.py
    python scripts/train_model.py --start-year 2010 --end-year 2024

Outputs:
    model/mens_model.json
    model/womens_model.json
    model/calibration_mens.json
    model/calibration_womens.json
"""

import os
import sys
import json
import glob
import argparse
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import brier_score_loss, roc_auc_score, accuracy_score
from scipy.optimize import brentq

warnings.filterwarnings('ignore')

# ─── Paths ─────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent.parent
ATP_DIR = ROOT / 'data' / 'sackmann_atp'
WTA_DIR = ROOT / 'data' / 'sackmann_wta'
MODEL_DIR = ROOT / 'model'
MODEL_DIR.mkdir(exist_ok=True)

# ─── Feature Columns ──────────────────────────────────────────────────────────

FEATURE_COLS = [
    'surface_elo_diff',
    'overall_elo_diff',
    'ranking_diff',
    'ranking_points_diff',
    'h2h_adj',
    'h2h_surface_adj',
    'recent_10_win_pct_diff',
    'recent_surface_win_pct_diff',
    'sets_won_pct_recent_diff',
    'service_games_won_pct_diff',
    'return_games_won_pct_diff',
    'ace_rate_diff',
    'double_fault_rate_diff',
    'first_serve_pct_diff',
    'first_serve_points_won_diff',
    'second_serve_points_won_diff',
    'break_points_converted_diff',
    'break_points_saved_diff',
    'tiebreak_win_pct_diff',
    'age_diff',
    'player_a_age',
    'matches_played_this_slam',
    'total_sets_played_slam',
    'days_since_last_match',
    'slam_experience_diff',
    'slam_titles_diff',
    'this_slam_history_diff',
    'seed_diff',
    'injury_flag',
]

# ─── Elo Computation ───────────────────────────────────────────────────────────

def elo_expected(ra, rb):
    return 1 / (1 + 10 ** ((rb - ra) / 400))

SURFACE_MAP = {'Hard': 'hard', 'Clay': 'clay', 'Grass': 'grass', 'Carpet': 'hard'}
GRAND_SLAMS = {'Australian Open', 'Roland Garros', 'Wimbledon', 'US Open'}

def is_grand_slam(name, level):
    return level == 'G' or any(gs in name for gs in GRAND_SLAMS)

def normalize_surface(s):
    return SURFACE_MAP.get(s, 'hard')

def load_matches(data_dir, start_year, end_year, prefix):
    dfs = []
    for year in range(start_year, end_year + 1):
        fp = data_dir / f'{prefix}{year}.csv'
        if not fp.exists():
            continue
        try:
            df = pd.read_csv(fp, low_memory=False)
            dfs.append(df)
        except Exception as e:
            print(f'  Warning: Could not load {fp}: {e}')
    if not dfs:
        return pd.DataFrame()
    return pd.concat(dfs, ignore_index=True)

def build_elo_ratings(df):
    """Build surface-specific Elo ratings for all players."""
    K_OVERALL = 24
    K_SURFACE = 32
    K_CROSS   = 8
    INIT      = 1300

    elo_overall = {}
    elo_surface = {'hard': {}, 'clay': {}, 'grass': {}}

    def get_elo(pid, elo_dict):
        return elo_dict.get(pid, INIT)

    def update(pid_w, pid_l, elo_dict, k):
        ew = get_elo(pid_w, elo_dict)
        el = get_elo(pid_l, elo_dict)
        exp_w = elo_expected(ew, el)
        elo_dict[pid_w] = ew + k * (1 - exp_w)
        elo_dict[pid_l] = el + k * (0 - (1 - exp_w))

    # Sort by date
    df = df.copy()
    df['tourney_date'] = pd.to_numeric(df['tourney_date'], errors='coerce')
    df = df.dropna(subset=['tourney_date', 'winner_id', 'loser_id'])
    df = df.sort_values('tourney_date').reset_index(drop=True)

    pre_winner_elo = np.zeros(len(df))
    pre_loser_elo  = np.zeros(len(df))
    pre_winner_surf = np.zeros(len(df))
    pre_loser_surf  = np.zeros(len(df))

    for i, row in df.iterrows():
        wid = str(row['winner_id'])
        lid = str(row['loser_id'])
        surf = normalize_surface(str(row.get('surface', 'Hard')))

        pre_winner_elo[i]  = get_elo(wid, elo_overall)
        pre_loser_elo[i]   = get_elo(lid, elo_overall)
        pre_winner_surf[i] = get_elo(wid, elo_surface[surf])
        pre_loser_surf[i]  = get_elo(lid, elo_surface[surf])

        # Update overall
        update(wid, lid, elo_overall, K_OVERALL)
        # Update surface
        update(wid, lid, elo_surface[surf], K_SURFACE)
        # Cross-surface bleed
        for s2 in ['hard', 'clay', 'grass']:
            if s2 != surf:
                update(wid, lid, elo_surface[s2], K_CROSS)

    df['winner_elo_pre'] = pre_winner_elo
    df['loser_elo_pre']  = pre_loser_elo
    df['winner_surf_elo_pre'] = pre_winner_surf
    df['loser_surf_elo_pre']  = pre_loser_surf

    return df

# ─── Feature Engineering ──────────────────────────────────────────────────────

def safe_div(a, b, default=0):
    return a / b if b != 0 else default

def build_rolling_serve_stats(df, window=20):
    """
    Compute PRE-MATCH rolling serve/return stats for each player from
    their previous `window` matches. No look-ahead: stats are computed
    only from matches BEFORE the current one.

    Returns a dict: player_id -> rolling StatRecord (updated in-place as we iterate).
    Also returns two parallel arrays: winner_stats[i] and loser_stats[i] for each row.
    """
    from collections import defaultdict, deque

    # Per-player deque of recent match stats
    # Each entry: {sg_won, rg_won, ace_rate, df_rate, fst_pct, fst_won, snd_won, bp_conv, bp_saved}
    player_history = defaultdict(lambda: deque(maxlen=window))

    DEFAULT = {
        'sg_won': 0.82, 'rg_won': 0.35, 'ace_rate': 0.07,
        'df_rate': 0.035, 'fst_pct': 0.62, 'fst_won': 0.73,
        'snd_won': 0.53, 'bp_conv': 0.42, 'bp_saved': 0.63,
    }

    def mean_stat(history, key):
        vals = [h[key] for h in history if h[key] is not None]
        return np.mean(vals) if vals else DEFAULT[key]

    def get_player_stats(pid):
        hist = player_history[pid]
        if not hist:
            return DEFAULT.copy()
        return {k: mean_stat(hist, k) for k in DEFAULT}

    def extract_match_stats(row, prefix_w):
        """Extract serve stats from one side of the match (winner or loser prefix)."""
        pw = 'w' if prefix_w else 'l'
        po = 'l' if prefix_w else 'w'  # opponent prefix

        def g(col, default=0):
            v = row.get(f'{pw}_{col}', default)
            try:
                f = float(v)
                return 0.0 if (f != f) else f  # NaN check
            except (TypeError, ValueError):
                return float(default)

        def go(col, default=0):
            v = row.get(f'{po}_{col}', default)
            try:
                f = float(v)
                return 0.0 if (f != f) else f
            except (TypeError, ValueError):
                return float(default)

        svgms  = g('SvGms')
        svpt   = g('svpt')
        fst_in = g('1stIn')
        fst_won = g('1stWon')
        snd_won = g('2ndWon')
        bpf    = g('bpFaced')
        bps    = g('bpSaved')
        ace    = g('ace')
        df_    = g('df')

        # Opponent's stats for return games
        o_svgms = go('SvGms')
        o_bpf   = go('bpFaced')
        o_bps   = go('bpSaved')

        return {
            'sg_won':    safe_div(svgms - bpf + bps, svgms) if svgms > 0 else None,
            'rg_won':    safe_div(o_bpf - o_bps, o_svgms) if o_svgms > 0 else None,
            'ace_rate':  safe_div(ace, svgms) if svgms > 0 else None,
            'df_rate':   safe_div(df_, svgms) if svgms > 0 else None,
            'fst_pct':   safe_div(fst_in, svpt) if svpt > 0 else None,
            'fst_won':   safe_div(fst_won, fst_in) if fst_in > 0 else None,
            'snd_won':   safe_div(snd_won, svpt - fst_in) if (svpt - fst_in) > 0 else None,
            'bp_conv':   safe_div(o_bpf - o_bps, o_bpf) if o_bpf > 0 else None,
            'bp_saved':  safe_div(bps, bpf) if bpf > 0 else None,
        }

    n = len(df)
    winner_pre = []
    loser_pre  = []

    for _, row in df.iterrows():
        wid = str(row['winner_id'])
        lid = str(row['loser_id'])

        # Record PRE-MATCH stats (before updating history)
        winner_pre.append(get_player_stats(wid))
        loser_pre.append(get_player_stats(lid))

        # Update history with THIS match's stats (post-match)
        w_stats = extract_match_stats(row, prefix_w=True)
        l_stats = extract_match_stats(row, prefix_w=False)
        player_history[wid].append(w_stats)
        player_history[lid].append(l_stats)

    return winner_pre, loser_pre

def build_training_dataset(df, slam_weight=2.0):
    """Build feature matrix from match data. Winner = class 1."""
    df = build_elo_ratings(df)  # sorts by date, resets index

    # Pre-match rolling serve stats (no leakage — uses only prior matches)
    print('  Computing rolling pre-match serve stats...')
    winner_pre, loser_pre = build_rolling_serve_stats(df)

    def safe_seed(v, default=33):
        try:
            f = float(v)
            return int(f) if not np.isnan(f) else default
        except (TypeError, ValueError):
            return default

    def safe_age(v, default=25.0):
        try:
            f = float(v)
            return f if not np.isnan(f) else default
        except (TypeError, ValueError):
            return default

    def safe_rank(v, default=200):
        try:
            f = float(v)
            return int(f) if not np.isnan(f) else default
        except (TypeError, ValueError):
            return default

    def safe_pts(v, default=0):
        try:
            f = float(v)
            return f if not np.isnan(f) else default
        except (TypeError, ValueError):
            return default

    DONT_NEGATE = {'player_a_age', 'matches_played_this_slam',
                   'total_sets_played_slam', 'days_since_last_match', 'injury_flag'}

    X_rows = []
    y = []
    weights = []

    for i, (_, row) in enumerate(df.iterrows()):
        wp = winner_pre[i]
        lp = loser_pre[i]

        # ── Core predictive features ──────────────────────────────────────────
        # Signs: positive = winner (player A) advantage
        feat = {
            'surface_elo_diff':             float(row['winner_surf_elo_pre'] - row['loser_surf_elo_pre']),
            'overall_elo_diff':             float(row['winner_elo_pre'] - row['loser_elo_pre']),
            'ranking_diff':                 float(safe_rank(row.get('loser_rank')) - safe_rank(row.get('winner_rank'))),
            'ranking_points_diff':          float(safe_pts(row.get('winner_rank_points')) - safe_pts(row.get('loser_rank_points'))),
            # H2H — unknown in historical training; leave at 0
            'h2h_adj':                      0.0,
            'h2h_surface_adj':              0.0,
            # Recent form — not reliably computable per-match here; leave at 0
            'recent_10_win_pct_diff':       0.0,
            'recent_surface_win_pct_diff':  0.0,
            'sets_won_pct_recent_diff':     0.0,
            # Pre-match rolling serve/return stats (winner - loser, no leakage)
            'service_games_won_pct_diff':   float(wp['sg_won']   - lp['sg_won']),
            'return_games_won_pct_diff':    float(wp['rg_won']   - lp['rg_won']),
            'ace_rate_diff':                float(wp['ace_rate'] - lp['ace_rate']),
            'double_fault_rate_diff':       float(wp['df_rate']  - lp['df_rate']),
            'first_serve_pct_diff':         float(wp['fst_pct']  - lp['fst_pct']),
            'first_serve_points_won_diff':  float(wp['fst_won']  - lp['fst_won']),
            'second_serve_points_won_diff': float(wp['snd_won']  - lp['snd_won']),
            'break_points_converted_diff':  float(wp['bp_conv']  - lp['bp_conv']),
            'break_points_saved_diff':      float(wp['bp_saved'] - lp['bp_saved']),
            'tiebreak_win_pct_diff':        0.0,
            # Player attributes
            'age_diff':                     float(safe_age(row.get('winner_age')) - safe_age(row.get('loser_age'))),
            'player_a_age':                 float(safe_age(row.get('winner_age'))),
            # Tournament context — set to 0 for training (no fatigue info per-match)
            'matches_played_this_slam':     0.0,
            'total_sets_played_slam':       0.0,
            'days_since_last_match':        0.0,
            'slam_experience_diff':         0.0,
            'slam_titles_diff':             0.0,
            'this_slam_history_diff':       0.0,
            'seed_diff':                    float(safe_seed(row.get('winner_seed')) - safe_seed(row.get('loser_seed'))),
            'injury_flag':                  0.0,
        }
        X_rows.append(feat)
        y.append(1)  # winner is always class 1

        # ── Mirror: loser perspective (y=0) ──────────────────────────────────
        feat_mirror = {}
        for k, v in feat.items():
            feat_mirror[k] = v if k in DONT_NEGATE else -v
        feat_mirror['player_a_age'] = float(safe_age(row.get('loser_age')))
        X_rows.append(feat_mirror)
        y.append(0)

        is_slam = is_grand_slam(str(row.get('tourney_name', '')), str(row.get('tourney_level', '')))
        w = slam_weight if is_slam else 1.0
        weights.extend([w, w])

    X = pd.DataFrame(X_rows, columns=FEATURE_COLS)
    return X, np.array(y), np.array(weights)

# ─── Platt Scaling ────────────────────────────────────────────────────────────

def fit_platt_scaling(y_true, y_pred_proba):
    """Fit Platt scaling parameters A and B. Returns (A, B)."""
    from scipy.optimize import minimize

    def neg_log_likelihood(params):
        A, B = params
        p = 1 / (1 + np.exp(A * y_pred_proba + B))
        p = np.clip(p, 1e-10, 1 - 1e-10)
        return -np.mean(y_true * np.log(p) + (1 - y_true) * np.log(1 - p))

    result = minimize(neg_log_likelihood, x0=[-1.0, 0.0], method='L-BFGS-B')
    return result.x[0], result.x[1]

# ─── Walk-Forward Cross-Validation ───────────────────────────────────────────

def walk_forward_cv(all_dfs_by_year, train_fn, test_years=None):
    """
    Walk-forward validation: train on years 2010-N, test on year N+1.
    Returns per-year accuracy.
    """
    years = sorted(all_dfs_by_year.keys())
    results = []

    for i in range(3, len(years)):
        train_years = years[:i]
        test_year = years[i]
        if test_years and test_year not in test_years:
            continue

        train_df = pd.concat([all_dfs_by_year[y] for y in train_years], ignore_index=True)
        test_df  = all_dfs_by_year[test_year]

        # Filter to Grand Slams only for testing
        test_slam = test_df[test_df.apply(
            lambda r: is_grand_slam(str(r.get('tourney_name', '')), str(r.get('tourney_level', ''))), axis=1
        )]

        if len(test_slam) < 20:
            continue

        model, scaler = train_fn(train_df)

        X_test, y_test, _ = build_training_dataset(test_slam)
        X_test_s = scaler.transform(X_test.fillna(0))
        y_pred = model.predict(X_test_s)
        acc = accuracy_score(y_test, y_pred)
        results.append({'year': test_year, 'accuracy': acc, 'n_matches': len(y_test) // 2})
        print(f'    Walk-forward {test_year}: acc={acc:.3f} on {len(y_test)//2} matches')

    return results

# ─── Training ─────────────────────────────────────────────────────────────────

def train_gender(data_dir, prefix, gender, start_year, end_year):
    print(f'\n── Training {gender.upper()} model ({start_year}–{end_year}) ──')

    # Load data
    df = load_matches(data_dir, start_year, end_year, prefix)
    if df.empty:
        print(f'  No data found in {data_dir}. Skipping.')
        return None, None

    print(f'  Total matches: {len(df):,}')

    # Build features
    print('  Building feature matrix...')
    X, y, weights = build_training_dataset(df, slam_weight=2.0)
    print(f'  Features: {X.shape[1]} | Samples: {X.shape[0]:,}')

    # Split for calibration (last 20%)
    split = int(0.8 * len(X))
    X_train, X_cal = X.iloc[:split], X.iloc[split:]
    y_train, y_cal = y[:split], y[split:]
    w_train, w_cal = weights[:split], weights[split:]

    # Scale
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train.fillna(0))
    X_cal_s   = scaler.transform(X_cal.fillna(0))

    # Train logistic regression
    print('  Training logistic regression (C=1.0, L2)...')
    model = LogisticRegression(
        C=1.0, penalty='l2', solver='lbfgs',
        max_iter=1000, random_state=42
    )
    model.fit(X_train_s, y_train, sample_weight=w_train)

    # Evaluate
    y_pred_cal = model.predict_proba(X_cal_s)[:, 1]
    y_pred_class = model.predict(X_cal_s)

    acc    = accuracy_score(y_cal, y_pred_class)
    brier  = brier_score_loss(y_cal, y_pred_cal)
    auc    = roc_auc_score(y_cal, y_pred_cal)

    print(f'  Calibration set:')
    print(f'    Accuracy:    {acc:.3f}')
    print(f'    Brier score: {brier:.4f}')
    print(f'    AUC:         {auc:.4f}')

    # Platt scaling
    print('  Fitting Platt scaling...')
    A, B = fit_platt_scaling(y_cal, y_pred_cal)
    print(f'  Platt A={A:.4f}, B={B:.4f}')

    # Verify calibration
    y_cal_platt = 1 / (1 + np.exp(A * y_pred_cal + B))
    brier_cal = brier_score_loss(y_cal, y_cal_platt)
    print(f'  Brier after calibration: {brier_cal:.4f}')

    return {
        'model': model,
        'scaler': scaler,
        'coefficients': dict(zip(FEATURE_COLS, model.coef_[0].tolist())),
        'intercept': float(model.intercept_[0]),
        'platt_A': float(A),
        'platt_B': float(B),
        'accuracy': float(acc),
        'brier_score': float(brier),
        'auc': float(auc),
        'feature_names': FEATURE_COLS,
    }, scaler

def export_models(mens_result, womens_result):
    """Export model coefficients and calibration params to JSON."""
    for gender, result in [('mens', mens_result), ('womens', womens_result)]:
        if result is None:
            print(f'  No {gender} model to export.')
            continue

        r, _ = result

        # Model coefficients
        model_json = {
            'intercept': r['intercept'],
            'coefficients': r['coefficients'],
            'feature_names': r['feature_names'],
            'trained_on': '2010-2024',
            'accuracy': r['accuracy'],
            'brier_score': r['brier_score'],
        }

        calib_json = {
            'method': 'platt',
            'a': r['platt_A'],
            'b': r['platt_B'],
        }

        model_path = MODEL_DIR / f'{gender}_model.json'
        calib_path = MODEL_DIR / f'calibration_{gender}.json'

        with open(model_path, 'w') as f:
            json.dump(model_json, f, indent=2)

        with open(calib_path, 'w') as f:
            json.dump(calib_json, f, indent=2)

        print(f'  Exported: {model_path}')
        print(f'  Exported: {calib_path}')

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Train Grand Slam Oracle models')
    parser.add_argument('--start-year', type=int, default=2010)
    parser.add_argument('--end-year',   type=int, default=2024)
    parser.add_argument('--gender',     choices=['atp', 'wta', 'both'], default='both')
    args = parser.parse_args()

    print('=== Grand Slam Oracle: Model Training ===')
    print(f'Years: {args.start_year}–{args.end_year}')

    mens_result = womens_result = None

    if args.gender in ('atp', 'both'):
        if (ATP_DIR).exists():
            mens_result = train_gender(ATP_DIR, 'atp_matches_', 'mens', args.start_year, args.end_year)
        else:
            print(f'\nATP data not found at {ATP_DIR}')
            print('Run: git clone https://github.com/JeffSackmann/tennis_atp data/sackmann_atp')

    if args.gender in ('wta', 'both'):
        if (WTA_DIR).exists():
            womens_result = train_gender(WTA_DIR, 'wta_matches_', 'womens', args.start_year, args.end_year)
        else:
            print(f'\nWTA data not found at {WTA_DIR}')
            print('Run: git clone https://github.com/JeffSackmann/tennis_wta data/sackmann_wta')

    print('\nExporting models...')
    export_models(mens_result, womens_result)

    print('\n✅ Training complete!')

if __name__ == '__main__':
    main()
