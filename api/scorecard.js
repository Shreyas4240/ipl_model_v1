const axios = require('axios');
const live = require('./live');
const getLiveMatchesData =
  typeof live.getLiveMatchesData === 'function'
    ? live.getLiveMatchesData
    : (typeof live === 'function' ? live : null);

const REDIS_TTL_SECONDS = 60 * 60 * 24; // 24 hours

const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Referer': 'https://www.cricbuzz.com'
};
const NDTV_LIVE_SCORES_URL = 'https://sports.ndtv.com/cricket/live-scores';

const TEAM_CODE_MAP = {
  'Chennai Super Kings': 'csk',
  'Delhi Capitals': 'dc',
  'Gujarat Titans': 'gt',
  'Kolkata Knight Riders': 'kkr',
  'Lucknow Super Giants': 'lsg',
  'Mumbai Indians': 'mi',
  'Punjab Kings': 'pbks',
  'Rajasthan Royals': 'rr',
  'Royal Challengers Bengaluru': 'rcb',
  'Sunrisers Hyderabad': 'srh',
};

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

function extractJsonObjectAtKey(src, key) {
  const keyPos = src.indexOf(key);
  if (keyPos < 0) return null;
  const start = src.indexOf('{', keyPos);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function extractBalancedObjectLoose(src, key) {
  const keyPos = src.indexOf(key);
  if (keyPos < 0) return null;
  const start = src.indexOf('{', keyPos);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function oversToBall(overs) {
  const s = String(overs || '0');
  const p = s.split('.');
  const b = parseInt(p[1] || '0', 10);
  if (!Number.isFinite(b) || b < 0) return 0;
  return Math.min(6, b);
}

function parseBallFromText(commText) {
  const t = String(commText || '');
  const m = t.match(/^\s*(\d+)\.(\d)\s+/);
  if (!m) return null;
  const overInt = Number(m[1]);
  const ball = Number(m[2]);
  if (!Number.isFinite(overInt) || !Number.isFinite(ball)) return null;
  return { overInt, ball };
}

function parseCommentaryBallsFromHtml(html) {
  let rawObj = extractJsonObjectAtKey(html, '"matchPreviewFullComm":');
  let isEscaped = false;
  if (!rawObj) {
    rawObj = extractBalancedObjectLoose(html, '\\"matchPreviewFullComm\\":');
    isEscaped = !!rawObj;
  }
  if (!rawObj) return [];
  if (isEscaped) {
    rawObj = rawObj.replace(/\\"/g, '"');
  }
  let payload = null;
  try {
    payload = JSON.parse(rawObj);
  } catch (e) {
    console.error('[scorecard] commentary JSON parse failed:', e.message);
    return [];
  }

  const nowIso = new Date().toISOString();
  const inningsSections = Array.isArray(payload.commentary) ? payload.commentary : [];
  const out = [];

  inningsSections.forEach((section, sectionIdx) => {
    const inningsIdRaw = safeNumber(section?.inningsId, sectionIdx + 1);
    const innings = inningsIdRaw && inningsIdRaw > 0 ? Math.min(2, inningsIdRaw) : Math.min(2, sectionIdx + 1);
    const commList = Array.isArray(section?.commentaryList) ? section.commentaryList : [];

    commList.forEach((item) => {
      const ballNbr = safeNumber(item?.ballNbr, null);
      if (!ballNbr || ballNbr <= 0) return;

      const txt = parseBallFromText(item?.commText || '');
      let overInt = safeNumber(item?.overNumber, null);
      let ballInOver = safeNumber(item?.ballNbr, null);
      if (txt) {
        overInt = txt.overInt;
        ballInOver = txt.ball;
      }
      if (!Number.isFinite(overInt) || !Number.isFinite(ballInOver) || ballInOver < 1 || ballInOver > 6) return;

      const over = Number((overInt + ballInOver / 10).toFixed(1));
      const scoreText = String(item?.score || '');
      const scoreMatch = scoreText.match(/(\d+)\/(\d+)/);
      const runs = scoreMatch ? Number(scoreMatch[1]) : safeNumber(item?.runs, null);
      const wickets = scoreMatch ? Number(scoreMatch[2]) : safeNumber(item?.wickets, safeNumber(item?.wkts, null));
      if (!Number.isFinite(runs) || !Number.isFinite(wickets)) return;

      out.push({
        innings,
        ball: ballInOver,
        over,
        overLabel: `${overInt}.${ballInOver}`,
        runs,
        wickets,
        timestamp: nowIso,
      });
    });
  });

  if (out.length > 0) return out;

  // Fallback for escaped Next.js payload when object parsing misses fields.
  const escaped = String(html);
  const secRe = /\\"inningsId\\":(\d+),\\"commentaryList\\":\[(.*?)\](?=,\{\\"inningsId\\":|\]\})/gs;
  let sec;
  while ((sec = secRe.exec(escaped)) !== null) {
    const innings = Math.min(2, Math.max(1, Number(sec[1]) || 1));
    const sectionBody = sec[2] || '';
    const itemRe = /\\"ballNbr\\":(\d+).*?\\"overNumber\\":(\d+).*?\\"score\\":\\"(\d+)\/(\d+)\\"/gs;
    let item;
    while ((item = itemRe.exec(sectionBody)) !== null) {
      const ballInOver = Number(item[1]);
      const overInt = Number(item[2]);
      const runs = Number(item[3]);
      const wickets = Number(item[4]);
      if (!Number.isFinite(ballInOver) || !Number.isFinite(overInt) || !Number.isFinite(runs) || !Number.isFinite(wickets)) continue;
      if (ballInOver < 1 || ballInOver > 6) continue;
      out.push({
        innings,
        ball: ballInOver,
        over: Number((overInt + ballInOver / 10).toFixed(1)),
        overLabel: `${overInt}.${ballInOver}`,
        runs,
        wickets,
        timestamp: nowIso,
      });
    }
  }

  return out;
}

/**
 * Expand a single over's ovrSummary string into per-ball cumulative score objects.
 * ovrSummary example: '4 6 0 W 1 1 ' — space-separated tokens.
 * Wides/No-balls ('Wd','Nb') don't count as legal deliveries for over.ball notation.
 */
function expandOvrSummary(overEntry, inningsNum, cumScore, cumWickets) {
  const overNum = (overEntry.overs || 1) - 1; // overs field = 1-indexed over number just completed
  const tokens = String(overEntry.ovrSummary || '').trim().split(/\s+/).filter(t => t !== '');
  const now = new Date().toISOString();
  const balls = [];
  let legalBall = 0;

  for (const tok of tokens) {
    const isWide = tok.startsWith('Wd') || tok.startsWith('wd');
    const isNoBall = tok.startsWith('Nb') || tok.startsWith('nb');
    const isWicket = tok === 'W' || tok === 'w';
    // Runs to add (extras count to cumulative score but not legal ball count)
    let runsAdded = 0;
    if (isWide || isNoBall) {
      runsAdded = 1 + (parseInt(tok.slice(2)) || 0); // Wd, Wd2, Nb, Nb4
      cumScore += runsAdded;
      // Don't increment legalBall or push a plot point for extras
      continue;
    }
    if (isWicket) {
      cumWickets++;
    } else {
      runsAdded = parseInt(tok) || 0;
      cumScore += runsAdded;
    }
    legalBall++;
    balls.push({
      innings: Math.min(2, Math.max(1, inningsNum)),
      ball: legalBall,
      over: parseFloat((overNum + legalBall / 10).toFixed(1)),
      overLabel: `${overNum}.${legalBall}`,
      runs: cumScore,
      wickets: cumWickets,
      timestamp: now,
      _from: 'obo-api',
    });
  }

  // Snap cumulative totals to the authoritative end-of-over values to prevent drift
  return { balls, cumScore: overEntry.score, cumWickets: overEntry.wickets };
}

/**
 * Fetch all overs for a given innings from Cricbuzz's paginated OBO API.
 * Returns an array of over objects sorted ascending by over number.
 */
async function fetchInningsOvers(matchId, inningsId) {
  const BASE = 'https://www.cricbuzz.com';
  const allOvers = [];
  let url = `${BASE}/api/mcenter/over-by-over/${matchId}/${inningsId}`;
  let pages = 0;
  const seen = new Set();

  while (url && pages < 12) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
      const data = res.data;
      const entries = Array.isArray(data.paginatedData) ? data.paginatedData : [];
      for (const e of entries) {
        // Filter to only this innings; paginator sometimes bleeds into prev innings
        if (Number(e.inningsId) !== inningsId) continue;
        const key = `${e.inningsId}-${e.overs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allOvers.push(e);
      }
      url = data.nextPaginationURL ? BASE + data.nextPaginationURL : null;
      pages++;
    } catch (err) {
      console.error(`[scorecard] OBO API page error inn=${inningsId}:`, err.message);
      break;
    }
  }

  // Sort ascending by over number
  allOvers.sort((a, b) => (a.overs || 0) - (b.overs || 0));
  return allOvers;
}

/**
 * Fetch all per-ball data points for both innings using the Cricbuzz OBO pagination API.
 * Returns an array of ball objects with {innings, ball, over, overLabel, runs, wickets, timestamp}.
 */
async function fetchCricbuzzOBOBalls(matchId) {
  const [inn1Overs, inn2Overs] = await Promise.all([
    fetchInningsOvers(matchId, 1),
    fetchInningsOvers(matchId, 2),
  ]);

  console.log(`[scorecard] OBO API: inn1=${inn1Overs.length} overs, inn2=${inn2Overs.length} overs`);

  const allBalls = [];

  let cumScore = 0, cumWickets = 0;
  for (const ov of inn1Overs) {
    const { balls, cumScore: cs, cumWickets: cw } = expandOvrSummary(ov, 1, cumScore, cumWickets);
    allBalls.push(...balls);
    cumScore = cs;
    cumWickets = cw;
  }

  cumScore = 0; cumWickets = 0;
  for (const ov of inn2Overs) {
    const { balls, cumScore: cs, cumWickets: cw } = expandOvrSummary(ov, 2, cumScore, cumWickets);
    allBalls.push(...balls);
    cumScore = cs;
    cumWickets = cw;
  }

  return allBalls;
}

function getNdtvLinkCandidates(html, code1, code2) {
  const out = [];
  const re = /href="([^"]*scorecard-live-cricket-score[^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const lower = href.toLowerCase();
    if (lower.includes(`${code1}-vs-${code2}`) || lower.includes(`${code2}-vs-${code1}`)) {
      out.push(href.startsWith('http') ? href : `https://sports.ndtv.com${href}`);
    }
  }
  return out;
}

function parseNdtvScorePoints(html) {
  const points = [];
  const seen = new Set();
  const re = /(\d{1,3})\/(\d{1,2})\s*\((\d{1,2}\.\d)\/20\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const runs = Number(m[1]);
    const wickets = Number(m[2]);
    const overs = m[3];
    const key = `${runs}-${wickets}-${overs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ runs, wickets, overs });
    if (points.length >= 2) break;
  }
  const now = new Date().toISOString();
  const out = [];
  if (points[0]) {
    out.push({
      innings: 1,
      ball: oversToBall(points[0].overs),
      over: Number(points[0].overs),
      overLabel: points[0].overs,
      runs: points[0].runs,
      wickets: points[0].wickets,
      timestamp: now,
      _from: 'ndtv',
    });
  }
  if (points[1]) {
    out.push({
      innings: 2,
      ball: oversToBall(points[1].overs),
      over: Number(points[1].overs),
      overLabel: points[1].overs,
      runs: points[1].runs,
      wickets: points[1].wickets,
      timestamp: now,
      _from: 'ndtv',
    });
  }
  return out;
}

async function fetchNdtvFallbackPoints(slug, teams) {
  try {
    const code1 = TEAM_CODE_MAP[(teams && teams[0]) || ''] || '';
    const code2 = TEAM_CODE_MAP[(teams && teams[1]) || ''] || '';
    if (!code1 || !code2) {
      console.log('[scorecard] NDTV fallback skipped (missing team codes)');
      return [];
    }

    const listing = await axios.get(NDTV_LIVE_SCORES_URL, { headers: HEADERS, timeout: 15000 });
    const candidates = getNdtvLinkCandidates(listing.data, code1, code2);
    if (!candidates.length) {
      console.log('[scorecard] NDTV fallback no candidate link for', code1, code2);
      return [];
    }

    const scorecard = await axios.get(candidates[0], { headers: HEADERS, timeout: 15000 });
    const parsed = parseNdtvScorePoints(scorecard.data);
    console.log('[scorecard] NDTV parsed points:', parsed.length);
    return parsed;
  } catch (err) {
    console.error('[scorecard] NDTV fallback error:', err.message);
    return [];
  }
}

function validateMonotonicPerInnings(balls) {
  const byInnings = { 1: [], 2: [] };
  balls.forEach((b) => {
    if (b.innings === 1 || b.innings === 2) byInnings[b.innings].push(b);
  });

  for (const inn of [1, 2]) {
    const seq = byInnings[inn].sort((a, b) => a.over - b.over || a.ball - b.ball);
    let prevRuns = -1;
    let prevWkts = -1;
    let prevOver = -1;
    for (const b of seq) {
      if (b.over < prevOver) return false;
      if (b.runs < prevRuns) return false;
      if (b.wickets < prevWkts) return false;
      prevOver = b.over;
      prevRuns = b.runs;
      prevWkts = b.wickets;
    }
  }
  return true;
}

function mergeBalls(stored, scraped) {
  // Merge only within same innings + overLabel to prevent contamination.
  const allBalls = [...stored, ...scraped];
  const uniqueBalls = new Map();

  allBalls.forEach(ball => {
    const key = `${ball.innings}-${ball.overLabel}`;
    if (!uniqueBalls.has(key) || ball.timestamp > uniqueBalls.get(key).timestamp) {
      uniqueBalls.set(key, ball);
    }
  });

  return Array.from(uniqueBalls.values()).sort((a, b) => a.innings - b.innings || a.over - b.over || a.ball - b.ball);
}

async function fetchAndMergeScorecard(matchId, slug) {
  console.log('[scorecard] Processing match:', matchId, slug);
  
  const redisKey = `scorecard_${matchId}`;
  const redisMetaKey = `scorecard_meta_${matchId}`;
  let sourceUsed = 'obo-api';

  // PRIMARY: Cricbuzz paginated OBO API — gives per-ball data for both innings.
  let scraped = [];
  try {
    scraped = await fetchCricbuzzOBOBalls(matchId);
    console.log('[scorecard] OBO API scraped', scraped.length, 'balls');
    if (scraped.length) sourceUsed = 'obo-api';
  } catch (err) {
    console.error('[scorecard] OBO API error:', err.message);
  }

  // FALLBACK: full-commentary HTML parse (in case OBO API is rate-limited/unavailable)
  if (!scraped.length) {
    try {
      const matchUrl = `https://www.cricbuzz.com/live-cricket-full-commentary/${matchId}/${slug}`;
      const res = await axios.get(matchUrl, { headers: HEADERS, timeout: 15000 });
      scraped = parseCommentaryBallsFromHtml(res.data);
      console.log('[scorecard] Commentary fallback scraped', scraped.length, 'balls');
      if (scraped.length) sourceUsed = 'cricbuzz-commentary';
    } catch (err) {
      console.error('[scorecard] Commentary fallback error:', err.message);
    }
  }

  // Get live data for innings assignment
  let venue = null;
  let currentInnings = 1;
  let currentScore = null;
  let matchTeams = [];
  
  try {
    let liveData;
    if (typeof getLiveMatchesData === 'function') {
      liveData = await getLiveMatchesData();
    } else {
      // If it's the handler, we need to call it differently
      const live = require('./live');
      if (typeof live === 'function') {
        liveData = await live();
      } else {
        throw new Error('Unable to access live data function');
      }
    }
    
    const matchData = liveData.matches?.find(m => m.matchId === matchId);
    
    if (matchData) {
      matchTeams = matchData.teams || [];
      venue = matchData.venue;
      
      if (matchData.status === 'live' || matchData.status === 'completed') {
        console.log(`[scorecard] Processing match status: ${matchData.status}`);
        
        // Determine current innings
        if (matchData.innings1 && matchData.innings2) {
          const inn1Overs = parseFloat(matchData.innings1.overs || '0');
          const inn2Overs = parseFloat(matchData.innings2.overs || '0');
          if (matchData.status === 'completed') {
            currentInnings = 2;
            currentScore = matchData.innings2;
            console.log('[scorecard] Completed match, using chase/final innings');
          } else
          
          if (inn1Overs >= 20 && inn2Overs >= 20) {
            currentInnings = 2;
            currentScore = matchData.innings2;
            console.log('[scorecard] Both innings completed');
          } else if (inn1Overs >= 20 && inn2Overs < 20) {
            currentInnings = 2;
            currentScore = matchData.innings2;
            console.log('[scorecard] First complete, second in progress');
          } else if (inn1Overs < 20) {
            currentInnings = 1;
            currentScore = matchData.innings1;
            console.log('[scorecard] First innings in progress');
          }
        } else if (matchData.innings1) {
          currentInnings = 1;
          currentScore = matchData.innings1;
        } else if (matchData.score) {
          currentScore = matchData.score;
          currentInnings = 1;
        }
        
        // Add current live score to scraped data (acts as latest point).
        const shouldAppendLivePoint = scraped.length === 0 || matchData.status === 'live';
        if (shouldAppendLivePoint &&
            currentScore && 
            typeof currentScore.runs === 'number' && 
            typeof currentScore.wickets === 'number' && 
            currentScore.runs >= 0 && 
            currentScore.wickets >= 0 && 
            currentScore.wickets <= 10) {
          
          const oversRaw = parseFloat(currentScore.overs_decimal || currentScore.overs || '0');
          const overNum = Math.floor(oversRaw);
          const ballsStr = (oversRaw - overNum).toFixed(1);
          const ballsDec = parseInt(ballsStr.split('.')[1] || '0');
          const exactOver = parseFloat((overNum + (ballsDec / 10)).toFixed(1));
          
          scraped.push({
            innings: currentInnings,
            ball: 9999, // Temp marker for live data
            over: exactOver,
            overLabel: currentScore.overs_input || currentScore.overs || '0.0',
            runs: currentScore.runs || 0,
            wickets: currentScore.wickets || 0,
            timestamp: new Date().toISOString(),
            _isLiveUpdate: true,
            _matchStatus: matchData.status
          });
          
          console.log(`[scorecard] Added live data: innings=${currentInnings}, score=${currentScore.runs}/${currentScore.wickets}, overs=${exactOver}`);
        }
      }
    }
  } catch (err) {
    console.error('[scorecard] Error getting live data:', err.message);
  }

  // NDTV fallback when Cricbuzz data is absent/coarse.
  if (scraped.length < 12) {
    try {
      const ndtvPoints = await fetchNdtvFallbackPoints(slug, matchTeams);
      if (ndtvPoints.length) {
        scraped = [...scraped, ...ndtvPoints];
        sourceUsed = 'ndtv-fallback';
        console.log('[scorecard] Added', ndtvPoints.length, 'NDTV points');
      }
    } catch (err) {
      console.error('[scorecard] NDTV enrichment failed:', err.message);
    }
  }

  // Merge with stored data
  const stored = (await redisGet(redisKey)) || [];
  const priorMeta = (await redisGet(redisMetaKey)) || [];
  if (Array.isArray(priorMeta) && priorMeta.length) {
    const m = priorMeta[0] || {};
    if (m.matchId && String(m.matchId) !== String(matchId)) {
      throw new Error(`Redis key mismatch for ${redisKey}`);
    }
  }
  const merged = mergeBalls(stored, scraped);
  
  // Validate ball data
  const validBalls = merged.filter(b => 
    typeof b.runs === 'number' && b.runs >= 0 &&
    typeof b.wickets === 'number' && b.wickets >= 0 && b.wickets <= 10 &&
    typeof b.over === 'number' && b.over >= 0 && b.over <= 20.6 &&
    (b.innings === 1 || b.innings === 2)
  );
  
  console.log(`[scorecard] Validation: ${validBalls.length} valid balls, ${merged.length - validBalls.length} invalid balls`);
  // Soft monotonic check: drop non-monotonic balls rather than throwing.
  // This handles stale live-update points that may disagree with OBO data.
  const monotoneBalls = [];
  const prevPerInnings = {};
  for (const b of validBalls.sort((a, z) => a.innings - z.innings || a.over - z.over || a.ball - z.ball)) {
    const prev = prevPerInnings[b.innings];
    if (prev && (b.runs < prev.runs || b.wickets < prev.wickets || b.over < prev.over)) {
      console.warn(`[scorecard] Dropping non-monotonic ball at inn=${b.innings} over=${b.over} runs=${b.runs} (prev runs=${prev.runs})`);
      continue;
    }
    prevPerInnings[b.innings] = b;
    monotoneBalls.push(b);
  }
  console.log(`[scorecard] After monotone filter: ${monotoneBalls.length} balls`);
  
  // Store validated data
  if (monotoneBalls.length > 0) {
    const dataToStore = monotoneBalls.map(b => ({
      ...b,
      _validated: true,
      _validationTime: new Date().toISOString()
    }));
    
    await redisSet(redisKey, dataToStore);
    console.log(`[scorecard] Stored ${dataToStore.length} validated balls to Redis`);
    await redisSet(redisMetaKey, [{
      matchId: String(matchId),
      slug: String(slug || ''),
      teams: [],
      updatedAt: new Date().toISOString(),
      source: sourceUsed,
    }]);
  }

  return monotoneBalls;
}

// API Handler
module.exports = async function handler(req, res) {
  const matchId = req.query.matchId;
  const slug = req.query.slug;
  const teams = req.query.teams ? JSON.parse(req.query.teams) : [];

  if (!matchId || !slug) {
    return res.status(400).json({ error: 'matchId and slug are required' });
  }

  try {
    const balls = await fetchAndMergeScorecard(matchId, slug);
    
    return res.status(200).json({
      matchId,
      slug,
      teams,
      balls: balls,
      count: balls.length,
      venue: null // Could be added from live data if needed
    });
  } catch (error) {
    console.error('[scorecard] API error:', error);
    return res.status(500).json({ error: error.message, balls: [] });
  }
};

// Export functions for use in other modules
module.exports.fetchAndMergeScorecard = fetchAndMergeScorecard;
module.exports.redisGet = redisGet;
module.exports.redisSet = redisSet;
