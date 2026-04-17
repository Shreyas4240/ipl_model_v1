import fs from 'fs';
import path from 'path';

// Fitted per powerplay (fit_ipl_powerplay_model.py): overs 1–6, 7–16, 17–20
// Fitted with fit_ipl_powerplay_model.py (2022 matches excluded)
let PHASE_Z0_A = [
  [1.5717, 0.019395],
  [1.190465, 0.000344],
  [1.853324, 0.031399],
];
let RESOURCE_PHASE_PARAMS = [
  [35.183517, 0.050941, 0.010875], // C, b, a_w (overs 1-6)
  [29.6944, 0.054326, 0.003438], // overs 7-16
  [45.666991, 0.040952, 0.00194], // overs 17-20
];
let RESOURCE_WICKET_GAMMA = 2.499963;
let PHASE_BLEND_OVERS = 0.5;
let RR_SHRINK_ALPHA_PHASE = [0.129668, 0.374227, 0.64401];
let RR_PHASE_MU = [7.916135, 8.506491, 8.66626];
const MAX_OVERS = 20;
const MAX_WICKETS = 10;
const MIN_DATA_YEAR = 2023;

function loadRuntimeModelParams(rootDir) {
  const p = path.join(rootDir, 'model_params.json');
  if (!fs.existsSync(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rr = data.rr_shrinkage || {};
    const rm = data.resource_model || {};
    if (Array.isArray(rr.alpha_by_phase) && rr.alpha_by_phase.length === 3) {
      RR_SHRINK_ALPHA_PHASE = rr.alpha_by_phase.map(Number);
    }
    if (Array.isArray(rr.mu_by_phase) && rr.mu_by_phase.length === 3) {
      RR_PHASE_MU = rr.mu_by_phase.map(Number);
    }
    if (Array.isArray(rm.phases) && rm.phases.length === 3) {
      RESOURCE_PHASE_PARAMS = rm.phases.map(ph => [Number(ph.C), Number(ph.b), Number(ph.a_w)]);
    }
    if (Array.isArray(data.phases) && data.phases.length === 3) {
      PHASE_Z0_A = data.phases.map(ph => [Number(ph.Z0), Number(ph.a)]);
    }
    if (rm.wicket_gamma != null) RESOURCE_WICKET_GAMMA = Number(rm.wicket_gamma);
    if (rm.phase_blend_overs != null) PHASE_BLEND_OVERS = Number(rm.phase_blend_overs);
  } catch {
    // Keep defaults if invalid file.
  }
}

function powerplayPhase(oversCompleted) {
  const oc = Number(oversCompleted);
  if (oc <= 6) return 0;
  if (oc <= 16) return 1;
  return 2;
}

function effectiveRunRate(runRate, oversCompleted) {
  const k = powerplayPhase(oversCompleted);
  const alpha = RR_SHRINK_ALPHA_PHASE[k];
  const mu = RR_PHASE_MU[k];
  return alpha * Number(runRate) + (1 - alpha) * mu;
}

function resourceForPhase(phaseIdx, oversRemaining, wicketsRemaining) {
  const [Ck, bk, ak] = RESOURCE_PHASE_PARAMS[phaseIdx];
  const oversR = Math.max(0, Number(oversRemaining));
  const wicketsLost = Math.max(0, MAX_WICKETS - Number(wicketsRemaining));
  return Ck * (1 - Math.exp(-bk * oversR)) * Math.exp(-ak * Math.pow(wicketsLost, RESOURCE_WICKET_GAMMA));
}

function resourceFactor(oversRemaining, wicketsRemaining, oversCompleted) {
  const oc = Number(oversCompleted);
  if (oc <= 6 - PHASE_BLEND_OVERS) return resourceForPhase(0, oversRemaining, wicketsRemaining);
  if (oc >= 6 + PHASE_BLEND_OVERS && oc <= 16 - PHASE_BLEND_OVERS) {
    return resourceForPhase(1, oversRemaining, wicketsRemaining);
  }
  if (oc >= 16 + PHASE_BLEND_OVERS) return resourceForPhase(2, oversRemaining, wicketsRemaining);

  if (oc > 6 - PHASE_BLEND_OVERS && oc < 6 + PHASE_BLEND_OVERS) {
    const t = (oc - (6 - PHASE_BLEND_OVERS)) / (2 * PHASE_BLEND_OVERS);
    const r0 = resourceForPhase(0, oversRemaining, wicketsRemaining);
    const r1 = resourceForPhase(1, oversRemaining, wicketsRemaining);
    return (1 - t) * r0 + t * r1;
  }
  const t = (oc - (16 - PHASE_BLEND_OVERS)) / (2 * PHASE_BLEND_OVERS);
  const r1 = resourceForPhase(1, oversRemaining, wicketsRemaining);
  const r2 = resourceForPhase(2, oversRemaining, wicketsRemaining);
  return (1 - t) * r1 + t * r2;
}

function modelParamsPayload() {
  const labels = ['Overs 1–6', 'Overs 7–16', 'Overs 17–20'];
  const ids = ['pp1_6', 'pp7_16', 'pp17_20'];
  return {
    max_overs: MAX_OVERS,
    max_wickets: MAX_WICKETS,
    min_match_date: '2023-01-01',
    rr_shrinkage: {
      alpha_by_phase: [...RR_SHRINK_ALPHA_PHASE],
      mu_by_phase: [...RR_PHASE_MU],
      phase_labels: ['Overs 1–6', 'Overs 7–16', 'Overs 17–20'],
      formula:
        'RR_eff = α_k×RR + (1−α_k)×μ_k; k = same segment as Z₀,a (2023+ IPL)',
    },
    resource_model: {
      phase_labels: ['Overs 1–6', 'Overs 7–16', 'Overs 17–20'],
      phases: [
        { id: 'pp1_6', label: 'Overs 1–6', C: RESOURCE_PHASE_PARAMS[0][0], b: RESOURCE_PHASE_PARAMS[0][1], a_w: RESOURCE_PHASE_PARAMS[0][2] },
        { id: 'pp7_16', label: 'Overs 7–16', C: RESOURCE_PHASE_PARAMS[1][0], b: RESOURCE_PHASE_PARAMS[1][1], a_w: RESOURCE_PHASE_PARAMS[1][2] },
        { id: 'pp17_20', label: 'Overs 17–20', C: RESOURCE_PHASE_PARAMS[2][0], b: RESOURCE_PHASE_PARAMS[2][1], a_w: RESOURCE_PHASE_PARAMS[2][2] },
      ],
      wicket_gamma: RESOURCE_WICKET_GAMMA,
      phase_blend_overs: PHASE_BLEND_OVERS,
      formula:
        'R = C_k*(1-exp(-b_k*overs_remaining))*exp(-a_k*wickets_lost^gamma), blended near 6 and 16 overs',
    },
    phases: PHASE_Z0_A.map(([Z0, a], i) => ({
      id: ids[i],
      label: labels[i],
      Z0,
      a,
    })),
  };
}

function parseCsvSnapshots(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 9) continue;
    const [
      team,
      balls_bowled,
      overs_completed,
      overs_remaining,
      wickets,
      run_rate,
      current_score,
      final_total,
      match_file,
    ] = parts;
    out.push({
      team: team,
      balls_bowled: Number(balls_bowled),
      overs_completed: Number(overs_completed),
      overs_remaining: Number(overs_remaining),
      wickets: Number(wickets),
      run_rate: Number(run_rate),
      current_score: Number(current_score),
      final_total: Number(final_total),
      match_file: match_file,
    });
  }
  return out;
}

