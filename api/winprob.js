import fs from 'fs';
import path from 'path';

const MAX_OVERS = 20;
const MAX_WICKETS = 10;
const MIN_YEAR = 2023;
const IPL_AVG_TOTAL = 193;

// Model params — defaults, overridden by model_params.json at runtime
let ALPHA = [0.129668, 0.374227, 0.64401];
let MU    = [7.916135, 8.506491, 8.66626];
let PHASES = [
  { C: 35.183517, b: 0.050941, a_w: 0.010875 },
  { C: 29.6944,   b: 0.054326, a_w: 0.003438 },
  { C: 45.666991, b: 0.040952, a_w: 0.00194  },
];
let GAMMA = 2.499963;
let BLEND = 0.5;

function loadModelParams(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'model_params.json'), 'utf8'));
    const rr = raw.rr_shrinkage || {};
    const rm = raw.resource_model || {};
    if (Array.isArray(rr.alpha_by_phase) && rr.alpha_by_phase.length === 3)
      ALPHA = rr.alpha_by_phase.map(Number);
    if (Array.isArray(rr.mu_by_phase) && rr.mu_by_phase.length === 3)
      MU = rr.mu_by_phase.map(Number);
    if (Array.isArray(rm.phases) && rm.phases.length === 3)
      PHASES = rm.phases.map(p => ({ C: Number(p.C), b: Number(p.b), a_w: Number(p.a_w) }));
    if (rm.wicket_gamma != null) GAMMA = Number(rm.wicket_gamma);
    if (rm.phase_blend_overs != null) BLEND = Number(rm.phase_blend_overs);
  } catch (_) {}
}

function phase(oc) {
  if (oc <= 6) return 0;
  if (oc <= 16) return 1;
  return 2;
}

function resourceForPhase(pi, oversRem, wicketsRem) {
  const { C, b, a_w } = PHASES[pi];
  const wl = Math.max(0, MAX_WICKETS - wicketsRem);
  return C * (1 - Math.exp(-b * oversRem)) * Math.exp(-a_w * Math.pow(wl, GAMMA));
}

function resourceFactor(oversRem, wicketsRem, oc) {
  const d = BLEND;
  if (oc <= 6 - d) return resourceForPhase(0, oversRem, wicketsRem);
  if (oc >= 6 + d && oc <= 16 - d) return resourceForPhase(1, oversRem, wicketsRem);
  if (oc >= 16 + d) return resourceForPhase(2, oversRem, wicketsRem);
  if (oc < 6 + d) {
    const t = (oc - (6 - d)) / (2 * d);
    return (1 - t) * resourceForPhase(0, oversRem, wicketsRem) + t * resourceForPhase(1, oversRem, wicketsRem);
  }
  const t = (oc - (16 - d)) / (2 * d);
  return (1 - t) * resourceForPhase(1, oversRem, wicketsRem) + t * resourceForPhase(2, oversRem, wicketsRem);
}

function predictScore(current, rrObs, oversRem, wicketsLost, oc) {
  const k = phase(oc);
  const rrEff = ALPHA[k] * rrObs + (1 - ALPHA[k]) * MU[k];
  const wr = MAX_WICKETS - wicketsLost;
  return current + rrEff * resourceFactor(oversRem, wr, oc);
}

function sigma(oc) {
  if (oc <= 6)  return 30.8;
  if (oc <= 12) return 23.3;
  if (oc <= 16) return 16.6;
  return 11.8;
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? p : 1 - p;
}

/**
 * P(batting team wins) during 1st innings.
 * Derived from P(projected total > IPL_AVG_TOTAL).
 */
function inn1WinProb(score, wickets, oc) {
  if (oc <= 0) return 0.5;
  const oversRem = Math.max(0, MAX_OVERS - oc);
  if (oversRem <= 0) {
    const z = (IPL_AVG_TOTAL - score) / 15;
    return Math.min(0.95, Math.max(0.05, 1 - normalCDF(z)));
  }
  const rr = score / oc;
  const pred = predictScore(score, rr, oversRem, wickets, oc);
  const z = (IPL_AVG_TOTAL - pred) / sigma(oc);
  return Math.min(0.95, Math.max(0.05, 1 - normalCDF(z)));
}

/**
 * P(chasing team wins) during 2nd innings.
 */
function chaseWinProb(score, wickets, oc, target) {
  const oversRem = Math.max(0, MAX_OVERS - oc);
  if (oversRem <= 0) return score >= target ? 0.98 : 0.02;
  if (score >= target) return 0.98;
  const rr = oc > 0 ? score / oc : 8.0;
  const pred = predictScore(score, rr, oversRem, wickets, oc);
  const z = (target - pred) / sigma(oc);
  return Math.min(0.98, Math.max(0.02, 1 - normalCDF(z)));
}

