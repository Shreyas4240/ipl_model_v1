// Test the win probability model against PBKS vs LSG live data
const axios = require('axios');
const HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cricbuzz.com'};

// Model params from model_params.json
const fs = require('fs');
const mp = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8'));
const ALPHA = mp.rr_shrinkage.alpha_by_phase;
const MU    = mp.rr_shrinkage.mu_by_phase;
const PHASES = mp.resource_model.phases;
const GAMMA = mp.resource_model.wicket_gamma;
const BLEND = mp.resource_model.phase_blend_overs;
const IPL_AVG = 193; // Wankhede avg = 194

function phase(oc) { return oc <= 6 ? 0 : oc <= 16 ? 1 : 2; }

function resourceForPhase(pi, oversRem, wicketsRem) {
  const {C, b, a_w} = PHASES[pi];
  const wl = Math.max(0, 10 - wicketsRem);
  return C * (1 - Math.exp(-b * oversRem)) * Math.exp(-a_w * Math.pow(wl, GAMMA));
}

function resourceFactor(oversRem, wicketsRem, oc) {
  const d = BLEND;
  if (oc <= 6-d) return resourceForPhase(0, oversRem, wicketsRem);
  if (oc >= 6+d && oc <= 16-d) return resourceForPhase(1, oversRem, wicketsRem);
  if (oc >= 16+d) return resourceForPhase(2, oversRem, wicketsRem);
  if (oc < 6+d) {
    const t = (oc-(6-d))/(2*d);
    return (1-t)*resourceForPhase(0,oversRem,wicketsRem) + t*resourceForPhase(1,oversRem,wicketsRem);
  }
  const t = (oc-(16-d))/(2*d);
  return (1-t)*resourceForPhase(1,oversRem,wicketsRem) + t*resourceForPhase(2,oversRem,wicketsRem);
}

function predict(score, oc, wickets) {
  if (oc <= 0) return IPL_AVG;
  const oversRem = Math.max(0, 20 - oc);
  const rr = score / oc;
  const k = phase(oc);
  const rrEff = ALPHA[k]*rr + (1-ALPHA[k])*MU[k];
  const wr = 10 - wickets;
  return score + rrEff * resourceFactor(oversRem, wr, oc);
}

function sigma(oc) {
  if (oc <= 6) return 30.8;
  if (oc <= 12) return 23.3;
  if (oc <= 16) return 16.6;
  return 11.8;
}

function normalCDF(z) {
  const t = 1/(1+0.2316419*Math.abs(z));
  const poly = t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  const p = 1-(1/Math.sqrt(2*Math.PI))*Math.exp(-0.5*z*z)*poly;
  return z >= 0 ? p : 1-p;
}

function inn1WinProb(score, wickets, oc, avg) {
  avg = avg || IPL_AVG;
  if (oc <= 0) return 0.5;
  const pred = predict(score, oc, wickets);
  const threshold = (avg + pred) / 2;
  const z = (threshold - pred) / sigma(oc);
  const p = 1 - normalCDF(z);
  return Math.min(0.95, Math.max(0.05, p));
}

// Parse ball-by-ball from over-by-over page
function parseBalls(html) {
  const gridIdx = html.indexOf('Overs</div>');
  if (gridIdx < 0) return [];
  const section = html.slice(gridIdx, gridIdx + 80000);
  const plain = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const overBlocks = [];
  let i = 0;
  while (i < lines.length) {
    const ovMatch = lines[i].match(/^Ov\s+(\d+)$/);
    if (ovMatch) {
      const overNum = parseInt(ovMatch[1]);
      if (i+1 < lines.length) {
        const sm = lines[i+1].match(/^(\d+)-(\d+)$/);
        if (sm) {
          const balls = [];
          let j = i+3;
          while (j < lines.length && !lines[j].match(/^Ov\s+\d+$/) && !lines[j].match(/^FEATURED/)) {
            balls.push(lines[j]); j++;
          }
          overBlocks.push({overNum, startRuns: parseInt(sm[1]), startWickets: parseInt(sm[2]), balls});
          i = j; continue;
        }
      }
    }
    i++;
  }
  overBlocks.sort((a,b) => a.overNum - b.overNum);

  const result = [];
  overBlocks.forEach(blk => {
    let cumRuns = blk.startRuns, cumWickets = blk.startWickets, legalInOver = 0;
    const ballItems = blk.balls[blk.balls.length-1] && blk.balls[blk.balls.length-1].match(/^\d+$/)
      ? blk.balls.slice(0,-1) : blk.balls;
    for (const ball of ballItems) {
      const isWide = /^Wd/i.test(ball), isNoBall = /^Nb/i.test(ball);
      const isWicket = ball === 'W', isDot = ball === '•';
      const legBye = ball.match(/^L(\d+)$/), bye = ball.match(/^B(\d+)$/), runs = ball.match(/^(\d+)$/);
      let runsScored = 0, isLegal = true;
      if (isWide) { runsScored=1; isLegal=false; }
      else if (isNoBall) { runsScored=1; isLegal=false; }
      else if (isWicket) { cumWickets++; }
      else if (isDot) {}
      else if (legBye) { runsScored=parseInt(legBye[1]); }
      else if (bye) { runsScored=parseInt(bye[1]); }
      else if (runs) { runsScored=parseInt(runs[1]); }
      else continue;
      cumRuns += runsScored;
      if (isLegal) legalInOver++;
      const oc = (blk.overNum-1) + legalInOver/6;
      result.push({oc: parseFloat(oc.toFixed(3)), runs: cumRuns, wickets: cumWickets});
    }
  });
  return result;
}

axios.get('https://www.cricbuzz.com/live-cricket-over-by-over/151840/pbks-vs-lsg-29th-match-indian-premier-league-2026', {headers: HEADERS, timeout: 15000})
  .then(r => {
    const balls = parseBalls(r.data);
    console.log(`Total balls: ${balls.length}`);
    console.log('\nBall-by-ball win prob (PBKS batting first, venue avg=194):');
    console.log('OC      Score    Pred    WinProb');
    balls.forEach(b => {
      const pred = predict(b.runs, b.oc, b.wickets);
      const p = inn1WinProb(b.runs, b.wickets, b.oc, 194);
      process.stdout.write(`${b.oc.toFixed(2).padStart(5)}  ${String(b.runs+'/'+b.wickets).padEnd(7)}  ${Math.round(pred).toString().padStart(4)}    ${Math.round(p*100)}%\n`);
    });
  })
  .catch(e => console.error(e.message));