function getMatchMetadata(jsonDir) {
  const meta = {};
  if (!fs.existsSync(jsonDir) || !fs.statSync(jsonDir).isDirectory()) return meta;
  const files = fs.readdirSync(jsonDir);
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(jsonDir, name);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const info = data.info || {};
      const dates = info.dates || [];
      const dateStr = dates[0] || null;
      const teams = info.teams || [];
      const event = info.event || {};
      const eventName = typeof event === 'object' && event ? event.name || '' : '';
      const venue = info.venue || info.city || '';
      meta[name] = {
        date: dateStr,
        teams,
        event: eventName,
        venue,
      };
    } catch {
      // ignore bad JSON
    }
  }
  return meta;
}

function getRecentAndUpcoming(meta, pastDays) {
  const today = new Date();
  const cutoff = new Date(today.getTime() - Math.min(pastDays, 365 * 50) * 24 * 3600 * 1000);
  const recent = [];
  const upcoming = [];
  for (const [matchFile, m] of Object.entries(meta)) {
    if (!m.date) continue;
    const matchYear = parseInt(String(m.date).slice(0, 4), 10);
    if (!Number.isFinite(matchYear) || matchYear < MIN_DATA_YEAR) continue;
    const d = new Date(m.date);
    if (isNaN(d.getTime())) continue;
    if (d >= today) {
      upcoming.push({ matchFile, meta: m, date: d });
    } else if (d >= cutoff) {
      recent.push({ matchFile, meta: m, date: d });
    }
  }
  recent.sort((a, b) => b.date - a.date);
  upcoming.sort((a, b) => a.date - b.date);
  return { recent, upcoming };
}

