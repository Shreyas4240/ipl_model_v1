const fs = require('fs');
const path = require('path');
const { getLiveMatchesData } = require('./live');

/**
 * Win Probability Simulation Logic
 * (Ported from api/winprob.js)
 */

const OUTCOMES = ['W', '0', '1', '2', '3', '4', '6'];

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

/**
 * Main API Handler
 */
module.exports = async function handler(req, res) {
  try {
    // 1. Load Simulation Model
    const modelPath = path.join(__dirname, '../data/winprob_sim_model.json');
    if (!fs.existsSync(modelPath)) {
      return res.status(500).json({ error: 'Simulation model not found' });
    }
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

    // 2. Fetch Live Matches
    const liveData = await getLiveMatchesData();
    const matches = liveData.matches || [];

    // 3. Process each match for Win Probability
    const matchesWithProb = matches.map((match) => {
      // Win probability is only applicable for 2nd innings (chasing)
      if (!match.innings2 || !match.innings1 || match.status !== 'live') {
        return {
          ...match,
          win_probability: null,
          note: match.status === 'live' ? 'Win probability requires 2nd innings data' : 'Match not live'
        };
      }

      const runs = Number(match.innings2.runs || 0);
      const wickets = Number(match.innings2.wickets || 0);
      const overs = match.innings2.overs || '0';
      const target = Number(match.innings1.runs || 0) + 1;
      
      const legalBallsBowled = oversToBalls(overs);
      const sims = 3000; // Sufficient for a quick API response
      
      let wins = 0;
      for (let i = 0; i < sims; i++) {
        wins += simulateOnce(model, runs, wickets, target, legalBallsBowled);
      }
      
      const p = wins / sims;
      
      return {
        ...match,
        win_probability: {
          chasing_team: match.teams[1],
          defending_team: match.teams[0],
          chasing_win_prob: Math.round(p * 100) / 100,
          defending_win_prob: Math.round((1 - p) * 100) / 100,
          sims,
          state: {
            runs,
            wickets,
            overs,
            target,
            runs_needed: Math.max(0, target - runs),
            balls_remaining: Math.max(0, 120 - legalBallsBowled)
          }
        }
      };
    });

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      matches: matchesWithProb,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[live-winprob] Error:', err.message);
    return res.status(500).json({ error: err.message, matches: [] });
  }
};
