const fs = require('fs');
const path = require('path');

const OUTCOMES = ['W', '0', '1', '2', '3', '4', '6'];
let cachedModel = null;

function loadModel() {
  if (cachedModel) return cachedModel;
  const p = path.join(__dirname, '../data/winprob_sim_model.json');
  cachedModel = JSON.parse(fs.readFileSync(p, 'utf8'));
  return cachedModel;
}

function oversToBalls(oversInput) {
  const s = String(oversInput || '0').trim();
  const parts = s.split('.');
  const ov = parseInt(parts[0] || '0', 10) || 0;
  const b = parseInt(parts[1] || '0', 10) || 0;
  return ov * 6 + Math.min(Math.max(b, 0), 5);
}

function phaseFromBall(ball) {
  const over = Math.floor((ball - 1) / 6);
  if (over < 6) return 'pp';
  if (over < 15) return 'mid';
  return 'death';
}

function rrrBucket(rrr) {
  if (rrr < 6) return 'lt6';
  if (rrr < 8) return '6_8';
  if (rrr < 10) return '8_10';
  if (rrr < 12) return '10_12';
  return 'ge12';
}

function ballsBucket(ballsRemaining) {
  if (ballsRemaining > 90) return '91_120';
  if (ballsRemaining > 60) return '61_90';
  if (ballsRemaining > 30) return '31_60';
  return '1_30';
}

function makeKey(legalBallsBowled, wicketsLost, runsNeeded, ballsRemaining) {
  const nextBall = legalBallsBowled + 1;
  const phase = phaseFromBall(nextBall);
  const rrr = ballsRemaining > 0 ? (runsNeeded / ballsRemaining) * 6 : 99;
  return `${phase}|${Math.min(10, Math.max(0, wicketsLost))}|${rrrBucket(rrr)}|${ballsBucket(ballsRemaining)}`;
}

function weightedSample(probMap) {
  const u = Math.random();
  let c = 0;
  for (const o of OUTCOMES) {
    c += Number(probMap[o] || 0);
    if (u <= c) return o;
  }
  return '0';
}

function simulateOnce(model, runs, wickets, target, legalBallsBowled) {
  let r = runs;
  let w = wickets;
  let b = legalBallsBowled;
  while (b < 120 && w < 10 && r < target) {
    const ballsRemaining = 120 - b;
    const runsNeeded = Math.max(0, target - r);
    const key = makeKey(b, w, runsNeeded, ballsRemaining);
    const row = model.table[key];
    const probs = row && row.n >= 15 ? row.probs : model.global_probs;
    const out = weightedSample(probs);
    if (out === 'W') {
      w += 1;
    } else {
      r += Number(out);
    }
    b += 1;
  }
  return r >= target ? 1 : 0;
}

module.exports = async function handler(req, res) {
  try {
    const model = loadModel();
    const runs = Number(req.query.runs || 0);
    const wickets = Number(req.query.wickets || 0);
    const target = Number(req.query.target || 0);
    const overs = req.query.overs || '0';
    const sims = Math.min(20000, Math.max(1000, Number(req.query.sims || 6000)));

    if (!target || target < 1) {
      return res.status(400).json({ error: 'target is required' });
    }
    const legalBallsBowled = oversToBalls(overs);
    const ballsRemaining = Math.max(0, 120 - legalBallsBowled);
    const runsNeeded = Math.max(0, target - runs);

    if (runsNeeded <= 0) {
      return res.status(200).json({ chasing_win_prob: 1, defending_win_prob: 0, sims });
    }
    if (ballsRemaining <= 0 || wickets >= 10) {
      return res.status(200).json({ chasing_win_prob: 0, defending_win_prob: 1, sims });
    }

    let wins = 0;
    for (let i = 0; i < sims; i++) {
      wins += simulateOnce(model, runs, wickets, target, legalBallsBowled);
    }
    const p = wins / sims;
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).json({
      chasing_win_prob: p,
      defending_win_prob: 1 - p,
      sims,
      state: { runs, wickets, overs: String(overs), target, runs_needed: runsNeeded, balls_remaining: ballsRemaining },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
