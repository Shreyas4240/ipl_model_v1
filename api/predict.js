const fs = require('fs');
const path = require('path');
const { getLiveMatchesData } = require('./live');

/**
 * Shared Model Logic
 * (Ported from api/recent.js and index.html)
 */

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
  // Hardcoded defaults (matching model_params.json fallback)
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

/**
 * Main API Handler
 */
module.exports = async function handler(req, res) {
  try {
    // 1. Load Model Parameters
    const paramsPath = path.join(__dirname, '../data/model_params.json');
    let modelParams = null;
    if (fs.existsSync(paramsPath)) {
      try {
        modelParams = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
      } catch (e) {
        console.error('Failed to parse model_params.json:', e.message);
      }
    }

    // 2. Fetch Live Matches
    const liveData = await getLiveMatchesData();
    const matches = liveData.matches || [];

    // 3. Apply Predictions to Live Matches
    const predictedMatches = matches.map((match) => {
      // Only predict for live matches or first innings of completed ones (if applicable)
      if (match.status !== 'live' && match.status !== 'completed') return match;

      const s = match.score;
      if (!s || s.runs === null || s.overs_decimal === null) return match;

      const runs = Number(s.runs);
      const wickets = Number(s.wickets || 0);
      const oc = Number(s.overs_decimal);
      const or = Math.max(0, 20 - oc);
      const rr = oc > 0 ? runs / oc : 8.5; // Baseline RR for 0.0 overs

      // Check if it's second innings (win probability might be better there, 
      // but this endpoint is specifically for "predicted score" as requested)
      // Usually predicted score applies to the current batting team's total.
      
      const predicted = predictScore(runs, rr, or, wickets, oc, modelParams);
      const rrEff = effectiveRunRate(rr, oc, modelParams);

      return {
        ...match,
        prediction: {
          score: Math.round(predicted),
          exact_score: predicted,
          observed_rr: Math.round(rr * 100) / 100,
          effective_rr: Math.round(rrEff * 100) / 100,
          overs_remaining: Math.round(or * 10) / 10,
        }
      };
    });

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      matches: predictedMatches,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[predict] Error:', err.message);
    return res.status(500).json({ error: err.message, matches: [] });
  }
};
