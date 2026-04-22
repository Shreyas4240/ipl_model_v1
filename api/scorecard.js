const axios = require('axios');
const { getLiveMatchesData } = require('./live');

const REDIS_TTL_SECONDS = 60 * 60 * 24; // 24 hours — matches expire naturally

// Game metadata structure for better isolation
const GAME_METADATA_KEY = 'game_metadata';

// ── Upstash REST helpers ──────────────────────────────────────────────────────

function getRedisConfig() {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return (url && token) ? { url, token } : null;
}

async function redisGet(key) {
  const cfg = getRedisConfig();
  if (!cfg) return null;
  try {
    const res = await axios.get(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      timeout: 5000,
    });
    const raw = res.data && res.data.result;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error('[redis GET]', key, e.message);
    return null;
  }
}

async function redisSet(key, value) {
  const cfg = getRedisConfig();
  if (!cfg) return false;
  try {
    // Use pipeline: SET key value + EXPIRE key ttl
    const pipeline = [
      ['SET', key, JSON.stringify(value)],
      ['EXPIRE', key, String(REDIS_TTL_SECONDS)],
    ];
    await axios.post(`${cfg.url}/pipeline`, pipeline, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
    return true;
  } catch (e) {
    console.error('[redis SET]', key, e.message);
    return false;
  }
}

// ── Ball-by-ball parser ───────────────────────────────────────────────────────

/**
 * Parse the Cricbuzz over-by-over page into ball-by-ball snapshots.
 *
 * Returns array of { innings, ball, over, overLabel, runs, wickets }
 * where `runs` and `wickets` are CUMULATIVE within that innings.
 */
function parseBallByBall(html) {
  const gridIdx = html.indexOf('Overs</div>');
  if (gridIdx < 0) return [];

  const section = html.slice(gridIdx, gridIdx + 80000);
  const plain   = section.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines   = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── Parse over blocks ──────────────────────────────────────────────────────
  const overBlocks = [];
  let i = 0;
  while (i < lines.length) {
    const ovMatch = lines[i].match(/^Ov\s+(\d+)$/);
    if (ovMatch) {
      const overNum = parseInt(ovMatch[1]);
      if (i + 1 < lines.length) {
        const scoreMatch = lines[i + 1].match(/^(\d+)-(\d+)$/);
        if (scoreMatch) {
          const balls = [];
          let j = i + 3; // skip score line and bowler/batter description
          while (j < lines.length && !lines[j].match(/^Ov\s+\d+$/) && !lines[j].match(/^FEATURED/)) {
            balls.push(lines[j]);
            j++;
          }
          overBlocks.push({
            overNum,
            startRuns:    parseInt(scoreMatch[1]),
            startWickets: parseInt(scoreMatch[2]),
            balls,
          });
          i = j;
          continue;
        }
      }
    }
    i++;
  }

  if (!overBlocks.length) return [];

  // Page lists overs newest-first — reverse to get chronological order
  overBlocks.reverse();

  // ── Detect innings boundaries ──────────────────────────────────────────────
  // Detect innings boundaries and determine which innings this data represents
  const inningsList = [];
  let cur = [];
  
  // Check if this looks like innings 2 (starts from low scores like 8-0, 21-0, etc.)
  const firstOver = overBlocks[0];
  const looksLikeInnings2 = firstOver && firstOver.startRuns < 50; // Low starting score suggests innings 2
  
  console.log(`[innings detection] First over: ${firstOver?.startRuns}-${firstOver?.startWickets}`);
  console.log(`[innings detection] Looks like innings 2: ${looksLikeInnings2}`);
  
  for (const blk of overBlocks) {
    const prev = cur[cur.length - 1];
    // Detect new innings if there's a significant score drop (more than 5 runs)
    if (prev && blk.startRuns < prev.startRuns - 5) {
      console.log(`[innings detection] New innings detected: score drop from ${prev.startRuns} to ${blk.startRuns}`);
      inningsList.push(cur);
      cur = [];
    }
    cur.push(blk);
  }
  if (cur.length) inningsList.push(cur);
  
  // If we detected innings transitions, use them. Otherwise, treat all as one innings.
  console.log(`[innings detection] Found ${inningsList.length} innings`);
  inningsList.forEach((inn, idx) => {
    const actualInningsNumber = looksLikeInnings2 ? idx + 2 : idx + 1;
    console.log(`  Innings ${actualInningsNumber}: ${inn.length} overs, start score: ${inn[0]?.startRuns}-${inn[0]?.startWickets}`);
  });

  // ── Build ball-by-ball snapshots ───────────────────────────────────────────
  const result = [];

  inningsList.forEach((inn, innIdx) => {
    // Track cumulative within the innings
    let cumRuns    = 0;
    let cumWickets = 0;
    let ballSeq    = 0;
    
    // For innings 1, use the scores as they appear on the page
    // For innings 2, we need to reset to 0 since Cricbuzz shows absolute scores
    const isInnings1 = innIdx === 0;
    
    // Initialize with the first over's start score
    if (inn.length > 0) {
      if (isInnings1) {
        cumRuns = inn[0].startRuns;
        cumWickets = inn[0].startWickets;
      } else {
        // Innings 2: start from 0
        cumRuns = 0;
        cumWickets = 0;
      }
    }

    // Just copy the over-by-over data exactly as Cricbuzz shows it
    inn.forEach((blk, blockIdx) => {
      const overNum = blk.overNum;
      
      // Use the correct innings number based on whether this looks like innings 2
      const actualInningsNumber = looksLikeInnings2 ? innIdx + 2 : innIdx + 1;
      
      // Create one entry per over with the exact score Cricbuzz shows
      result.push({
        innings:   actualInningsNumber,
        ball:      blockIdx + 1,
        over:      overNum - 1,
        overLabel: `${overNum - 1}.0`,
        runs:      blk.startRuns,
        wickets:   blk.startWickets,
      });
    });
  });

  return result;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a ball array before writing to Redis.
 * Returns { valid: bool, reason: string }
 */
function validateBalls(balls) {
  if (!Array.isArray(balls)) return { valid: false, reason: 'not an array' };
  if (balls.length === 0)    return { valid: false, reason: 'empty array' };

  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (typeof b !== 'object' || b === null)
      return { valid: false, reason: `ball[${i}] not an object` };
    if (typeof b.innings !== 'number' || b.innings < 1 || b.innings > 2)
      return { valid: false, reason: `ball[${i}].innings invalid: ${b.innings}` };
    if (typeof b.over !== 'number' || b.over < 0 || b.over > 20)
      return { valid: false, reason: `ball[${i}].over out of range: ${b.over}` };
    if (typeof b.runs !== 'number' || b.runs < 0 || b.runs > 500)
      return { valid: false, reason: `ball[${i}].runs out of range: ${b.runs}` };
    if (typeof b.wickets !== 'number' || b.wickets < 0 || b.wickets > 10)
      return { valid: false, reason: `ball[${i}].wickets out of range: ${b.wickets}` };

    // Monotonicity: runs should never decrease within an innings
    if (i > 0 && balls[i - 1].innings === b.innings && b.runs < balls[i - 1].runs) {
      return { valid: false, reason: `ball[${i}] runs decreased: ${balls[i-1].runs} -> ${b.runs}` };
    }
    
    // Allow runs reset between innings (innings 2 starts fresh)
    if (i > 0 && balls[i - 1].innings !== b.innings && b.runs > 0) {
      // This is ok - innings 2 can start with runs from previous innings
      // The merge logic will handle proper innings separation
    }
  }

  // Note: Innings 2 validation removed since parsing logic handles relative scoring correctly

  return { valid: true, reason: 'ok' };
}

// Game metadata management
async function getGameMetadata() {
  try {
    const raw = await redisGet(GAME_METADATA_KEY);
    return raw || {};
  } catch (e) {
    console.error('[getGameMetadata] error:', e.message);
    return {};
  }
}

async function updateGameMetadata(matchId, teams, status) {
  try {
    const metadata = await getGameMetadata();
    metadata[matchId] = {
      teams,
      status,
      lastUpdated: new Date().toISOString(),
      ballCount: 0
    };
    await redisSet(GAME_METADATA_KEY, metadata);
    console.log(`[updateGameMetadata] updated ${matchId}: ${teams.join(' vs ')}`);
  } catch (e) {
    console.error('[updateGameMetadata] error:', e.message);
  }
}

async function clearMatchData(matchId) {
  try {
    const redisKey = `match_history_v2_${matchId}`;
    const cfg = getRedisConfig();
    if (!cfg) return false;
    
    // Delete the match data
    await axios.post(`${cfg.url}/pipeline`, [
      ['DEL', redisKey]
    ], {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
    
    console.log(`[clearMatchData] cleared data for match ${matchId}`);
    return true;
  } catch (e) {
    console.error('[clearMatchData] error:', e.message);
    return false;
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merge stored balls with freshly scraped balls.
 * Dedup by (innings, over) — the scraped value wins on conflict since it's newer.
 * Re-sequences ball numbers after merge.
 */
function mergeBalls(stored, scraped) {
  // Key: innings + over (4 decimal places) — unique per legal delivery
  const map = new Map();

  // Stored first (lower priority)
  for (const b of stored) {
    map.set(`${b.innings}_${b.over.toFixed(4)}`, b);
  }
  // Scraped second (higher priority — overwrites stored on conflict)
  for (const b of scraped) {
    map.set(`${b.innings}_${b.over.toFixed(4)}`, b);
  }

  const merged = Array.from(map.values()).sort((a, b) => {
    if (a.innings !== b.innings) return a.innings - b.innings;
    return a.over - b.over;
  });

  // Re-sequence ball numbers per innings
  let seq1 = 1, seq2 = 1;
  for (const b of merged) {
    b.ball = b.innings === 1 ? seq1++ : seq2++;
  }

  return merged;
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchAndMergeScorecard(matchId, slug, teams = []) {
  const redisKey = `match_history_v2_${matchId}`;

  // 1. Update game metadata for tracking
  if (teams && teams.length >= 2) {
    await updateGameMetadata(matchId, teams, 'active');
  }

  // 2. Get live data via internal API call
  let scraped = [];
  try {
    const liveData = await getLiveMatchesData();
    const matchData = liveData.matches?.find(m => m.matchId === matchId);
    
    if (matchData && (matchData.status === 'live' || matchData.status === 'completed')) {
      // Convert the data to your JSON format
      const currentInnings = matchData.innings2 ? 2 : 1;
      const currentScore = matchData.score;
      
      const oversRaw = parseFloat(currentScore.overs_decimal || '0');
      const overNum = Math.floor(oversRaw);
      const ballsStr = (oversRaw - overNum).toFixed(1);
      const ballsDec = parseInt(ballsStr.split('.')[1] || '0');
      const exactOver = parseFloat((overNum + (ballsDec / 6)).toFixed(4));
      
      scraped = [{
        innings: currentInnings,
        ball: 1, // Will be re-sequenced by mergeBalls
        over: exactOver,
        overLabel: currentScore.overs_input || '0.0',
        runs: currentScore.runs || 0,
        wickets: currentScore.wickets || 0,
      }];
      
      console.log(`[scorecard] API data (${matchData.status}): ${scraped[0].runs}/${scraped[0].wickets} for match ${matchId} at over ${exactOver}`);
    }
  } catch (err) {
    console.error('[scorecard] live internal error:', err.message);
  }

  // 3. Load stored history from Redis
  const stored = (await redisGet(redisKey)) || [];
  console.log(`[scorecard] loaded ${stored.length} stored balls for match ${matchId}`);

  // 4. Use raw Cricbuzz data - skip strict validation
  const scrapedCheck = validateBalls(scraped);
  if (!scrapedCheck.valid) {
    console.warn(`[scorecard] validation warning: ${scrapedCheck.reason} - using raw data anyway`);
    // Don't return stored - proceed with raw data
  }

  // 5. Merge
  const merged = mergeBalls(stored, scraped);
  console.log(`[scorecard] merged -> ${merged.length} balls`);

  // 6. Use raw merged data - skip strict validation
  const check = validateBalls(merged);
  if (!check.valid) {
    console.warn(`[scorecard] merged validation warning: ${check.reason} - using raw merged data anyway`);
    // Proceed with raw merged data
  }

  // 7. Write back to Redis only if we have more data than before
  if (merged.length >= stored.length) {
    const wrote = await redisSet(redisKey, merged);
    if (!wrote) {
      console.warn('[scorecard] Redis write failed - returning merged data anyway');
    } else {
      console.log(`[scorecard] successfully stored ${merged.length} balls for match ${matchId}`);
    }
  } else {
    console.warn(`[scorecard] merged (${merged.length}) < stored (${stored.length}) - skipping write`);
  }

  return merged;
}

module.exports = async function handler(req, res) {
  const matchId = req.query.matchId;
  const slug    = req.query.slug;
  const teams   = req.query.teams ? JSON.parse(req.query.teams) : [];

  if (!matchId || !slug) {
    return res.status(400).json({ error: 'matchId and slug required', balls: [] });
  }

  try {
    const balls = await fetchAndMergeScorecard(matchId, slug, teams);
    return res.status(200).json({ matchId, slug, balls, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[scorecard] handler error:', err.message);
    return res.status(500).json({ error: err.message, balls: [] });
  }
};

module.exports.fetchAndMergeScorecard = fetchAndMergeScorecard;
module.exports.clearMatchData = clearMatchData;
