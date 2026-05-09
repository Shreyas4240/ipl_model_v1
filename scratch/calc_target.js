const fs = require('fs');
const path = require('path');

// Ported logic from api/predict.js
function getResourceModelParams(modelParams) {
  const m = modelParams && modelParams.resource_model;
  if (m) return { phases: m.phases, wicketGamma: Number(m.wicket_gamma || 2.5) };
  return {
    phases: [{ C: 35.18, b: 0.051, a_w: 0.011 }, { C: 29.69, b: 0.054, a_w: 0.003 }, { C: 45.67, b: 0.041, a_w: 0.002 }],
    wicketGamma: 2.5
  };
}

function resourceForPhase(phaseIdx, oversRem, wicketsRem, model) {
  const p = model.phases[phaseIdx];
  const wicketsLost = 10 - wicketsRem;
  return p.C * (1 - Math.exp(-p.b * oversRem)) * Math.exp(-p.a_w * Math.pow(wicketsLost, model.wicketGamma));
}

function totalResource(overs, wicketsLost, model) {
    // For simplicity, we use the phase appropriate for the total overs.
    // Full 20 overs usually spans multiple phases, but let's use the most representative one (Phase 1/2).
    // Actually, the project's resourceFactor blends them.
    
    // Let's use the blended resourceFactor logic from predict.js
    const d = 0.5;
    const calc = (oc, or, wr) => {
        if (oc <= 6 - d) return resourceForPhase(0, or, wr, model);
        if (oc >= 6 + d && oc <= 16 - d) return resourceForPhase(1, or, wr, model);
        if (oc >= 16 + d) return resourceForPhase(2, or, wr, model);
        if (oc > 6 - d && oc < 6 + d) {
            const t = (oc - (6 - d)) / (2 * d);
            return (1 - t) * resourceForPhase(0, or, wr, model) + t * resourceForPhase(1, or, wr, model);
        }
        const t = (oc - (16 - d)) / (2 * d);
        return (1 - t) * resourceForPhase(1, or, wr, model) + t * resourceForPhase(2, or, wr, model);
    };
    return calc;
}

const params = JSON.parse(fs.readFileSync('data/model_params.json', 'utf8'));
const model = getResourceModelParams(params);
const resFunc = totalResource(20, 0, model);

// Scenario: 
// Innings 1: LSG 209/3 in 19.0 overs (interrupted at 19)
// Original available: 20 overs, 10 wickets.
// Resource available to LSG (R1):
// They used 19 overs. At 19.0 overs, they had 0 overs remaining and 3 wickets lost.
// But they started with 20.
// R1 = Resource(20, 10) - Resource(1, 7)? No.
// DLS Logic: R1 = (Resource available at start) - (Resource lost due to interruption)
// Resource at start (20 overs, 10 wickets):
const R_start = resFunc(0, 20, 10);
// Resource lost at 19.0 overs (1.0 overs remaining, 7 wickets remaining):
const R_lost = resFunc(19, 1, 7);
const R1 = R_start - R_lost;

// Innings 2: RCB 19 overs, 10 wickets.
// Resource available to RCB (R2):
const R2 = resFunc(0, 19, 10);

const score1 = 209;
const parScore = score1 * (R2 / R1);
const target = Math.ceil(parScore + 0.00001); // Standard DLS target is par + 1 if batting second

console.log(`Model Parameters: ${JSON.stringify(model.phases[2])}`);
console.log(`R1 (LSG): ${R1.toFixed(4)}`);
console.log(`R2 (RCB): ${R2.toFixed(4)}`);
console.log(`Ratio (R2/R1): ${(R2/R1).toFixed(4)}`);
console.log(`Par Score: ${parScore.toFixed(2)}`);
console.log(`Revised Target: ${target}`);
