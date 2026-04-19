// Enhanced Win Probability API with Momentum Features
// Uses ball-by-ball data to calculate momentum and predict win probability

const fs = require('fs');
const path = require('path');

// Load the enhanced model
let model = null;
let venueStats = null;

// Load model and venue stats on startup
try {
  const modelPath = path.join(__dirname, '../base_momentum_model.pkl');
  const venueStatsPath = path.join(__dirname, '../venue_stats_train_years.json');
  
  if (fs.existsSync(modelPath)) {
    // For now, we'll use a simplified approach since we can't directly load pickle in Node.js
    console.log('[winprob-enhanced] Momentum-enhanced model found');
  }
  
  if (fs.existsSync(venueStatsPath)) {
    venueStats = JSON.parse(fs.readFileSync(venueStatsPath, 'utf8'));
    console.log('[winprob-enhanced] Loaded venue stats for', Object.keys(venueStats).length, 'venues');
  }
} catch (err) {
  console.error('[winprob-enhanced] Error loading model:', err);
}

// Simple momentum calculation (fallback if model not available)
function calculateMomentumScore(currentState, recentBalls = []) {
  if (!recentBalls || recentBalls.length === 0) {
    return { momentum_score: 0.5, recent_runs_rate: 6.0, batting_pressure: 0.0 };
  }
  
  const windowSize = Math.min(recentBalls.length, 6);
  const recent = recentBalls.slice(-windowSize);
  
  const totalRuns = recent.reduce((sum, ball) => sum + (ball.runs || 0), 0);
  const totalWickets = recent.reduce((sum, ball) => sum + (ball.wickets || 0), 0);
  const numBalls = recent.length;
  
  const recentRunsRate = (totalRuns / numBalls) * 6;
  const recentWicketRate = totalWickets / numBalls;
  
  const currentRRR = currentState.requiredRR || 8.0;
  const rrDiff = recentRunsRate - currentRRR;
  let momentum = 0.5 + (rrDiff / 20.0);
  
  const wicketPenalty = recentWicketRate * 0.3;
  momentum = Math.max(0.0, Math.min(1.0, momentum - wicketPenalty));
  
  let pressure = 0.0;
  if (currentRRR > 12) {
    pressure = Math.min(1.0, (currentRRR - 12) / 8.0);
  }
  if (recentWicketRate > 0.2) {
    pressure = Math.max(pressure, 0.7);
  }
  
  return {
    momentum_score: momentum,
    recent_runs_rate: recentRunsRate,
    recent_wicket_rate: recentWicketRate,
    batting_pressure: pressure
  };
}

// Simplified win probability calculation (fallback)
function calculateWinProbability(runs, wickets, overs, target, momentumFeatures) {
  const legalBalls = Math.floor(overs * 6);
  const ballsRemaining = 120 - legalBalls;
  const runsNeeded = target - runs;
  const wicketsRemaining = 10 - wickets;
  
  const currentRR = legalBalls > 0 ? (runs / legalBalls) * 6 : 0;
  const requiredRR = ballsRemaining > 0 ? (runsNeeded / ballsRemaining) * 6 : 999;
  
  // Base probability from run rates
  let winProb = 0.5;
  if (requiredRR > 0) {
    winProb = Math.max(0.1, Math.min(0.9, currentRR / (currentRR + requiredRR)));
  }
  
  // Adjust for momentum
  if (momentumFeatures) {
    const momentumAdj = (momentumFeatures.momentum_score - 0.5) * 0.3;
    winProb = Math.max(0.05, Math.min(0.95, winProb + momentumAdj));
    
    // Adjust for pressure
    const pressureAdj = momentumFeatures.batting_pressure * 0.2;
    winProb = Math.max(0.05, Math.min(0.95, winProb - pressureAdj));
  }
  
  // Adjust for wickets
  const wicketAdj = (wicketsRemaining / 10) * 0.1;
  winProb = Math.max(0.05, Math.min(0.95, winProb + wicketAdj));
  
  return winProb;
}

function getVenueStats(venueName) {
  if (!venueStats) return { avg_first_innings: 193, chasing_efficiency: 0.52 };
  
  // Try exact match first
  if (venueStats[venueName]) {
    return venueStats[venueName];
  }
  
  // Try partial match
  for (const [venue, stats] of Object.entries(venueStats)) {
    if (venue.toLowerCase().includes(venueName.toLowerCase()) || 
        venueName.toLowerCase().includes(venue.toLowerCase())) {
      return stats;
    }
  }
  
  // Fallback to defaults
  return { avg_first_innings: 193, chasing_efficiency: 0.52 };
}

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { runs, wickets, overs, target, venue, recent_balls } = req.body;
    
    // Validate required fields
    if (typeof runs !== 'number' || typeof wickets !== 'number' || 
        typeof overs !== 'number' || typeof target !== 'number') {
      return res.status(400).json({
        error: 'Missing required fields: runs, wickets, overs, target'
      });
    }
    
    // Validate ranges
    if (runs < 0 || wickets < 0 || wickets > 10 || overs < 0 || overs > 20 || target < 0) {
      return res.status(400).json({
        error: 'Invalid parameter ranges'
      });
    }
    
    // Calculate momentum features
    const currentState = {
      runs,
      wickets,
      overs,
      target,
      requiredRR: overs < 20 ? ((target - runs) / (120 - overs * 6)) * 6 : 999
    };
    
    const momentumFeatures = calculateMomentumScore(currentState, recent_balls);
    
    // Get venue statistics
    const venueStats = getVenueStats(venue);
    
    // Calculate win probability
    const winProb = calculateWinProbability(runs, wickets, overs, target, momentumFeatures);
    
    const response = {
      chasing_team_win_prob: Math.round(winProb * 100 * 100) / 100, // Round to 2 decimal places
      defending_team_win_prob: Math.round((1 - winProb) * 100 * 100) / 100,
      current_rr: Math.round(((runs / (overs * 6)) * 6) * 100) / 100,
      required_rr: Math.round((((target - runs) / (120 - overs * 6)) * 6) * 100) / 100,
      runs_needed: Math.max(0, target - runs),
      balls_remaining: Math.max(0, 120 - Math.floor(overs * 6)),
      momentum_score: Math.round(momentumFeatures.momentum_score * 1000) / 10,
      recent_runs_rate: Math.round(momentumFeatures.recent_runs_rate * 10) / 10,
      batting_pressure: Math.round(momentumFeatures.batting_pressure * 1000) / 10,
      venue_stats: venueStats,
      match_state: {
        runs,
        wickets,
        overs,
        target,
        venue
      }
    };
    
    console.log('[winprob-enhanced] Prediction:', {
      runs, wickets, overs, target,
      chasing_prob: response.chasing_team_win_prob,
      momentum: response.momentum_score
    });
    
    return res.status(200).json(response);
    
  } catch (err) {
    console.error('[winprob-enhanced] Error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
};
