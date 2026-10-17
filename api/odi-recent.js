const fs = require('fs');
const path = require('path');
const EVALUATION_OVERS = new Set([30, 35, 40, 45]);
const PHASE_BOUNDARIES = [10, 20, 30, 40];
const PHASE_COUNT = 5;
const FULL_MEMBER_TEAMS = new Set([
  'Afghanistan', 'Australia', 'Bangladesh', 'England', 'India', 'Ireland',
  'New Zealand', 'Pakistan', 'South Africa', 'Sri Lanka', 'West Indies', 'Zimbabwe',
]);

function isAssociateVsAssociate(teams) {
  return Array.isArray(teams) && teams.length >= 2 && !teams.some((team) => FULL_MEMBER_TEAMS.has(team));
}

function readSnapshots() {
  const csvPath = path.join(__dirname, '../odi_innings_snapshots.csv');
  if (!fs.existsSync(csvPath)) return [];

  const lines = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1);
  return lines
    .map((line) => {
      const parts = line.split(',');
      if (parts.length < 9) return null;
      const [team, ballsBowled, oversCompleted, oversRemaining, wickets, runRate, currentScore, finalTotal, matchFile, matchDate] = parts;
      return {
        innings_team: (team || '').trim(),
        balls_bowled: Number(ballsBowled) || 0,
        overs_completed: Number(oversCompleted) || 0,
        overs_remaining: Number(oversRemaining) || 0,
        wickets_lost: Number(wickets) || 0,
        run_rate: Number(runRate) || 0,
        current_score: Number(currentScore) || 0,
        actual: Number(finalTotal) || 0,
        match_file: (matchFile || '').trim(),
        match_date: (matchDate || '').trim(),
      };
    })
    .filter(Boolean);
}

function readMatchMetaIndex() {
  const metaPath = path.join(__dirname, '../data/odi_match_meta.json');
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return {};
  }
}