/**
 * Process one innings ball-by-ball, returning one point per completed over.
 * Returns array of { oc, score, wickets }.
 */
function processInnings(innData) {
  const byOver = {};
  let score = 0;
  let wickets = 0;

  for (const overData of (innData.overs || [])) {
    const overNum = overData.over; // 0-indexed
    let legal = 0;
    for (const delivery of (overData.deliveries || [])) {
      score += delivery.runs.total;
      if (delivery.wickets) wickets += delivery.wickets.length;
      const extras = delivery.extras || {};
      if (!extras.wides && !extras.noballs) legal++;
      // Record at each legal ball
      const oc = overNum + legal / 6;
      byOver[overNum] = { oc: Math.round(oc * 1000) / 1000, score, wickets };
    }
  }

  const points = Object.values(byOver).sort((a, b) => a.oc - b.oc);
  const finalScore = points.length ? points[points.length - 1].score : 0;
  return { points, finalScore };
}

/**
 * Find the most recent completed IPL match (both innings, has outcome) post-MIN_YEAR.
 */
function findLatestMatch(jsonDir) {
  const files = fs.readdirSync(jsonDir)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => {
      // Sort numerically by the ID in the filename so newest (highest ID) comes first
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      return nb - na;
    });

  for (const fname of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(jsonDir, fname), 'utf8'));
      const info = raw.info || {};
      const dates = info.dates || [];
      if (!dates.length) continue;
      const year = parseInt(dates[0].slice(0, 4), 10);
      if (year < MIN_YEAR) continue;

      // Must be completed with both innings
      if (!info.outcome) continue;
      const innings = raw.innings || [];
      if (innings.length < 2) continue;

      // Must have played 18+ overs in 1st innings (not rain-affected)
      if ((innings[0].overs || []).length < 18) continue;

      return { fname, raw, info, innings, date: dates[0] };
    } catch (_) {}
  }
  return null;
}

export default function handler(req, res) {
  try {
    const root = process.cwd();
    loadModelParams(root);

    const jsonDir = path.join(root, 'ipl_male_json');
    const match = findLatestMatch(jsonDir);

    if (!match) {
      return res.status(200).json({ error: 'No suitable match found', points: [] });
    }

    const { info, innings, date } = match;
    const teams = info.teams || [];
    const event = info.event || {};
    const matchNum = typeof event === 'object' ? (event.match_number || '') : '';
    const outcome = info.outcome || {};
    const winner = outcome.winner || '';
    const by = outcome.by || {};
    const resultStr = winner
      ? `${winner} won by ${Object.values(by)[0]} ${Object.keys(by)[0]}`
      : 'Result unknown';

    const { points: inn1Points, finalScore: inn1Final } = processInnings(innings[0]);
    const { points: inn2Points } = processInnings(innings[1]);
    const target = inn1Final + 1;

    const team1 = innings[0].team; // batted first
    const team2 = innings[1].team; // chased

    // Build win probability series.
    // team1WinProb + team2WinProb = 100 at every point.
    const winProbPoints = [];

    // 1st innings: x = oc (0–20), team1 = batting, team2 = fielding
    for (const { oc, score, wickets } of inn1Points) {
      const p1 = inn1WinProb(score, wickets, oc);
      winProbPoints.push({
        x: parseFloat(oc.toFixed(2)),
        team1: parseFloat((p1 * 100).toFixed(1)),
        team2: parseFloat(((1 - p1) * 100).toFixed(1)),
        innings: 1,
        score: `${score}/${wickets}`,
      });
    }

    // 2nd innings: x = 20 + oc, team2 = chasing, team1 = defending
    for (const { oc, score, wickets } of inn2Points) {
      const p2 = chaseWinProb(score, wickets, oc, target);
      winProbPoints.push({
        x: parseFloat((20 + oc).toFixed(2)),
        team1: parseFloat(((1 - p2) * 100).toFixed(1)),
        team2: parseFloat((p2 * 100).toFixed(1)),
        innings: 2,
        score: `${score}/${wickets}`,
      });
    }

    return res.status(200).json({
      match: {
        date,
        teams: [team1, team2],
        team1,
        team2,
        inn1Final,
        target,
        result: resultStr,
        matchNumber: matchNum,
        event: typeof event === 'object' ? (event.name || '') : '',
      },
      points: winProbPoints,
    });

  } catch (err) {
    console.error('[winprob]', err);
    return res.status(500).json({ error: String(err), points: [] });
  }
}