function filterCompleteInningsOnly(rows) {
  if (!rows.length) return rows;
  const groups = {};
  for (const r of rows) {
    const key = `${r.match_file}::${r.team}`;
    if (!groups[key]) {
      groups[key] = { maxOvers: r.overs_completed, maxWickets: r.wickets };
    } else {
      if (r.overs_completed > groups[key].maxOvers) groups[key].maxOvers = r.overs_completed;
      if (r.wickets > groups[key].maxWickets) groups[key].maxWickets = r.wickets;
    }
  }
  return rows.filter(r => {
    const g = groups[`${r.match_file}::${r.team}`];
    return g && (g.maxOvers >= MAX_OVERS || g.maxWickets >= MAX_WICKETS);
  });
}

function sampleSnapshotsAtOvers(matchRows, oversPoints = [10, 15]) {
  const out = [];
  for (const target of oversPoints) {
    let best = null;
    let bestDiff = Infinity;
    for (const r of matchRows) {
      const diff = Math.abs(r.overs_completed - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = r;
      }
    }
    if (
      best &&
      best.overs_remaining > 0 &&
      best.run_rate > 0 &&
      MAX_WICKETS - best.wickets > 0
    ) {
      out.push(best);
    }
  }
  return out;
}

function predictScore(currentScore, runRate, oversRemaining, wicketsRemaining, oversCompleted) {
  const rrEff = effectiveRunRate(runRate, oversCompleted);
  const rf = resourceFactor(oversRemaining, wicketsRemaining, oversCompleted);
  return currentScore + rrEff * rf;
}

function buildRecentTestResults(recent, rows) {
  const results = [];
  for (const { matchFile, meta } of recent) {
    const matchRows = rows.filter(r => r.match_file === matchFile);
    if (!matchRows.length) continue;
    const teamName = matchRows[0].team;
    const snaps = sampleSnapshotsAtOvers(matchRows);
    for (const r of snaps) {
      const wicketsRemaining = MAX_WICKETS - r.wickets;
      const oc = r.overs_completed;
      const ph = powerplayPhase(oc);
      const pred = predictScore(
        r.current_score,
        r.run_rate,
        r.overs_remaining,
        wicketsRemaining,
        oc,
      );
      const actual = r.final_total;
      results.push({
        match_file: matchFile,
        date: meta.date,
        teams: meta.teams,
        event: meta.event,
        venue: meta.venue,
        innings_team: String(teamName),
        at_over: Number(oc.toFixed(1)),
        powerplay_phase: ph,
        current_score: Math.round(r.current_score),
        run_rate: Number(r.run_rate.toFixed(2)),
        wickets_lost: r.wickets,
        overs_remaining: Number(r.overs_remaining.toFixed(1)),
        predicted: Number(pred.toFixed(1)),
        actual: Math.round(actual),
        error: Number(Math.abs(pred - actual).toFixed(1)),
      });
    }
  }
  return results;
}

export default function handler(req, res) {
  try {
    const daysRaw = Array.isArray(req.query.days)
      ? req.query.days[0]
      : req.query.days;
    let pastDays = parseInt(daysRaw || '30', 10);
    if (!Number.isFinite(pastDays)) pastDays = 30;
    pastDays = Math.max(1, Math.min(9999, pastDays));

    const root = process.cwd();
    loadRuntimeModelParams(root);
    const csvPath = path.join(root, 'ipl_innings_snapshots.csv');
    const jsonDir = path.join(root, 'ipl_male_json');

    const meta = getMatchMetadata(jsonDir);
    const { recent } = getRecentAndUpcoming(meta, pastDays);
    const allRows = parseCsvSnapshots(csvPath);
    if (!allRows.length) {
      return res.status(200).json({
        results: [],
        summary: {
          count: 0,
          mae: 0,
          message: 'IPL CSV not found or empty',
          days_requested: pastDays,
        },
        model_params: modelParamsPayload(),
      });
    }

    const filtered = filterCompleteInningsOnly(allRows);
    const results = buildRecentTestResults(recent, filtered);
    if (!results.length) {
      return res.status(200).json({
        results: [],
        summary: {
          count: 0,
          mae: 0,
          message: `No IPL matches in the last ${pastDays} days in dataset.`,
          days_requested: pastDays,
        },
        model_params: modelParamsPayload(),
      });
    }

    const errors = results.map(r => r.error);
    const mae =
      errors.reduce((sum, e) => sum + e, 0) / (errors.length || 1);
    const rmse = Math.sqrt(
      errors.reduce((sum, e) => sum + e * e, 0) / (errors.length || 1),
    );

    res.status(200).json({
      results,
      summary: {
        count: results.length,
        matches_count: recent.length,
        mae: Number(mae.toFixed(2)),
        rmse: Number(rmse.toFixed(2)),
        days_requested: pastDays,
      },
      model_params: modelParamsPayload(),
    });
  } catch (err) {
    res.status(500).json({
      error: String(err),
      results: [],
      summary: { count: 0, mae: 0 },
      model_params: modelParamsPayload(),
    });
  }
}

