const fs = require('fs');
const path = require('path');

function readSnapshots() {
  const csvPath = path.join(__dirname, '../ipl_innings_snapshots.csv');
  if (!fs.existsSync(csvPath)) return [];

  const lines = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1);
  return lines
    .map((line) => {
      const parts = line.split(',');
      if (parts.length < 9) return null;
      const [team, ballsBowled, oversCompleted, oversRemaining, wickets, runRate, currentScore, finalTotal, matchFile] = parts;
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
      };
    })
    .filter(Boolean);
}

function readMatchFile(filename) {
  const jsonPath = path.join(__dirname, '../ipl_male_json', filename);
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function readModelParams() {
  const modelPath = path.join(__dirname, '../data/model_params.json');
  if (!fs.existsSync(modelPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch {
    return null;
  }
}

function powerplayPhase(oversCompleted) {
  if (oversCompleted <= 6) return 0;
  if (oversCompleted <= 16) return 1;
  return 2;
}

function getRRShrink(modelParams) {
  const s = modelParams && modelParams.rr_shrinkage;
  if (s && Array.isArray(s.alpha_by_phase) && s.alpha_by_phase.length === 3 && Array.isArray(s.mu_by_phase) && s.mu_by_phase.length === 3) {
    return {
      alphaByPhase: s.alpha_by_phase.map(Number),
      muByPhase: s.mu_by_phase.map(Number),
    };
  }
  return {
    alphaByPhase: [0.129668, 0.374227, 0.64401],
    muByPhase: [7.916135, 8.506491, 8.66626],
  };
}

function getResourceModelParams(modelParams) {
  const m = modelParams && modelParams.resource_model;
  if (m && Array.isArray(m.phases) && m.phases.length === 3) {
    return {
      phases: m.phases,
      wicketGamma: Number(m.wicket_gamma || 2.5),
      phaseBlendOvers: Number(m.phase_blend_overs || 0.5),
    };
  }
  return {
    phases: [
      { C: 35.183517, b: 0.050941, a_w: 0.010875 },
      { C: 29.6944, b: 0.054326, a_w: 0.003438 },
      { C: 45.666991, b: 0.040952, a_w: 0.00194 },
    ],
    wicketGamma: 2.499963,
    phaseBlendOvers: 0.5,
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
  return C * (1 - Math.exp(-b * oversR)) * Math.exp(-aW * Math.pow(wicketsLost, model.wicketGamma));
}

function resourceFactor(oversRem, wicketsRem, oversCompleted, modelParams) {
  const model = getResourceModelParams(modelParams);
  const oc = Number(oversCompleted);
  const d = model.phaseBlendOvers;
  if (oc <= 6 - d) return resourceForPhase(0, oversRem, wicketsRem, model);
  if (oc >= 6 + d && oc <= 16 - d) return resourceForPhase(1, oversRem, wicketsRem, model);
  if (oc >= 16 + d) return resourceForPhase(2, oversRem, wicketsRem, model);
  if (oc > 6 - d && oc < 6 + d) {
    const t = (oc - (6 - d)) / (2 * d);
    const r0 = resourceForPhase(0, oversRem, wicketsRem, model);
    const r1 = resourceForPhase(1, oversRem, wicketsRem, model);
    return (1 - t) * r0 + t * r1;
  }
  const t = (oc - (16 - d)) / (2 * d);
  const r1 = resourceForPhase(1, oversRem, wicketsRem, model);
  const r2 = resourceForPhase(2, oversRem, wicketsRem, model);
  return (1 - t) * r1 + t * r2;
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
    for (const s of snapshots) {
      if (matchMeta.has(s.match_file)) continue;
      const m = readMatchFile(s.match_file);
      const date = m?.info?.dates?.[0] || null;
      const ts = date ? new Date(date).getTime() : 0;
      matchMeta.set(s.match_file, {
        date: date || '',
        ts: Number.isFinite(ts) ? ts : 0,
        teams: m?.info?.teams || [],
      });
    }

    const results = snapshots
      .filter((s) => {
        const meta = matchMeta.get(s.match_file);
        if (!meta || !meta.ts || !cutoffTs) return true;
        return meta.ts >= cutoffTs;
      })
      .filter((s) => {
        const atOver = Math.round(s.overs_completed * 10) / 10;
        return atOver === 10 || atOver === 15;
      })
      .map((s) => {
        const meta = matchMeta.get(s.match_file) || { date: '', teams: [] };
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
      results: results.slice(0, 2000),
      model_params: modelParams,
    });
  } catch (err) {
    console.error('[recent] error:', err.message);
    return res.status(500).json({
      error: err.message,
      summary: { count: 0, mae: null, rmse: null, message: 'Could not load recent data.' },
      results: [],
      model_params: null,
    });
  }
};