function readMatchFile(filename) {
  const jsonPath = path.join(__dirname, '../odis_json', filename);
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function readModelParams() {
  const modelPath = path.join(__dirname, '../data/odi_model_params.json');
  if (!fs.existsSync(modelPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch {
    return null;
  }
}

function powerplayPhase(oversCompleted) {
  const oc = Number(oversCompleted);
  for (let i = 0; i < PHASE_BOUNDARIES.length; i++) {
    if (oc <= PHASE_BOUNDARIES[i]) return i;
  }
  return PHASE_COUNT - 1;
}

function getRRShrink(modelParams) {
  const s = modelParams && modelParams.rr_shrinkage;
  if (s && Array.isArray(s.alpha_by_phase) && s.alpha_by_phase.length === PHASE_COUNT && Array.isArray(s.mu_by_phase) && s.mu_by_phase.length === PHASE_COUNT) {
    return {
      alphaByPhase: s.alpha_by_phase.map(Number),
      muByPhase: s.mu_by_phase.map(Number),
    };
  }
  return {
    alphaByPhase: [0.20, 0.28, 0.35, 0.45, 0.55],
    muByPhase: [5.4, 5.6, 5.8, 6.4, 7.2],
  };
}

function getResourceModelParams(modelParams) {
  const m = modelParams && modelParams.resource_model;
  if (m && Array.isArray(m.phases) && m.phases.length === PHASE_COUNT) {
    return {
      phases: m.phases,
      wicketGamma: Number(m.wicket_gamma || 2.5),
      wicketPenaltyByPhase: Array.isArray(m.wicket_penalty_by_phase) && m.wicket_penalty_by_phase.length === PHASE_COUNT ? m.wicket_penalty_by_phase.map(Number) : [2.50, 1.45, 1.15, 1.00, 0.90],
      phaseBlendOvers: Number(m.phase_blend_overs || 0.5),
    };
  }
  return {
    phases: [
      { C: 55.0, b: 0.040, a_w: 0.008 },
      { C: 52.0, b: 0.040, a_w: 0.006 },
      { C: 50.0, b: 0.035, a_w: 0.004 },
      { C: 45.0, b: 0.042, a_w: 0.004 },
      { C: 40.0, b: 0.050, a_w: 0.003 },
    ],
    wicketGamma: 2.2,
    wicketPenaltyByPhase: [2.50, 1.45, 1.15, 1.00, 0.90],
    phaseBlendOvers: 1.0,
  };
}

function effectiveRunRate(runRate, oversCompleted, modelParams) {
  const k = powerplayPhase(oversCompleted);
  const { alphaByPhase, muByPhase } = getRRShrink(modelParams);
  const alpha = alphaByPhase[k];
  const mu = muByPhase[k];
  return alpha * Number(runRate) + (1 - alpha) * mu;
}

function resourceForPhase(phaseIdx, oversRem, wicketsRem, model) {
  const p = model.phases[phaseIdx] || {};
  const C = Number(p.C || 0);
  const b = Number(p.b || 0);
  const aW = Number(p.a_w || 0);
  const oversR = Math.max(0, Number(oversRem));
  const wicketsLost = Math.max(0, 10 - Number(wicketsRem));
  return C * (1 - Math.exp(-b * oversR)) * Math.exp(-aW * model.wicketPenaltyByPhase[phaseIdx] * Math.pow(wicketsLost, model.wicketGamma));
}

function rawResourceFactor(oversRem, wicketsRem, oversCompleted, modelParams) {
  const model = getResourceModelParams(modelParams);
  const oc = Number(oversCompleted);
  const d = model.phaseBlendOvers;
  for (let i = 0; i < PHASE_BOUNDARIES.length; i++) {
    const boundary = PHASE_BOUNDARIES[i];
    if (oc > boundary - d && oc < boundary + d) {
      const t = (oc - (boundary - d)) / (2 * d);
      const left = resourceForPhase(i, oversRem, wicketsRem, model);
      const right = resourceForPhase(i + 1, oversRem, wicketsRem, model);
      return (1 - t) * left + t * right;
    }
  }
  return resourceForPhase(powerplayPhase(oc), oversRem, wicketsRem, model);
}

function resourceFactor(oversRem, wicketsRem, oversCompleted, modelParams) {
  const completedBalls = Math.min(300, Math.max(0, Math.ceil(Number(oversCompleted) * 6 - 1e-9)));
  let resource = Infinity;
  for (let ball = 0; ball <= completedBalls; ball++) {
    const completed = ball / 6;
    resource = Math.min(resource, rawResourceFactor(50 - completed, wicketsRem, completed, modelParams));
  }
  return resource;
}

function predictScore(currentScore, runRate, oversRem, wicketsLost, oversCompleted, modelParams) {
  const wicketsRem = 10 - wicketsLost;
  const rrEff = effectiveRunRate(runRate, oversCompleted, modelParams);
  const resource = resourceFactor(oversRem, wicketsRem, oversCompleted, modelParams);
  return currentScore + rrEff * resource;
}

module.exports = async function handler(req, res) {
  try {
    const days = Number(req.query.days) || 30;
    const snapshots = readSnapshots();
    const modelParams = readModelParams();
    const now = Date.now();
    const cutoffTs = Number.isFinite(days) && days > 0 ? now - days * 24 * 60 * 60 * 1000 : 0;

    const matchMeta = new Map();
    const matchMetaIndex = readMatchMetaIndex();
    const inningsCompletion = new Map();
    for (const s of snapshots) {
      const inningsKey = `${s.match_file}|${s.innings_team}`;
      const completion = inningsCompletion.get(inningsKey) || { balls: 0, wickets: 0 };
      completion.balls = Math.max(completion.balls, s.balls_bowled);
      completion.wickets = Math.max(completion.wickets, s.wickets_lost);
      inningsCompletion.set(inningsKey, completion);
      if (matchMeta.has(s.match_file)) continue;
      const slim = matchMetaIndex[s.match_file];
      const m = slim ? null : readMatchFile(s.match_file);
      const date = (slim && slim.date) || m?.info?.dates?.[0] || s.match_date || null;
      const ts = date ? new Date(date).getTime() : 0;
      matchMeta.set(s.match_file, {
        date: date || '',
        ts: Number.isFinite(ts) ? ts : 0,
        teams: (slim && slim.teams) || m?.info?.teams || [],
      });
    }

    const results = snapshots
      .filter((s) => {
        const meta = matchMeta.get(s.match_file);
        if (!meta || !meta.ts || !cutoffTs) return true;
        return meta.ts >= cutoffTs;
      })
      .filter((s) => EVALUATION_OVERS.has(Math.round(s.overs_completed * 10) / 10))
      .filter((s) => {
        const completion = inningsCompletion.get(`${s.match_file}|${s.innings_team}`);
        return completion && (completion.balls >= 300 || completion.wickets >= 10);
      })
      .filter((s) => s.overs_remaining > 0 && s.run_rate > 0 && s.wickets_lost < 10)
      .map((s) => {
        const meta = matchMeta.get(s.match_file) || { date: '', teams: [] };
        if (isAssociateVsAssociate(meta.teams)) return null;
        const firstInningsTeam = (meta.teams && meta.teams.length) ? meta.teams[0] : null;
        if (firstInningsTeam && s.innings_team !== firstInningsTeam) return null;
        const predicted = predictScore(
          s.current_score,
          s.run_rate,
          s.overs_remaining,
          s.wickets_lost,
          s.overs_completed,
          modelParams,
        );
        const error = Math.abs(predicted - s.actual);
        return {
          date: meta.date,
          teams: meta.teams,
          innings_team: s.innings_team,
          at_over: Math.round(s.overs_completed * 10) / 10,
          overs_completed: s.overs_completed,
          overs_remaining: s.overs_remaining,
          wickets_lost: s.wickets_lost,
          current_score: s.current_score,
          run_rate: Math.round(s.run_rate * 100) / 100,
          predicted: Math.round(predicted * 10) / 10,
          actual: s.actual,
          error: Math.round(error * 10) / 10,
          match_file: s.match_file,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : 0;
        const tb = b.date ? new Date(b.date).getTime() : 0;
        return tb - ta;
      });

    const errors = results.map((r) => r.error);
    const count = results.length;
    const mae = count ? errors.reduce((sum, e) => sum + e, 0) / count : 0;
    const rmse = count ? Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / count) : 0;

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.status(200).json({
      summary: {
        count,
        mae: Number(mae.toFixed(2)),
        rmse: Number(rmse.toFixed(2)),
        message: count ? undefined : 'No matches found for selected period.',
      },
      results,
      model_params: modelParams,
    });
  } catch (err) {
    console.error('[odi-recent] error:', err.message);
    return res.status(500).json({
      error: err.message,
      summary: { count: 0, mae: null, rmse: null, message: 'Could not load recent data.' },
      results: [],
      model_params: null,
    });
  }
};
